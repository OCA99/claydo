/**
 * claydo/migrate — move existing Durable Object bindings into kinds.
 *
 * There is no platform-level way to merge Durable Object namespaces, so a
 * migration is an application-level data copy plus a routing cutover:
 *
 * 1. Wrap the OLD class with {@link exportable} and deploy the old Worker.
 * 2. Enable imports on the host: `union(kinds, { importable: [...] })`.
 * 3. Move instances with {@link migrateInstance} (bulk driver), or route
 *    through {@link migrated} with the `lazy` strategy to move instances on
 *    first touch.
 * 4. When the old namespace is empty, delete its class with a
 *    `deleted_classes` migration. That reclaims the namespace slot.
 *
 * Ordering guarantees: the target is reserved first (traffic blocks, so
 * racing requests cannot pollute it), then the old instance is sealed
 * (writes freeze), data streams in verified chunks, the kind pins only
 * after the final chunk, and the old instance records where it moved only
 * after success. Exactly one driver owns a migration at a time; a crashed
 * driver's import goes stale and the next run adopts it. On failure, the
 * partial target facets are discarded; an old instance sealed by that run
 * is unsealed, while a pre-existing seal is left unchanged.
 */

import type { KindAccessor, KindStub } from "./client";
import { RESERVED_LIFECYCLE_METHODS } from "./types";
import {
  IMPORT_STALE_MS,
  IMPORT_CHECKPOINT_KEY,
  RESERVED_STORAGE_KEYS,
  SEAL_KEY,
  SEALED_HEADER,
  quoteIdent,
  sizeOf,
  type ExportChunk,
  type ExportCursor,
  type ImportAck,
  type ImportBegin,
  type ImportLimits,
  type ImportStatus,
  type SqlValue,
} from "./migrate-wire";

export type {
  ExportChunk,
  ExportCursor,
  ImportAck,
  ImportBegin,
  ImportLimits,
  ImportStatus,
} from "./migrate-wire";
export { SEALED_HEADER } from "./migrate-wire";

const KV_BATCH = 128; // storage.put() accepts at most 128 keys.
const DEFAULT_MAX_ROWS = 500;
const DEFAULT_MAX_BYTES = 256 * 1024;
const ROWID_FLOOR = -Number.MAX_SAFE_INTEGER;
const SEALED_ALARM_DEFER_MS = 60_000;
const RESERVED_EXPORT_METHODS = new Set<string>(RESERVED_LIFECYCLE_METHODS);

interface SealRecord {
  /** Immutable destination claim while copying. */
  target?: string;
  /** Destination after the target is live. */
  movedTo?: string;
  at: number;
}

/**
 * Per-instance migration state, held off the instance so the wrapper never
 * needs private fields (framework base classes call their own methods from
 * inside `super()`, before a subclass private field would exist) and never
 * reshapes the prototype chain (framework base classes inspect it).
 */
interface SealHolder {
  sealed: SealRecord | null;
  /** The real, unguarded state. The library's own operations use it. */
  ctx: DurableObjectState;
  inspection?: TableInspection;
}

const holders = new WeakMap<object, SealHolder>();

function holderOf(instance: object): SealHolder {
  const holder = holders.get(instance);
  if (holder === undefined) {
    throw new Error(
      "claydo: exportable() state missing. Construct instances only " +
        "through the wrapped class.",
    );
  }
  return holder;
}

/**
 * Wraps `ctx.storage` (and `ctx.storage.sql`) so every storage access
 * fails while the instance is sealed — however the wrapped class captured
 * the reference. Guarding effects instead of rewriting methods keeps the
 * class's prototype chain untouched, which framework base classes (Agents
 * SDK, PartyServer) inspect and depend on. The guard is synchronous:
 * unsealed instances behave exactly as before, including sync return
 * values and self-calls.
 */
function guardObject<T extends object>(real: T, holder: SealHolder): T {
  return new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const seal = holder.sealed;
        if (seal) throw sealedError(holder.ctx, seal);
        return Reflect.apply(value, target, args);
      };
    },
  }) as T;
}

function guardState(holder: SealHolder): DurableObjectState {
  const real = holder.ctx;
  const storage = new Proxy(real.storage, {
    get(target, prop) {
      if (prop === "sql") return sql;
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const seal = holder.sealed;
        if (seal) throw sealedError(holder.ctx, seal);
        return Reflect.apply(value, target, args);
      };
    },
  }) as DurableObjectStorage;
  const sql = guardObject(real.storage.sql, holder);
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "storage") return storage;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DurableObjectState;
}

type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

