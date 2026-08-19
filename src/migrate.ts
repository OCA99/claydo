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
 * Ordering guarantees: the old instance is sealed (frozen) before data is
 * read, the new instance goes live only after every chunk is applied and
 * verified, and a failed migration is rolled back (partial import aborted,
 * old instance unsealed). A crashed driver resumes where it stopped, because
 * the old instance stays sealed.
 */

import type { KindAccessor, KindStub } from "./client";
import {
  SEAL_KEY,
  quoteIdent,
  sizeOf,
  type ExportChunk,
  type ExportCursor,
  type ImportAck,
  type ImportStatus,
  type SqlValue,
} from "./migrate-wire";

export type {
  ExportChunk,
  ExportCursor,
  ImportAck,
  ImportStatus,
} from "./migrate-wire";

const KV_BATCH = 128; // storage.put() accepts at most 128 keys.
const DEFAULT_MAX_ROWS = 500;
const DEFAULT_MAX_BYTES = 256 * 1024;
const ROWID_FLOOR = -Number.MAX_SAFE_INTEGER;

interface SealRecord {
  movedTo?: string;
  at: number;
}

interface ExportLimits {
  maxRows?: number;
  maxBytes?: number;
}

/** The methods that {@link exportable} adds to the old class. */
export interface ExportableInstance {
  /** Freezes the instance: every user method fails until unseal. */
  __claydoSeal(secret?: string, movedTo?: string): Promise<void>;
  /** Reverses a seal, for migration rollback. */
  __claydoUnseal(secret?: string): Promise<void>;
  /** Reports the seal state. */
  __claydoSealed(secret?: string): Promise<{ sealed: boolean; movedTo?: string }>;
  /** True when the instance has any user data (tables or KV entries). */
  __claydoHasData(secret?: string): Promise<boolean>;
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
}

type DurableObjectLike = { ctx: DurableObjectState; env: unknown };
type DOClass = abstract new (...args: any[]) => DurableObjectLike;

/** The class type that {@link exportable} returns. */
export interface ExportableClass<I> {
  new (...args: any[]): I & ExportableInstance;
}

/**
 * Wraps a finished Durable Object class so its instances can be exported
 * into a claydo kind. Deploy this wrapper on the OLD Worker; behavior is
 * unchanged until an instance is sealed.
 *
 * While sealed: RPC methods throw, `fetch()` answers 410, `alarm()` becomes
 * a no-op, and the data is frozen so exports are consistent and resumable.
 *
 * Wrap the complete class: the seal guard covers the methods of the wrapped
 * class and its ancestors, not methods added by later subclasses.
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
  class Exportable extends ConcreteBase {
    #sealCache: SealRecord | null | undefined;

    /**
     * Puts seal-guarded wrappers for every method of the wrapped class onto
     * this prototype. Workers RPC resolves methods through the prototype
     * chain, so the wrappers shadow the originals for local and remote
     * callers alike.
     */
    static {
      const seen = new Set<string>();
      let proto: object | null = ConcreteBase.prototype as object;
      while (
        proto !== null &&
        proto !== Object.prototype &&
        proto.constructor?.name !== "DurableObject"
      ) {
        for (const key of Object.getOwnPropertyNames(proto)) {
          if (
            key === "constructor" ||
            key.startsWith("__claydo") ||
            seen.has(key)
          ) {
            continue;
          }
          const descriptor = Object.getOwnPropertyDescriptor(proto, key);
          if (!descriptor || typeof descriptor.value !== "function") continue;
          seen.add(key);
          const original = descriptor.value as (...args: unknown[]) => unknown;
          let wrapper: (this: Exportable, ...args: unknown[]) => unknown;
          if (key === "fetch") {
            wrapper = async function (this: Exportable, ...args: unknown[]) {
              const seal = await this.#sealState();
              if (seal) {
                return new Response(this.#sealMessage(seal), { status: 410 });
              }
              return original.apply(this, args);
            };
          } else if (key === "alarm") {
            wrapper = async function (this: Exportable, ...args: unknown[]) {
              const seal = await this.#sealState();
              if (seal) {
                console.warn(
                  `claydo: alarm() skipped on sealed instance '${this.#identity()}'.`,
                );
                return;
              }
              return original.apply(this, args);
            };
          } else {
            wrapper = async function (this: Exportable, ...args: unknown[]) {
              const seal = await this.#sealState();
              if (seal) throw new Error(this.#sealMessage(seal));
              return original.apply(this, args);
            };
          }
          Object.defineProperty(Exportable.prototype, key, {
            value: wrapper,
            writable: true,
            configurable: true,
          });
        }
        proto = Object.getPrototypeOf(proto);
      }
    }

    #identity(): string {
      return this.ctx.id.name ?? this.ctx.id.toString();
    }

    #auth(secret: string | undefined): void {
      if (options.secret !== undefined && secret !== options.secret) {
        throw new Error("claydo: invalid migration secret.");
      }
    }

    async #sealState(): Promise<SealRecord | undefined> {
      if (this.#sealCache === undefined) {
        this.#sealCache =
          (await this.ctx.storage.get<SealRecord>(SEAL_KEY)) ?? null;
      }
      return this.#sealCache ?? undefined;
    }

    #sealMessage(seal: SealRecord): string {
      const moved =
        seal.movedTo === undefined
          ? " A migration is in progress."
          : ` It moved to Durable Object id ${seal.movedTo}; route traffic through the claydo binding.`;
      return `claydo: instance '${this.#identity()}' is sealed.${moved}`;
    }

    async __claydoSeal(secret?: string, movedTo?: string): Promise<void> {
      this.#auth(secret);
      const existing = await this.#sealState();
      const record: SealRecord = {
        movedTo: movedTo ?? existing?.movedTo,
        at: existing?.at ?? Date.now(),
      };
      await this.ctx.storage.put(SEAL_KEY, record);
      this.#sealCache = record;
    }

    async __claydoUnseal(secret?: string): Promise<void> {
      this.#auth(secret);
      await this.ctx.storage.delete(SEAL_KEY);
      this.#sealCache = null;
    }

    async __claydoSealed(
      secret?: string,
    ): Promise<{ sealed: boolean; movedTo?: string }> {
      this.#auth(secret);
      const seal = await this.#sealState();
      return { sealed: seal !== undefined, movedTo: seal?.movedTo };
    }

    async __claydoHasData(secret?: string): Promise<boolean> {
      this.#auth(secret);
      // Schema alone does not count: constructors commonly run
      // `CREATE TABLE IF NOT EXISTS`, which would mark every probed
      // instance as "has data". Only rows and KV entries count.
      for (const table of this.#userTables()) {
        const row = this.ctx.storage.sql
          .exec(`SELECT 1 FROM ${quoteIdent(table.name)} LIMIT 1`)
          .toArray();
        if (row.length > 0) return true;
      }
      let after: string | undefined;
      for (;;) {
        const listed = await this.ctx.storage.list({
          startAfter: after,
          limit: KV_BATCH,
        });
        if (listed.size === 0) return false;
        for (const key of listed.keys()) {
          after = key;
          if (!key.startsWith("__claydo")) return true;
        }
        if (listed.size < KV_BATCH) return false;
      }
    }

    async __claydoExport(
      secret: string | undefined,
      cursor: ExportCursor | null,
      limits: ExportLimits = {},
    ): Promise<ExportChunk> {
      this.#auth(secret);
      const seal = await this.#sealState();
      if (seal === undefined) {
        throw new Error(
          `claydo: instance '${this.#identity()}' is not sealed. Seal it ` +
            `with __claydoSeal() before exporting, so the data cannot ` +
            `change during the copy.`,
        );
      }
      const maxRows = limits.maxRows ?? DEFAULT_MAX_ROWS;
      const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
      const tables = this.#userTables();
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
      chunk.post = this.#postDdl();
      chunk.sequences = this.#sequences();
      chunk.alarm = await this.ctx.storage.getAlarm();
      chunk.totals = {
        kv: await this.#kvCount(),
        rows: Object.fromEntries(
          tables.map((t) => [
            t.name,
            this.ctx.storage.sql
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

    #userTables(): { name: string; ddl: string; rowidAlias: string | null }[] {
      const rows = this.ctx.storage.sql
        .exec<{ name: string; sql: string }>(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'table' AND sql IS NOT NULL
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
           ORDER BY name`,
        )
        .toArray();
      return rows.map((row) => {
        if (/WITHOUT\s+ROWID/i.test(row.sql)) {
          throw new Error(
            `claydo: table '${row.name}' is WITHOUT ROWID, which the ` +
              `exporter does not support yet. Copy this table with custom ` +
              `code, or recreate it with a rowid.`,
          );
        }
        if (/^\s*CREATE\s+VIRTUAL/i.test(row.sql)) {
          throw new Error(
            `claydo: table '${row.name}' is a virtual table, which the ` +
              `exporter does not support. Drop it before migrating or copy ` +
              `it with custom code.`,
          );
        }
        return { name: row.name, ddl: row.sql, rowidAlias: this.#rowidAlias(row.name) };
      });
    }

    /**
     * Returns the column name that aliases the rowid (a single INTEGER
     * PRIMARY KEY), or null. Alias tables must not receive an explicit
     * rowid on insert, because the alias column already carries it.
     */
    #rowidAlias(table: string): string | null {
      const info = this.ctx.storage.sql
        .exec<{ name: string; type: string; pk: number }>(
          `PRAGMA table_info(${quoteIdent(table)})`,
        )
        .toArray();
      const pks = info.filter((column) => column.pk > 0);
      if (pks.length === 1 && pks[0]!.type.toUpperCase() === "INTEGER") {
        return pks[0]!.name;
      }
      return null;
    }

    #rowPage(
      table: { name: string; rowidAlias: string | null },
      afterRowid: number,
      maxRows: number,
      maxBytes: number,
    ): { columns: string[]; values: SqlValue[][]; lastRowid: number } {
      const select =
        table.rowidAlias === null
          ? `SELECT rowid AS __rowid__, * FROM ${quoteIdent(table.name)}
             WHERE rowid > ? ORDER BY rowid LIMIT ?`
          : `SELECT * FROM ${quoteIdent(table.name)}
             WHERE rowid > ? ORDER BY rowid LIMIT ?`;
      const query = this.ctx.storage.sql.exec(select, afterRowid, maxRows);
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
      let after = afterKey === "" ? undefined : afterKey;
      for (;;) {
        const listed = await this.ctx.storage.list({
          startAfter: after,
          limit: KV_BATCH,
        });
        if (listed.size === 0) return null;
        const entries: [string, unknown][] = [];
        let bytes = 0;
        for (const [key, value] of listed) {
          after = key;
          if (key.startsWith("__claydo")) continue;
          entries.push([key, value]);
          bytes += key.length * 2 + sizeOf(value);
          if (entries.length >= KV_BATCH || bytes >= maxBytes) break;
        }
        if (entries.length > 0) return { entries, afterKey: after! };
        if (listed.size < KV_BATCH) return null;
      }
    }

    async #kvCount(): Promise<number> {
      let count = 0;
      let after: string | undefined;
      for (;;) {
        const listed = await this.ctx.storage.list({
          startAfter: after,
          limit: KV_BATCH,
        });
        if (listed.size === 0) return count;
        for (const key of listed.keys()) {
          after = key;
          if (!key.startsWith("__claydo")) count += 1;
        }
        if (listed.size < KV_BATCH) return count;
      }
    }

    #postDdl(): string[] {
      return this.ctx.storage.sql
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
      try {
        return this.ctx.storage.sql
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

  return Exportable as unknown as ExportableClass<I>;
}

/** The host-side migration surface, reachable on a raw claydo stub. */
interface MigrationHostStub {
  __claydoImportStatus(secret?: string): Promise<ImportStatus>;
  __claydoImport(
    kind: string,
    chunk: ExportChunk,
    seq: number,
    secret?: string,
  ): Promise<ImportAck>;
  __claydoAbortImport(secret?: string): Promise<boolean>;
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
  __claydoSeal(secret?: string, movedTo?: string): Promise<void>;
  __claydoUnseal(secret?: string): Promise<void>;
  __claydoSealed(
    secret?: string,
  ): Promise<{ sealed: boolean; movedTo?: string }>;
  __claydoHasData(secret?: string): Promise<boolean>;
  __claydoExport(
    secret: string | undefined,
    cursor: ExportCursor | null,
    limits?: ExportLimits,
  ): Promise<ExportChunk>;
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
  /** Rows per chunk (default 500). */
  maxRowsPerChunk?: number;
  /** Approximate bytes per chunk (default 256 KiB). */
  maxBytesPerChunk?: number;
}

/** The result of one {@link migrateInstance} run. */
export interface MigrationSummary {
  /** True when there was nothing to do (already migrated, or old instance empty). */
  skipped: boolean;
  /** True when the run resumed a crashed migration. */
  resumed: boolean;
  chunks: number;
  kv: number;
  rows: Record<string, number>;
  /** The re-armed alarm timestamp, when the old instance had one. */
  alarm: number | null | undefined;
}

/**
 * Moves one instance from an old binding into a claydo kind.
 *
 * Sequence: seal the old instance (freezes writes), stream export chunks
 * into the target, verify totals, and pin the kind — the target only serves
 * traffic after the final chunk. On failure, the partial import is aborted
 * and the old instance is unsealed, so traffic continues on the old side.
 * On a crash (no failure handler ran), the old instance stays sealed and the
 * next run resumes from the last applied chunk.
 *
 * Safe to re-run: a completed migration returns `{ skipped: true }`.
 */
export async function migrateInstance(
  options: MigrateInstanceOptions,
): Promise<MigrationSummary> {
  const target = options.to.get(options.name);
  const raw = target.stub as unknown as MigrationHostStub;
  const old = options.from as unknown as ExportableStub;
  const secret = options.secret;
  const limits = {
    maxRows: options.maxRowsPerChunk,
    maxBytes: options.maxBytesPerChunk,
  };

  const status = await raw.__claydoImportStatus(secret);
  if (status.kind !== undefined) {
    const seal = await old.__claydoSealed(secret);
    if (seal.sealed) {
      return { skipped: true, resumed: false, chunks: 0, kv: 0, rows: {}, alarm: undefined };
    }
    if (!(await old.__claydoHasData(secret))) {
      return { skipped: true, resumed: false, chunks: 0, kv: 0, rows: {}, alarm: undefined };
    }
    throw new Error(
      `claydo: both the old instance '${options.name}' and the new instance ` +
        `'${target.kind}:${options.name}' are live. Refusing to migrate. ` +
        `If the new instance is the source of truth, seal the old one; ` +
        `otherwise wipe the new instance before migrating.`,
    );
  }

  let seq = 0;
  let cursor: ExportCursor | null = null;
  let resumed = false;
  if (status.importing !== undefined) {
    const seal = await old.__claydoSealed(secret);
    if (
      !seal.sealed ||
      status.importing.cursor === null ||
      status.importing.kind !== target.kind
    ) {
      // The partial import is not resumable (the old data may have changed,
      // or verification failed). Start over.
      await raw.__claydoAbortImport(secret);
    } else {
      seq = status.importing.seq;
      cursor = status.importing.cursor;
      resumed = true;
    }
  }

  await old.__claydoSeal(secret, target.id.toString());

  try {
    let chunks = 0;
    for (;;) {
      const chunk = await old.__claydoExport(secret, cursor, limits);
      seq += 1;
      const ack = await raw.__claydoImport(target.kind, chunk, seq, secret);
      chunks += 1;
      cursor = chunk.cursor;
      if (cursor === null) {
        return {
          skipped: false,
          resumed,
          chunks,
          kv: ack.applied.kv,
          rows: ack.applied.rows,
          alarm: chunk.alarm,
        };
      }
    }
  } catch (error) {
    // Roll back: discard the partial import, unfreeze the old instance.
    try {
      await raw.__claydoAbortImport(secret);
    } catch {
      // The abort is best effort; the import state also blocks traffic.
    }
    try {
      await old.__claydoUnseal(secret);
    } catch {
      // Leave the seal in place if unsealing fails; better frozen than torn.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `claydo: migration of '${options.name}' to kind '${target.kind}' ` +
        `failed and was rolled back (old instance unsealed): ${message}`,
      { cause: error },
    );
  }
}

/** Routing strategies for {@link migrated}. */
export type MigratedStrategy = "lazy" | "manual" | "drain";

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

/** The accessor-like facade that {@link migrated} returns. */
export interface MigratedAccessor<T> {
  get(name: string): KindStub<T>;
}

/**
 * Returns a transitional accessor that routes each logical name to the old
 * binding or to the new kind, based on where the instance lives. Use it in
 * place of the plain accessor while a migration is in progress, then delete
 * it after cutover.
 *
 * Routes resolve as: new instance live → new; old instance sealed or empty →
 * new; otherwise the strategy decides. A "new" decision is cached for the
 * Worker's lifetime; an "old" decision expires so external migrations are
 * noticed. If a call hits a freshly sealed old instance, the facade
 * re-resolves once and retries on the new side.
 */
export function migrated<T, NS extends DurableObjectNamespace<any>>(
  oldNamespace: NS,
  accessor: KindAccessor<T>,
  options: MigratedOptions,
): MigratedAccessor<T> {
  const secret = options.secret;
  const oldRouteTtlMs = options.oldRouteTtlMs ?? 30_000;
  const routes = new Map<string, { promise: Promise<"new" | "old">; at: number }>();
  const ns = oldNamespace as DurableObjectNamespace;

  function oldStubFor(name: string): ExportableOldStub & ExportableStub {
    return ns.get(
      ns.idFromName(name),
    ) as unknown as ExportableOldStub & ExportableStub;
  }

  async function resolve(name: string): Promise<"new" | "old"> {
    const target = accessor.get(name);
    const raw = target.stub as unknown as MigrationHostStub;
    const oldStub = oldStubFor(name);
    const status = await raw.__claydoImportStatus(secret);
    if (status.kind !== undefined) {
      const seal = await oldStub.__claydoSealed(secret);
      if (!seal.sealed && (await oldStub.__claydoHasData(secret))) {
        throw new Error(
          `claydo: both the old instance '${name}' and the new instance ` +
            `'${target.kind}:${name}' are live. Fix the split before ` +
            `routing traffic (seal the old instance, or wipe the new one).`,
        );
      }
      return "new";
    }
    const seal = await oldStub.__claydoSealed(secret);
    if (seal.sealed) return "new";
    if (!(await oldStub.__claydoHasData(secret))) return "new";
    if (options.strategy === "lazy") {
      await migrateInstance({ from: oldStub, to: accessor, name, secret });
      return "new";
    }
    return "old";
  }

  function resolveCached(name: string): Promise<"new" | "old"> {
    const cached = routes.get(name);
    if (cached !== undefined) {
      const expired = Date.now() - cached.at > oldRouteTtlMs;
      // "new" is final; "old" decisions expire so external drivers are seen.
      if (!expired) return cached.promise;
      const keep = cached.promise.then(
        (route) => route === "new",
        () => false,
      );
      routes.delete(name);
      void keep;
    }
    const entry = {
      promise: resolve(name).catch((error) => {
        routes.delete(name);
        throw error;
      }),
      at: Date.now(),
    };
    routes.set(name, entry);
    entry.promise.then((route) => {
      if (route === "new") entry.at = Number.MAX_SAFE_INTEGER; // never expires
    });
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
        return oldStubFor(name).fetch(new Request(input, init));
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
            return (target as unknown as Record<string, (...a: unknown[]) => unknown>)[
              prop
            ]!(...args);
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
            if (error instanceof Error && error.message.includes("is sealed")) {
              routes.delete(name);
              const retry = await resolveCached(name);
              if (retry === "new") {
                return (
                  target as unknown as Record<string, (...a: unknown[]) => unknown>
                )[prop]!(...args);
              }
            }
            throw error;
          }
        };
      },
    }) as KindStub<T>;
  }

  return { get: facade };
}