/** Finds a prototype method of the wrapped class (or its ancestors). */
function protoMethod(proto: object, name: string): AnyMethod | undefined {
  let current: object | null = proto;
  while (current !== null && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor && typeof descriptor.value === "function") {
      return descriptor.value as AnyMethod;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

interface ExportLimits {
  maxRows?: number;
  maxBytes?: number;
}

/** What {@link previewInstance} reports, without sealing anything. */
export interface MigrationPreview {
  sealed: boolean;
  /**
   * Where the instance moved, when the migration already completed — the
   * target's `<kind>:<name>` reference, usable with
   * `kinds(ns).<kind>.get(name)`.
   */
  movedTo?: string;
  /** True when the instance holds any rows or KV entries. */
  hasData: boolean;
  kv: number;
  rows: Record<string, number>;
  /** The pending alarm timestamp, or null. */
  alarm: number | null;
  /** Problems that would make `migrateInstance` fail on this instance. */
  blockers: string[];
}

/** The methods that {@link exportable} adds to the old class. */
export interface ExportableInstance {
  /**
   * Freezes the instance: every storage access fails until unseal,
   * `fetch()` answers 410 with the `x-claydo-sealed` header, alarms are
   * preserved but deferred, and open hibernatable WebSockets close with
   * code 1012 so clients reconnect.
   */
  __claydoSeal(
    secret?: string,
    movedTo?: string,
    target?: string,
  ): Promise<void>;
  /** Reverses a seal, for migration rollback. */
  __claydoUnseal(secret?: string): Promise<void>;
  /** Reports the seal state. */
  __claydoSealed(
    secret?: string,
  ): Promise<{ sealed: boolean; movedTo?: string; target?: string }>;
  /** True when the instance has any user data (table rows or KV entries). */
  __claydoHasData(secret?: string): Promise<boolean>;
  /** Reports sizes, alarm, seal state, and blockers. Never seals. */
  __claydoStats(secret?: string): Promise<MigrationPreview>;
  /** Returns the next export chunk. The instance must be sealed. */
  __claydoExport(
    secret: string | undefined,
    cursor: ExportCursor | null,
    limits?: ExportLimits,
  ): Promise<ExportChunk>;
}

/** Options for {@link exportable}. */
export interface ExportableOptions {
  /**
   * When set, every `__claydo*` method requires this secret. Use it when the
   * migration driver runs in a different Worker than the old class.
   */
  secret?: string;
  /**
   * Additional inherited methods to guard at entry while sealed. Direct
   * methods on `Base.prototype` are guarded automatically. Use this when a
   * finished class intentionally exposes inherited business RPC methods
   * that captured the raw constructor storage reference.
   */
  guardMethods?: string[];
}

type DurableObjectLike = { ctx: DurableObjectState; env: unknown };

/** The class type that {@link exportable} returns. */
export interface ExportableClass<I> {
  new (...args: any[]): I & ExportableInstance;
}

/** A table whose rows stream chunk by chunk. */
interface TableMeta {
  name: string;
  ddl: string;
  rowidAlias: string | null;
  /** Visible, non-generated columns, in declaration order. */
  columns: string[];
}

interface TableInspection {
  tables: TableMeta[];
  /** DDL replayed on the target after all rows (external-content FTS5). */
  post: string[];
  /** Problems that make the instance non-exportable as-is. */
  blockers: string[];
}

/**
 * Wraps a finished Durable Object class so its instances can be exported
 * into a claydo kind. Deploy this wrapper on the OLD Worker; behavior is
 * unchanged until an instance is sealed.
 *
 * The wrapper does not touch the class's methods or prototype chain (so
 * framework base classes such as PartyServer `Server` or the Agents SDK
 * `Agent` keep working). Instead it wraps `ctx.storage`: while sealed,
 * every storage read and write fails, `fetch()` answers 410, alarms defer,
 * and WebSocket handlers go quiet. The guards are synchronous, so internal
 * self-calls (`this.method()`) and sync helpers keep working while
 * unsealed.
 *
 * @example
 * class TallyImpl extends DurableObject<Env> { ... }
 * export class Tally extends exportable(TallyImpl) {}
 */
export function exportable<I extends object>(
  Base: abstract new (...args: any[]) => I,
  options: ExportableOptions = {},
): ExportableClass<I> {
  // The runtime does not care that TypeScript declares DurableObject
  // abstract; extending it through a concrete alias keeps mixins legal.
  const ConcreteBase = Base as unknown as new (
    ...args: any[]
  ) => DurableObjectLike;

  const baseFetch = protoMethod(ConcreteBase.prototype, "fetch");
  const baseAlarm = protoMethod(ConcreteBase.prototype, "alarm");
  const baseWsMessage = protoMethod(ConcreteBase.prototype, "webSocketMessage");
  const baseWsClose = protoMethod(ConcreteBase.prototype, "webSocketClose");
  const baseWsError = protoMethod(ConcreteBase.prototype, "webSocketError");

  class Exportable extends ConcreteBase {
    constructor(...args: any[]) {
      // The runtime brand-checks the state argument, so the real one must
      // travel through the constructor chain untouched.
      super(...args);
      const realCtx = args[0] as DurableObjectState;
      const holder: SealHolder = { sealed: null, ctx: realCtx };
      holders.set(this, holder);
      // Shadow `this.ctx` with the guarded state, so every storage access
      // after construction honors the seal. (References captured inside
      // the wrapped constructor itself still reach the real storage; the
      // entry-point guards below cover those paths.)
      Object.defineProperty(this, "ctx", {
        value: guardState(holder),
        writable: true,
        configurable: true,
      });
      // Load the seal state before any event is delivered, so the guards
      // stay synchronous and fully transparent while unsealed.
      realCtx.blockConcurrencyWhile(async () => {
        holder.sealed =
          (await realCtx.storage.get<SealRecord>(SEAL_KEY)) ?? null;
      });
    }

    fetch(request: Request): Response | Promise<Response> {
      if (holders.get(this)?.sealed) {
        return new Response(
          "claydo: this instance is sealed (migrating or migrated). " +
            "Reconnect through the current endpoint.",
          { status: 410, headers: { [SEALED_HEADER]: "1" } },
        );
      }
      if (baseFetch === undefined) {
        return new Response(
          `claydo: ${ConcreteBase.name} does not implement fetch().`,
          { status: 501 },
        );
      }
      return baseFetch.apply(this, [request]) as Response | Promise<Response>;
    }

    alarm(...args: unknown[]): unknown {
      const holder = holders.get(this);
      const seal = holder?.sealed;
      if (holder !== undefined && seal) {
        if (seal.movedTo !== undefined) {
          // The migration completed; the alarm moved with the data.
          return holder.ctx.storage.deleteAlarm();
        }
        // Preserve the alarm through the sealed window: defer it so the
        // export can still capture and transfer it.
        console.warn(
          `claydo: alarm deferred on sealed instance '${identityOf(holder.ctx)}' (migration in progress).`,
        );
        return holder.ctx.storage.setAlarm(
          Date.now() + SEALED_ALARM_DEFER_MS,
        );
      }
      return baseAlarm?.apply(this, args);
    }

    webSocketMessage(...args: unknown[]): unknown {
      // Sealing closed this instance's sockets; drop racing messages.
      if (holders.get(this)?.sealed) return;
      return baseWsMessage?.apply(this, args);
    }

    webSocketClose(...args: unknown[]): unknown {
      // Sealing closes the instance's own sockets, which fires this
      // handler; running user code (or throwing) here is only noise.
      if (holders.get(this)?.sealed) return;
      return baseWsClose?.apply(this, args);
    }

    webSocketError(...args: unknown[]): unknown {
      if (holders.get(this)?.sealed) return;
      return baseWsError?.apply(this, args);
    }

    #auth(secret: string | undefined): void {
      if (options.secret !== undefined && secret !== options.secret) {
        throw new Error(
          "claydo: invalid migration secret (rejected by the old " +
            "instance's exportable() wrapper). The same secret must be " +
            "set on exportable(), on union(), and in the driver options.",
        );
      }
    }

    async __claydoSeal(
      secret?: string,
      movedTo?: string,
      target?: string,
    ): Promise<void> {
      this.#auth(secret);
      const holder = holderOf(this);
      const existing = holder.sealed;
      const existingTarget = existing?.movedTo ?? existing?.target;
      const requestedTarget = target ?? movedTo;
      if (
        existingTarget !== undefined &&
        requestedTarget !== undefined &&
        existingTarget !== requestedTarget
      ) {
        throw new Error(
          `claydo: old instance '${identityOf(holder.ctx)}' is already ` +
            `claimed by target '${existingTarget}'; cannot also migrate it ` +
            `to '${requestedTarget}'.`,
        );
      }
      const record: SealRecord = {
        target: existingTarget ?? requestedTarget,
        movedTo: movedTo ?? existing?.movedTo,
        at: existing?.at ?? Date.now(),
      };
      await holder.ctx.storage.put(SEAL_KEY, record);
      holder.sealed = record;
      if (existing === null) {
        // Close hibernatable WebSockets so clients get a real close event
        // (1012: service restart) and reconnect through the router.
        for (const ws of holder.ctx.getWebSockets()) {
          try {
            ws.close(1012, "claydo: instance migrating; reconnect");
          } catch {
            // Already closed.
          }
        }
      }
      if (record.movedTo !== undefined) {
        // The data (including the alarm) lives in the new instance now.
        await holder.ctx.storage.deleteAlarm();
      }
    }

    async __claydoUnseal(secret?: string): Promise<void> {
      this.#auth(secret);
      const holder = holderOf(this);
      await holder.ctx.storage.delete(SEAL_KEY);
      holder.sealed = null;
      holder.inspection = undefined;
    }

    async __claydoSealed(
      secret?: string,
    ): Promise<{ sealed: boolean; movedTo?: string; target?: string }> {
      this.#auth(secret);
      const holder = holderOf(this);
      return {
        sealed: holder.sealed !== null,
        movedTo: holder.sealed?.movedTo,
        target:
          holder.sealed?.movedTo === undefined
            ? holder.sealed?.target
            : undefined,
      };
    }

    async __claydoHasData(secret?: string): Promise<boolean> {
      this.#auth(secret);
      const { ctx } = holderOf(this);
      // Schema alone does not count: constructors commonly run
      // `CREATE TABLE IF NOT EXISTS`. Only rows and KV entries count.
      //
      // This probe must NEVER fail on blocker tables (WITHOUT ROWID,
      // virtual modules): routing (`migrated()`) and dry runs rely on it,
      // and an instance the exporter cannot move must keep serving from
      // the old side. Blockers are enforced by export/migrate only —
      // here, rows in a blocker table simply count as data.
      const all = ctx.storage.sql
        .exec<{ name: string; sql: string }>(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'table' AND sql IS NOT NULL
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
           ORDER BY name`,
        )
        .toArray();
      const shadows = this.#shadowTables(all);
      for (const row of all) {
        if (shadows.has(row.name)) continue;
        try {
          const probe = ctx.storage.sql
            .exec(`SELECT 1 FROM ${quoteIdent(row.name)} LIMIT 1`)
            .toArray();
          if (probe.length > 0) return true;
        } catch {
          // A table that cannot even be probed (for example contentless
          // FTS5) is treated as data, so the old side stays authoritative.
          return true;
        }
      }
      let after: string | undefined;
      for (;;) {
        const listed = await ctx.storage.list({
          startAfter: after,
          limit: KV_BATCH,
        });
        if (listed.size === 0) return false;
        for (const key of listed.keys()) {
          after = key;
          if (!RESERVED_STORAGE_KEYS.has(key)) return true;
        }
        if (listed.size < KV_BATCH) return false;
      }
    }

    async __claydoStats(secret?: string): Promise<MigrationPreview> {
      this.#auth(secret);
      const holder = holderOf(this);
      const inspection = this.#inspectTables();
      const blockers = [...inspection.blockers];
      if (
        (await holder.ctx.storage.get(IMPORT_CHECKPOINT_KEY)) !== undefined
      ) {
        blockers.push(
          `KV key '${IMPORT_CHECKPOINT_KEY}' is reserved for target staging. ` +
            `Rename it before migrating.`,
        );
      }
      const rows: Record<string, number> = {};
      for (const table of inspection.tables) {
        rows[table.name] = holder.ctx.storage.sql
          .exec<{ n: number }>(
            `SELECT count(*) AS n FROM ${quoteIdent(table.name)}`,
          )
          .one().n;
      }
      const kv = await this.#kvCount();
      return {
        sealed: holder.sealed !== null,
        movedTo: holder.sealed?.movedTo,
        // The conservative probe, so rows in blocker tables count too.
        hasData: await this.__claydoHasData(secret),
        kv,
        rows,
        alarm: await holder.ctx.storage.getAlarm(),
        blockers,
      };
    }

    async __claydoExport(
      secret: string | undefined,
      cursor: ExportCursor | null,
      limits: ExportLimits = {},
    ): Promise<ExportChunk> {
      this.#auth(secret);
      const holder = holderOf(this);
      if (holder.sealed === null) {
        throw new Error(
          `claydo: instance '${identityOf(holder.ctx)}' is not sealed. Seal it ` +
            `with __claydoSeal() before exporting, so the data cannot ` +
            `change during the copy.`,
        );
      }
      const maxRows = limits.maxRows ?? DEFAULT_MAX_ROWS;
      const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
      const inspection = this.#userTables();
      const tables = inspection.tables;
      const chunk: ExportChunk = { cursor: null };

      if (cursor === null) {
        chunk.tables = tables.map(({ name, ddl }) => ({ name, ddl }));
        cursor = { phase: "kv", afterKey: "" };
      }

      if (cursor.phase === "kv") {
        const page = await this.#kvPage(cursor.afterKey, maxBytes);
        if (page !== null) {
          chunk.kv = page.entries;
          chunk.cursor = { phase: "kv", afterKey: page.afterKey };
          return chunk;
        }
        cursor = { phase: "rows", tableIndex: 0, afterRowid: ROWID_FLOOR };
      }

      let { tableIndex, afterRowid } = cursor;
      while (tableIndex < tables.length) {
        const table = tables[tableIndex]!;
        const page = this.#rowPage(table, afterRowid, maxRows, maxBytes);
        if (page.values.length > 0) {
          chunk.rows = {
            table: table.name,
            columns: page.columns,
            values: page.values,
            rowid: table.rowidAlias ?? "__rowid__",
          };
          chunk.cursor = {
            phase: "rows",
            tableIndex,
            afterRowid: page.lastRowid,
          };
          return chunk;
        }
        tableIndex += 1;
        afterRowid = ROWID_FLOOR;
      }

      // Final chunk.
      chunk.post = [...this.#postDdl(), ...inspection.post];
      chunk.sequences = this.#sequences();
      chunk.alarm = await holder.ctx.storage.getAlarm();
      chunk.totals = {
        kv: await this.#kvCount(),
        rows: Object.fromEntries(
          tables.map((t) => [
            t.name,
            holder.ctx.storage.sql
              .exec<{ n: number }>(
                `SELECT count(*) AS n FROM ${quoteIdent(t.name)}`,
              )
              .one().n,
          ]),
        ),
      };
      chunk.cursor = null;
      return chunk;
    }

    /** Like {@link #inspectTables}, but blockers throw. */
    #userTables(): TableInspection {
      const inspection = this.#inspectTables();
      if (inspection.blockers.length > 0) {
        throw new Error(`claydo: ${inspection.blockers.join(" Also: ")}`);
      }
      return inspection;
    }

    #inspectTables(): TableInspection {
      const holder = holderOf(this);
      if (holder.sealed !== null && holder.inspection !== undefined) {
        return holder.inspection;
      }
      const { ctx } = holder;
      const sql = ctx.storage.sql;
      const all = sql
        .exec<{ name: string; sql: string }>(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'table' AND sql IS NOT NULL
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
           ORDER BY name`,
        )
        .toArray();
      const shadows = this.#shadowTables(all);
      const tables: TableMeta[] = [];
      const post: string[] = [];
      const blockers: string[] = [];
      for (const row of all) {
        if (shadows.has(row.name)) continue;
        if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql)) {
          if (!/USING\s+fts5\b/i.test(row.sql)) {
            blockers.push(
              `table '${row.name}' is a virtual table (module other than ` +
                `FTS5), which the exporter does not support. Drop it ` +
                `before migrating or copy it with custom code.`,
            );
            continue;
          }
          const content = /content\s*=\s*(?:'([^']*)'|"([^"]*)"|([^,\s)'"]+))/i.exec(
            row.sql,
          );
          const contentValue = content
            ? (content[1] ?? content[2] ?? content[3])
            : undefined;
          if (contentValue === "") {
            blockers.push(
              `table '${row.name}' is a contentless FTS5 table ` +
                `(content=''), whose text cannot be read back. Drop it ` +
                `before migrating or copy it with custom code.`,
            );
            continue;
          }
          if (contentValue !== undefined) {
            // External content: recreate the index on the target after the
            // content table's rows arrive, then rebuild it.
            post.push(
              row.sql,
              `INSERT INTO ${quoteIdent(row.name)}(${quoteIdent(row.name)}) VALUES('rebuild')`,
            );
            continue;
          }
          // Self-contained FTS5: rows read and insert like a table's, and
          // inserting rebuilds the index on the target as it goes.
          const columns = sql
            .exec<{ name: string }>(
              `PRAGMA table_info(${quoteIdent(row.name)})`,
            )
            .toArray()
            .map((column) => column.name);
          const unsafeRange = this.#unsafeRowidRange(row.name);
          if (unsafeRange !== undefined) {
            blockers.push(unsafeRange);
            continue;
          }
          tables.push({
            name: row.name,
            ddl: row.sql,
            rowidAlias: null,
            columns,
          });
          continue;
        }
        if (/WITHOUT\s+ROWID/i.test(row.sql)) {
          blockers.push(
            `table '${row.name}' is WITHOUT ROWID, which the exporter ` +
              `does not support yet. Copy this table with custom code, or ` +
              `recreate it with a rowid.`,
          );
          continue;
        }
        const info = sql
          .exec<{ name: string; type: string; pk: number; hidden: number }>(
            `PRAGMA table_xinfo(${quoteIdent(row.name)})`,
          )
          .toArray();
        // hidden 2 and 3 are generated columns: they recompute on insert,
        // so they are excluded from the copy instead of breaking it.
        const visible = info.filter((column) => column.hidden === 0);
        const pks = visible.filter((column) => column.pk > 0);
        const rowidAlias =
          pks.length === 1 && pks[0]!.type.toUpperCase() === "INTEGER"
            ? pks[0]!.name
            : null;
        for (const column of visible) {
          const lower = column.name.toLowerCase();
          if (
            (lower === "rowid" ||
              lower === "_rowid_" ||
              lower === "oid" ||
              column.name === "__rowid__") &&
            column.name !== rowidAlias
          ) {
            blockers.push(
              `table '${row.name}' has a column named '${column.name}', ` +
                `which shadows the rowid the exporter pages by. Rename ` +
                `the column before migrating.`,
            );
          }
        }
        const namedRowid = visible.find(
          (column) => column.name.toLowerCase() === "rowid",
        );
        // `rowid INTEGER PRIMARY KEY` is a legal alias and still needs the
        // precision check. A non-alias column named rowid is already a
        // shadowing blocker above; querying `rowid` there would read text
        // user data rather than SQLite's hidden integer.
        if (namedRowid === undefined || namedRowid.name === rowidAlias) {
          const unsafeRange = this.#unsafeRowidRange(row.name);
          if (unsafeRange !== undefined) blockers.push(unsafeRange);
        }
        tables.push({
          name: row.name,
          ddl: row.sql,
          rowidAlias,
          columns: visible.map((column) => column.name),
        });
      }
      const inspection = { tables, post, blockers };
      if (holder.sealed !== null) holder.inspection = inspection;
      return inspection;
    }

    #unsafeRowidRange(table: string): string | undefined {
      const { ctx } = holderOf(this);
      const range = ctx.storage.sql
        .exec<{ minRowid: string | null; maxRowid: string | null }>(
          `SELECT CAST(min(rowid) AS TEXT) AS minRowid,
                  CAST(max(rowid) AS TEXT) AS maxRowid
           FROM ${quoteIdent(table)}`,
        )
        .one();
      if (range.minRowid === null || range.maxRowid === null) return undefined;
      const floor = BigInt(-Number.MAX_SAFE_INTEGER);
      const ceiling = BigInt(Number.MAX_SAFE_INTEGER);
      if (
        BigInt(range.minRowid) <= floor ||
        BigInt(range.maxRowid) > ceiling
      ) {
        return (
          `table '${table}' has rowids outside the exportable safe integer ` +
          `range (${range.minRowid}..${range.maxRowid}). Re-key those rows ` +
          `before migrating; unsafe 64-bit rowids cannot be copied exactly.`
        );
      }
      return undefined;
    }

    /** Names of shadow tables (FTS5 internals) that must not be copied. */
    #shadowTables(all: { name: string; sql: string }[]): Set<string> {
      const { ctx } = holderOf(this);
      try {
        return new Set(
          ctx.storage.sql
            .exec<{ name: string }>(
              `SELECT name FROM pragma_table_list WHERE type = 'shadow'`,
            )
            .toArray()
            .map((row) => row.name),
        );
      } catch {
        // Fallback for runtimes without pragma_table_list: the FTS5 shadow
        // table names are fixed.
        const set = new Set<string>();
        for (const row of all) {
          if (
            /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql) &&
            /USING\s+fts5\b/i.test(row.sql)
          ) {
            for (const suffix of [
              "config",
              "content",
              "data",
              "docsize",
              "idx",
            ]) {
              set.add(`${row.name}_${suffix}`);
            }
          }
        }
        return set;
      }
    }

    #rowPage(
      table: TableMeta,
      afterRowid: number,
      maxRows: number,
      maxBytes: number,
    ): { columns: string[]; values: SqlValue[][]; lastRowid: number } {
      const { ctx } = holderOf(this);
      const cols = table.columns.map(quoteIdent).join(", ");
      const select =
        table.rowidAlias === null
          ? `SELECT rowid AS __rowid__, ${cols} FROM ${quoteIdent(table.name)}
             WHERE rowid > ? ORDER BY rowid LIMIT ?`
          : `SELECT ${cols} FROM ${quoteIdent(table.name)}
             WHERE rowid > ? ORDER BY rowid LIMIT ?`;
      const query = ctx.storage.sql.exec(select, afterRowid, maxRows);
      const columns = query.columnNames;
      const rowidIndex =
        table.rowidAlias === null ? 0 : columns.indexOf(table.rowidAlias);
      const values: SqlValue[][] = [];
      let lastRowid = afterRowid;
      let bytes = 0;
      for (const row of query.raw()) {
        values.push(row as SqlValue[]);
        lastRowid = row[rowidIndex] as number;
        for (const value of row) bytes += sizeOf(value);
        if (bytes >= maxBytes) break;
      }
      return { columns, values, lastRowid };
    }

    async #kvPage(
      afterKey: string,
      maxBytes: number,
    ): Promise<{ entries: [string, unknown][]; afterKey: string } | null> {
      const { ctx } = holderOf(this);
      let after = afterKey === "" ? undefined : afterKey;
      for (;;) {
        const listed = await ctx.storage.list({
          startAfter: after,
          limit: KV_BATCH,
        });
        if (listed.size === 0) return null;
        const entries: [string, unknown][] = [];
        let bytes = 0;
        for (const [key, value] of listed) {
          after = key;
          if (RESERVED_STORAGE_KEYS.has(key)) continue;
          entries.push([key, value]);
          bytes += key.length * 2 + sizeOf(value);
          if (entries.length >= KV_BATCH || bytes >= maxBytes) break;
        }
        if (entries.length > 0) return { entries, afterKey: after! };
        if (listed.size < KV_BATCH) return null;
      }
    }

    async #kvCount(): Promise<number> {
      const { ctx } = holderOf(this);
      let count = 0;
      let after: string | undefined;
      for (;;) {
        const listed = await ctx.storage.list({
          startAfter: after,
          limit: KV_BATCH,
        });
        if (listed.size === 0) return count;
        for (const key of listed.keys()) {
          after = key;
          if (!RESERVED_STORAGE_KEYS.has(key)) count += 1;
        }
        if (listed.size < KV_BATCH) return count;
      }
    }

    #postDdl(): string[] {
      const { ctx } = holderOf(this);
      return ctx.storage.sql
        .exec<{ sql: string }>(
          `SELECT sql FROM sqlite_master
           WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             AND tbl_name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
           ORDER BY rowid`,
        )
        .toArray()
        .map((row) => row.sql);
    }

    #sequences(): [string, number][] {
      const { ctx } = holderOf(this);
      try {
        return ctx.storage.sql
          .exec<{ name: string; seq: number }>(
            `SELECT name, seq FROM sqlite_sequence`,
          )
          .toArray()
          .map((row) => [row.name, row.seq]);
      } catch {
        return [];
      }
    }
  }

  // Guard the finished class's own RPC methods at entry, in addition to the
  // storage proxy. This closes the constructor-captured-storage escape hatch:
  // a method cannot run while sealed even if it saved the raw `ctx.storage`
  // reference before exportable() installed its proxy. Only direct methods
  // are shadowed, so framework ancestor prototypes keep the shape their
  // override detection expects. During `super()` the holder does not exist
  // yet, so constructor self-calls remain transparent.
  const guardedNames = new Set([
    ...Object.getOwnPropertyNames(ConcreteBase.prototype),
    ...(options.guardMethods ?? []),
  ]);
  for (const name of guardedNames) {
    if (RESERVED_EXPORT_METHODS.has(name) || name.startsWith("__claydo")) {
      continue;
    }
    let owner: object | null = ConcreteBase.prototype;
    let descriptor: PropertyDescriptor | undefined;
    while (owner !== null && owner !== Object.prototype) {
      descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor !== undefined) break;
      owner = Object.getPrototypeOf(owner);
    }
    if (descriptor === undefined || typeof descriptor.value !== "function") {
      if (options.guardMethods?.includes(name) === true) {
        throw new Error(
          `claydo: exportable() guardMethods includes '${name}', but no ` +
            `prototype method with that name exists on ${ConcreteBase.name}.`,
        );
      }
      continue;
    }
    const original = descriptor.value as (
      this: object,
      ...args: unknown[]
    ) => unknown;
    Object.defineProperty(Exportable.prototype, name, {
      ...descriptor,
      value: function (this: object, ...args: unknown[]): unknown {
        const holder = holders.get(this);
        if (holder?.sealed) {
          throw sealedError(holder.ctx, holder.sealed);
        }
        return original.apply(this, args);
      },
    });
  }

  return Exportable as unknown as ExportableClass<I>;
}

function identityOf(ctx: DurableObjectState): string {
  return ctx.id.name ?? ctx.id.toString();
}

function sealMessage(ctx: DurableObjectState, seal: SealRecord): string {
  const moved =
    seal.movedTo === undefined
      ? " A migration is in progress."
      : ` It moved to '${seal.movedTo}'; route traffic through the claydo binding.`;
  return `claydo: instance '${identityOf(ctx)}' is sealed.${moved}`;
}

function sealedError(ctx: DurableObjectState, seal: SealRecord): Error {
  return Object.assign(new Error(sealMessage(ctx, seal)), {
    code: "CLAYDO_SEALED",
  });
}

/** The host-side migration surface, reachable on a raw claydo stub. */
interface MigrationHostStub {
  __claydoImportStatus(secret?: string): Promise<ImportStatus>;
  __claydoBeginImport(
    kind: string,
    token: string,
    secret?: string,
    limits?: ImportLimits,
  ): Promise<ImportBegin>;
  __claydoImport(
    kind: string,
    chunk: ExportChunk,
    seq: number,
    token: string,
    secret?: string,
  ): Promise<ImportAck>;
  __claydoAbortImport(token: string, secret?: string): Promise<boolean>;
  __claydoReset(confirmId: string, secret?: string): Promise<void>;
  __claydoKind(): Promise<string | undefined>;
}

type ExportableStub = {
  [K in keyof ExportableInstance]: ExportableInstance[K];
};

/**
 * The surface {@link migrateInstance} needs on the old stub. Any
 * `DurableObjectStub` of a class wrapped with {@link exportable} satisfies
 * it structurally.
 */
export interface ExportableOldStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  __claydoSeal(
    secret?: string,
    movedTo?: string,
    target?: string,
  ): Promise<void>;
  __claydoUnseal(secret?: string): Promise<void>;
  __claydoSealed(
    secret?: string,
  ): Promise<{ sealed: boolean; movedTo?: string; target?: string }>;
  __claydoHasData(secret?: string): Promise<boolean>;
  __claydoStats(secret?: string): Promise<MigrationPreview>;
  __claydoExport(
    secret: string | undefined,
    cursor: ExportCursor | null,
    limits?: ExportLimits,
  ): Promise<ExportChunk>;
}

/**
 * Progress of one running {@link migrateInstance} call.
 *
 * Cadence: KV pages stream first (`phase: "kv"`), then row pages per table
 * (`phase: "rows"`), then one closing chunk (`phase: "final"`) that replays
 * indexes/triggers/views, restores sequences, and verifies totals — it
 * usually adds no new rows. `applied` is CUMULATIVE (the target's running
 * totals), not a per-chunk delta.
 */
export interface MigrationProgress {
  /** Chunks applied by this run so far (1-based). */
  chunk: number;
  /** The sequence number of the chunk that was just applied. */
  seq: number;
  /** What the applied chunk carried. */
  phase: "kv" | "rows" | "final";
  /** True when this was the final chunk. */
  done: boolean;
  /** Cumulative applied counts on the target. */
  applied: { kv: number; rows: Record<string, number> };
}

/** Options for {@link migrateInstance}. */
export interface MigrateInstanceOptions {
  /** A stub of the OLD instance. Its class must be wrapped with `exportable()`. */
  from: ExportableOldStub;
  /** The claydo accessor of the destination kind. */
  to: KindAccessor<any>;
  /** The logical name of the destination instance. */
  name: string;
  /** The shared migration secret, when configured on both sides. */
  secret?: string;
  /**
   * Migrate instances that have no rows and no KV entries (for example,
   * schema-only instances). Off by default: empty or never-used instances
   * are skipped without sealing anything, so stale registry entries do not
   * fabricate sealed husks.
   */
  allowEmpty?: boolean;
  /** Rows per chunk (default 500). */
  maxRowsPerChunk?: number;
  /** Approximate bytes per chunk (default 256 KiB). */
  maxBytesPerChunk?: number;
  /**
   * Called after each applied chunk, for progress logs and metrics. Keep
   * it non-throwing: an exception here aborts the migration.
   */
  onProgress?: (progress: MigrationProgress) => void;
}

/** The result of one {@link migrateInstance} run. */
export interface MigrationSummary {
  /** True when there was nothing to do. See `reason`. */
  skipped: boolean;
  /** Why the run was skipped, when it was. */
  reason?: string;
  /** True when the run resumed a crashed migration. */
  resumed: boolean;
  chunks: number;
  kv: number;
  rows: Record<string, number>;
  /** The re-armed alarm timestamp, when the old instance had one. */
  alarm: number | null | undefined;
}

function skippedSummary(reason: string): MigrationSummary {
  return {
    skipped: true,
    reason,
    resumed: false,
    chunks: 0,
    kv: 0,
    rows: {},
    alarm: undefined,
  };
}

function ownedError(kind: string, name: string, ageMs: number): Error {
  return Object.assign(
    new Error(
      `claydo: another migration driver owns the import on instance ` +
        `'${kind}:${name}' (last progress ${ageMs}ms ago). It is not stale ` +
        `yet; retry later.`,
    ),
    { code: "CLAYDO_IMPORT_OWNED" },
  );
}

/**
 * Reports what a migration of `from` would move, without sealing or
 * changing anything: row counts per table, KV entry count, the pending
 * alarm, the seal state, and any blockers (unsupported tables) that would
 * make {@link migrateInstance} fail. Use it for dry runs and runbooks.
 */
export async function previewInstance(options: {
  from: ExportableOldStub;
  secret?: string;
}): Promise<MigrationPreview> {
  const old = options.from as unknown as ExportableStub;
  return old.__claydoStats(options.secret);
}

/**
 * Moves one instance from an old binding into a claydo kind.
 *
 * Sequence: reserve the target (its traffic blocks, so racing requests
 * cannot pollute it), seal the old instance (writes freeze, WebSockets
 * close), stream export chunks, verify totals, pin the kind, and finally
 * record the move on the old instance. Exactly one driver owns a migration
 * at a time: concurrent drivers fail fast without touching anything, and a
 * crashed driver's import goes stale after ~30s so the next run adopts and
 * resumes it. On failure, partial target facets are aborted. The driver
 * unseals only an old instance that it sealed itself; a pre-existing seal
 * remains frozen. Re-running a completed migration returns `{ skipped:
 * true }`.
 */
export async function migrateInstance(
  options: MigrateInstanceOptions,
): Promise<MigrationSummary> {
  const target = options.to.get(options.name);
  const raw = target.stub as unknown as MigrationHostStub;
  const old = options.from as unknown as ExportableStub;
  const secret = options.secret;
  let limits: ImportLimits = {
    maxRows: options.maxRowsPerChunk ?? DEFAULT_MAX_ROWS,
    maxBytes: options.maxBytesPerChunk ?? DEFAULT_MAX_BYTES,
  };
  const token = crypto.randomUUID();
  // The operator-facing reference of the target. Recorded as the old
  // instance's move marker, so seal errors and previews name something a
  // human can paste into kinds(ns).<kind>.get(name).
  const targetRef = `${target.kind}:${options.name}`;

  const status = await raw.__claydoImportStatus(secret);
  const oldSeal = await old.__claydoSealed(secret);
  const stats = await old.__claydoStats(secret);
  const sourceTarget = oldSeal.movedTo ?? oldSeal.target;
  if (sourceTarget !== undefined && sourceTarget !== targetRef) {
    throw new Error(
      `claydo: old instance '${options.name}' is already claimed by target ` +
        `'${sourceTarget}'; refusing a second migration to '${targetRef}'.`,
    );
  }

  if (status.kind !== undefined) {
    if (oldSeal.sealed) {
      if (oldSeal.movedTo !== targetRef && oldSeal.movedTo !== undefined) {
        throw new Error(
          `claydo: the old instance '${options.name}' moved to ` +
            `'${oldSeal.movedTo}', but the target ` +
            `'${target.kind}:${options.name}' is also live. Check your ` +
            `migration mapping.`,
        );
      }
      if (oldSeal.movedTo === undefined) {
        if (oldSeal.target !== targetRef) {
          throw new Error(
            `claydo: old instance '${options.name}' was sealed without a ` +
              `migration claim, while target '${targetRef}' is independently ` +
              `live. Refusing to mark uncopied data as migrated.`,
          );
        }
        await old.__claydoSeal(secret, targetRef, targetRef);
      }
      return skippedSummary("already migrated");
    }
    if (!stats.hasData) {
      return skippedSummary("old instance is empty and the target is live");
    }
    throw new Error(
      `claydo: both the old instance '${options.name}' and the new instance ` +
        `'${target.kind}:${options.name}' are live. Refusing to migrate. ` +
        `If racing traffic polluted the new instance (it has no real data), ` +
        `wipe it with wipeTarget() from claydo/migrate and re-run. If the ` +
        `new instance is the source of truth, seal the old one with ` +
        `__claydoSeal() — its data will NOT be copied.`,
    );
  }

  // Pre-flight: refuse blocker tables BEFORE reserving or sealing, so both
  // sides stay untouched. (An already-sealed old instance skips this and
  // fails during export instead, with the usual rollback.)
  if (!oldSeal.sealed && stats.blockers.length > 0) {
    throw new Error(`claydo: ${stats.blockers.join(" Also: ")}`);
  }

  // Skip empty instances before touching anything, so a stale registry
  // entry cannot fabricate a sealed, empty instance pair.
  if (!oldSeal.sealed && !options.allowEmpty && !stats.hasData) {
    return skippedSummary(
      "old instance has no data (pass allowEmpty to migrate schema-only instances)",
    );
  }

  // Reserve the target FIRST: from here on, traffic to it blocks instead of
  // initializing an empty instance. Ownership refusals surface here, before
  // anything was changed, so there is nothing to roll back.
  let begin = await raw.__claydoBeginImport(
    target.kind,
    token,
    secret,
    limits,
  );
  if (!begin.ok) throw ownedError(target.kind, options.name, begin.ageMs);
  limits = begin.limits;
  if (
    begin.resumed &&
    (begin.restartRequired || !oldSeal.sealed || begin.cursor === null)
  ) {
    // Not resumable: the old instance was unsealed mid-import (the data may
    // have changed) or the previous run failed verification. Start over.
    await raw.__claydoAbortImport(token, secret);
    const fresh = await raw.__claydoBeginImport(
      target.kind,
      token,
      secret,
      limits,
    );
    if (!fresh.ok) throw ownedError(target.kind, options.name, fresh.ageMs);
    begin = fresh;
    limits = fresh.limits;
  }
  let seq = begin.seq;
  let cursor = begin.cursor;
  const resumed = begin.resumed;

  let sealedByUs = false;
  try {
    if (!oldSeal.sealed) {
      await old.__claydoSeal(secret, undefined, targetRef);
      sealedByUs = true;
    }
    let chunks = 0;
    for (;;) {
      const chunk = await old.__claydoExport(secret, cursor, limits);
      seq += 1;
      const ack = await raw.__claydoImport(
        target.kind,
        chunk,
        seq,
        token,
        secret,
      );
      chunks += 1;
      cursor = chunk.cursor;
      options.onProgress?.({
        chunk: chunks,
        seq,
        phase:
          chunk.rows !== undefined
            ? "rows"
            : chunk.kv !== undefined
              ? "kv"
              : "final",
        done: cursor === null,
        applied: ack.applied,
      });
      if (cursor === null) {
        // Success. Record the move on the old side (this also silences the
        // old instance's alarm forever).
        await old.__claydoSeal(secret, targetRef, targetRef);
        return {
          skipped: false,
          reason: undefined,
          resumed,
          chunks,
          kv: ack.applied.kv,
          rows: ack.applied.rows,
          alarm: chunk.alarm,
        };
      }
    }
  } catch (error) {
    // Before rolling anything back, check whether the migration actually
    // completed — possibly through a concurrent driver.
    let targetLive = false;
    try {
      const after = await raw.__claydoImportStatus(secret);
      targetLive = after.kind !== undefined;
    } catch {
      // Keep the conservative default.
    }
    if (targetLive) {
      try {
        await old.__claydoSeal(secret, targetRef, targetRef);
      } catch {
        // The move marker is best effort here.
      }
      return skippedSummary("completed by a concurrent driver");
    }
    // Roll back only what this driver owns. If another driver took over the
    // import, the abort fails on ownership and everything stays in place.
    let ownedRollback = true;
    try {
      await raw.__claydoAbortImport(token, secret);
    } catch {
      ownedRollback = false;
    }
    let oldUnsealed = false;
    if (ownedRollback && sealedByUs) {
      try {
        await old.__claydoUnseal(secret);
        oldUnsealed = true;
      } catch {
        // Better frozen than torn.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(
      `claydo: migration of '${options.name}' to kind '${target.kind}' ` +
        `failed${
          !ownedRollback
            ? " (another driver owns the import; nothing was rolled back)"
            : oldUnsealed
              ? " and was rolled back (target facet deleted; old instance unsealed)"
              : " and the target facet was rolled back (old seal state unchanged)"
        }: ${message}`,
      { cause: error },
    );
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string") {
      (wrapped as Error & { code: string }).code = code;
    }
    throw wrapped;
  }
}

/**
 * Deletes the target's isolated facet plus its supervisor kind/import
 * metadata and alarm. Use it to recover a target that racing traffic
 * polluted before a migration. Requires `{ importable }` on the host.
 *
 * Destructive: only call it when the target holds no data you need.
 */
export async function wipeTarget(
  accessor: KindAccessor<any>,
  name: string,
  secret?: string,
): Promise<void> {
  const target = accessor.get(name);
  const raw = target.stub as unknown as MigrationHostStub;
  await raw.__claydoReset(`${target.kind}:${name}`, secret);
}

/** Routing strategies for {@link migrated}. */
export type MigratedStrategy = "lazy" | "manual" | "drain";
export type MigratedResolution =
  | "old"
  | "new"
  | "importing"
  | "stalled"
  | "conflict";

/** Options for {@link migrated}. */
export interface MigratedOptions {
  /**
   * - `lazy`: migrate an old instance inline on first touch, then serve the
   *   new one. For fleets of small instances.
   * - `manual`: route to the old instance until an external driver migrates
   *   it. Old-route decisions re-check after `oldRouteTtlMs`.
   * - `drain`: never migrate; old instances stay old until their data
   *   expires, new names go to the kind.
   */
  strategy: MigratedStrategy;
  secret?: string;
  /** How long an "old" route decision is cached (default 30000 ms). */
  oldRouteTtlMs?: number;
}

/**
 * The accessor-like facade that {@link migrated} returns.
 *
 * It deliberately exposes only `get(name)`: `unique()` and `fromId()` have
 * no migration story (old `newUniqueId()` instances cannot keep their IDs
 * across namespaces — give them names), and `idFromName()` would leak the
 * new side's ID while the old side may still be authoritative.
 */
export interface MigratedAccessor<T> {
  get(name: string): KindStub<T>;
  /**
   * Reports which side currently serves `name`. Read-only under EVERY
   * strategy: it never migrates (unlike a `lazy` `get()`), and it neither
   * reads nor primes the route cache. Safe for progress dashboards and
   * cutover sweeps. (Like any contact, it constructs both instances if
   * they do not exist yet.)
   */
  resolve(name: string): Promise<MigratedResolution>;
}

/**
 * Returns a transitional accessor that routes each logical name to the old
 * binding or to the new kind, based on where the instance lives. Use it in
 * place of the plain accessor while a migration is in progress, then delete
 * it after cutover.
 *
 * Create the facade once per isolate (module scope, or memoized on first
 * request) — its route cache lives on the object, so a facade created per
 * request caches nothing:
 *
 * ```ts
 * let tally: MigratedAccessor<TallyImpl> | undefined;
 * export default {
 *   fetch(request, env) {
 *     tally ??= migrated(env.OLD_TALLY, kinds(env.APP_DO).tally, {
 *       strategy: "lazy",
 *     });
 *     // ...
 *   },
 * };
 * ```
 *
 * Routes resolve as: new instance live → new; old instance sealed or empty →
 * new; otherwise the strategy decides. A "new" decision is cached for the
 * Worker's lifetime; an "old" decision expires so external migrations are
 * noticed. Calls (RPC and `fetch()`, including WebSocket upgrades) that hit
 * a freshly sealed old instance re-resolve once and retry on the new side.
 * When another worker is migrating the instance right now, the facade waits
 * briefly for it to finish instead of failing.
 *
 * The stubs' `id`/`kind` metadata always describe the NEW side, even while
 * the old instance still serves the traffic — use `resolve(name)` when you
 * need to know which side is authoritative right now.
 */
export function migrated<T, NS extends DurableObjectNamespace<any>>(
  oldNamespace: NS,
  accessor: KindAccessor<T>,
  options: MigratedOptions,
): MigratedAccessor<T> {
  const secret = options.secret;
  const oldRouteTtlMs = options.oldRouteTtlMs ?? 30_000;
  const routes = new Map<
    string,
    { promise: Promise<"new" | "old">; at: number }
  >();
  const ns = oldNamespace as DurableObjectNamespace;

  function oldStubFor(name: string): ExportableOldStub & ExportableStub {
    return ns.get(ns.idFromName(name)) as unknown as ExportableOldStub &
      ExportableStub;
  }

  function rawFor(name: string): MigrationHostStub {
    return accessor.get(name).stub as unknown as MigrationHostStub;
  }

  /**
   * A read-only route probe: never migrates, never touches the route
   * cache. This is what `resolve()` exposes, so observability sweeps over
   * a fleet cannot trigger migrations the way `get()` under `lazy` does.
   */
  async function peek(name: string): Promise<MigratedResolution> {
    const status = await rawFor(name).__claydoImportStatus(secret);
    const oldStub = oldStubFor(name);
    const seal = await oldStub.__claydoSealed(secret);
    if (status.kind !== undefined) {
      if (!seal.sealed && (await oldStub.__claydoHasData(secret))) {
        return "conflict";
      }
      return "new";
    }
    if (status.importing !== undefined) {
      return status.importing.ageMs >= IMPORT_STALE_MS
        ? "stalled"
        : "importing";
    }
    if (seal.sealed) return "stalled";
    if (!(await oldStub.__claydoHasData(secret))) return "new";
    return "old";
  }

  /** Waits for a migration another worker is running on this instance. */
  async function waitForMigration(name: string): Promise<boolean> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const status = await rawFor(name).__claydoImportStatus(secret);
      if (status.kind !== undefined) return true;
      if (status.importing === undefined) return false;
    }
    return false;
  }

  async function resolve(name: string): Promise<"new" | "old"> {
    const target = accessor.get(name);
    const raw = target.stub as unknown as MigrationHostStub;
    const oldStub = oldStubFor(name);
    let status = await raw.__claydoImportStatus(secret);
    if (status.kind !== undefined) {
      const seal = await oldStub.__claydoSealed(secret);
      if (!seal.sealed && (await oldStub.__claydoHasData(secret))) {
        throw new Error(
          `claydo: both the old instance '${name}' and the new instance ` +
            `'${target.kind}:${name}' are live. Fix the split before ` +
            `routing traffic: wipe the polluted new instance with ` +
            `wipeTarget() and migrate, or seal the old one if the new ` +
            `instance is the source of truth.`,
        );
      }
      return "new";
    }
    if (status.importing !== undefined) {
      if (
        options.strategy === "lazy" &&
        status.importing.ageMs >= IMPORT_STALE_MS
      ) {
        await migrateInstance({ from: oldStub, to: accessor, name, secret });
        return "new";
      }
      // Another worker is migrating this instance right now.
      if (await waitForMigration(name)) return "new";
      status = await raw.__claydoImportStatus(secret);
      if (status.kind !== undefined) return "new";
      if (status.importing !== undefined) {
        if (
          options.strategy === "lazy" &&
          status.importing.ageMs >= IMPORT_STALE_MS
        ) {
          // The owner disappeared. migrateInstance adopts the stale
          // reservation and resumes from its facet-local checkpoint.
          await migrateInstance({ from: oldStub, to: accessor, name, secret });
          return "new";
        }
        throw Object.assign(
          new Error(
            `claydo: migration of '${name}' is still in progress ` +
              `(${status.importing.ageMs}ms since last progress). Retry.`,
          ),
          { code: "CLAYDO_IMPORTING" },
        );
      }
    }
    const seal = await oldStub.__claydoSealed(secret);
    if (seal.sealed) return "new";
    if (!(await oldStub.__claydoHasData(secret))) return "new";
    if (options.strategy === "lazy") {
      try {
        await migrateInstance({ from: oldStub, to: accessor, name, secret });
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (
          (code === "CLAYDO_IMPORT_OWNED" ||
            code === "CLAYDO_IMPORTING") &&
          (await waitForMigration(name))
        ) {
          return "new";
        }
        throw error;
      }
      return "new";
    }
    return "old";
  }

  function resolveCached(name: string): Promise<"new" | "old"> {
    const cached = routes.get(name);
    if (cached !== undefined && Date.now() - cached.at <= oldRouteTtlMs) {
      return cached.promise;
    }
    const entry = {
      promise: resolve(name).catch((error) => {
        routes.delete(name);
        throw error;
      }),
      at: Date.now(),
    };
    routes.set(name, entry);
    entry.promise.then(
      (route) => {
        // "new" is final; "old" decisions keep their TTL.
        if (route === "new") entry.at = Number.MAX_SAFE_INTEGER;
      },
      () => {
        // Failure already evicted the cache entry above.
      },
    );
    return entry.promise;
  }

  function facade(name: string): KindStub<T> {
    const target = accessor.get(name);
    const meta: Record<string, unknown> = {
      id: target.id,
      name,
      kind: target.kind,
      stub: target.stub,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const route = await resolveCached(name);
        if (route === "new") return target.fetch(input, init);
        const request = new Request(input, init);
        const retryRequest = request.clone();
        const response = await oldStubFor(name).fetch(request);
        if (
          response.status === 410 &&
          response.headers.get(SEALED_HEADER) !== null
        ) {
          // The old instance sealed since the route was cached; re-resolve
          // and retry on the new side (covers WebSocket upgrades too).
          routes.delete(name);
          const retry = await resolveCached(name);
          if (retry === "new") return target.fetch(retryRequest);
        }
        return response;
      },
    };
    return new Proxy(meta, {
      get(metaTarget, prop) {
        if (typeof prop !== "string") return undefined;
        if (Object.prototype.hasOwnProperty.call(metaTarget, prop)) {
          return metaTarget[prop];
        }
        if (prop === "then") return undefined;
        return async (...args: unknown[]) => {
          const route = await resolveCached(name);
          if (route === "new") {
            return (
              target as unknown as Record<string, (...a: unknown[]) => unknown>
            )[prop]!(...args);
          }
          try {
            const oldStub = oldStubFor(name) as unknown as Record<
              string,
              (...a: unknown[]) => unknown
            >;
            return await oldStub[prop]!(...args);
          } catch (error) {
            // The old instance may have been sealed between the route check
            // and the call. Re-resolve once and retry on the new side.
            if (
              (error as { code?: unknown } | null)?.code ===
              "CLAYDO_SEALED"
            ) {
              routes.delete(name);
              const retry = await resolveCached(name);
              if (retry === "new") {
                return (
                  target as unknown as Record<
                    string,
                    (...a: unknown[]) => unknown
                  >
                )[prop]!(...args);
              }
            }
            throw error;
          }
        };
      },
    }) as KindStub<T>;
  }

  return { get: facade, resolve: peek };
}
