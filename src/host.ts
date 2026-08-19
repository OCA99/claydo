import { DurableObject } from "cloudflare:workers";
import {
  IMPORT_STALE_MS,
  IMPORT_STATE_KEY,
  quoteIdent,
  type ExportChunk,
  type ImportAck,
  type ImportBegin,
  type ImportState,
  type ImportStatus,
  type SqlValue,
} from "./migrate-wire";
import {
  KIND_HEADER,
  KIND_STORAGE_KEY,
  NO_INIT_HEADER,
  type KindHandlers,
  type KindRegistry,
} from "./types";

/**
 * Methods that remote callers must not invoke through `__claydoCall`.
 * Lifecycle handlers run through their dedicated host handlers instead.
 */
const RESERVED_METHODS = new Set([
  "constructor",
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);

/**
 * Method names that the typed stub shadows with metadata. `union()` rejects
 * kind classes that define these as methods, so the shadowing can never hide
 * a real method at runtime.
 */
const RESERVED_STUB_KEYS = ["id", "name", "kind", "stub"] as const;

/** A serializable snapshot of an error, carried through the RPC envelope. */
export interface WireError {
  name: string;
  message: string;
  /** The stack captured where the error was thrown, inside the kind. */
  stack?: string;
  /** Own enumerable, structured-cloneable fields of the error. */
  props?: Record<string, unknown>;
}

/**
 * The result envelope of a dispatched RPC call. The client helper unwraps it
 * and rethrows errors locally with the remote stack and fields attached.
 */
export type ClaydoCallResult =
  | { ok: true; value: unknown }
  | { ok: false; error: WireError };

function toWireError(error: unknown): WireError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  const wire: WireError = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  const props: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    const value = (error as unknown as Record<string, unknown>)[key];
    try {
      structuredClone(value);
      props[key] = value;
    } catch {
      // Skip fields that do not serialize.
    }
  }
  if (Object.keys(props).length > 0) wire.props = props;
  return wire;
}

/** The instance type of the class that {@link union} returns. */
export interface GenericDurableObjectInstance<R extends KindRegistry>
  extends Rpc.DurableObjectBranded {
  /** Phantom field. It carries the registry type for client-side inference. */
  readonly __kinds: R;
  ctx: DurableObjectState;
  env: unknown;
  /** Dispatches an RPC call to the kind implementation. Internal. */
  __claydoCall(
    kind: string,
    method: string,
    args: unknown[],
    allowInit?: boolean,
  ): Promise<ClaydoCallResult>;
  /**
   * Returns the kind of this instance, or `undefined` when the instance has
   * no kind yet. This call never initializes the instance.
   */
  __claydoKind(): Promise<string | undefined>;
  /** Reserves an import and blocks traffic. See `claydo/migrate`. Internal. */
  __claydoBeginImport(
    kind: string,
    token: string,
    secret?: string,
  ): Promise<ImportBegin>;
  /** Applies one migration chunk. See `claydo/migrate`. Internal. */
  __claydoImport(
    kind: string,
    chunk: ExportChunk,
    seq: number,
    token: string,
    secret?: string,
  ): Promise<ImportAck>;
  /** Reports the migration state of this instance. See `claydo/migrate`. */
  __claydoImportStatus(secret?: string): Promise<ImportStatus>;
  /** Discards a partial import owned by `token`. See `claydo/migrate`. */
  __claydoAbortImport(token: string, secret?: string): Promise<boolean>;
  /**
   * Wipes this instance completely: storage, alarm, import state, and the
   * in-memory kind pin. A recovery tool for polluted migration targets.
   * Requires `{ importable }` to be enabled. See `wipeTarget` in
   * `claydo/migrate`.
   */
  __claydoReset(confirmId: string, secret?: string): Promise<void>;
  fetch(request: Request): Promise<Response>;
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void>;
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
  webSocketError(ws: WebSocket, error: unknown): Promise<void>;
}

/** The constructor type of the class that {@link union} returns. */
export type GenericDurableObjectClass<R extends KindRegistry> = new (
  ctx: DurableObjectState,
  env: any,
) => GenericDurableObjectInstance<R>;

/** Options for {@link union}. */
export interface UnionOptions<R extends KindRegistry> {
  /**
   * Enables `claydo/migrate` imports into the listed kinds (or all kinds
   * when `true`). Off by default: with imports disabled, the host rejects
   * every `__claydoImport` call.
   */
  importable?: boolean | (keyof R & string)[];
  /**
   * When set, migration calls (`__claydoImport`, `__claydoImportStatus`,
   * `__claydoAbortImport`) must present the same secret. Use this when the
   * old Durable Objects live in another Worker.
   */
  secret?: string;
}

/**
 * Creates one Durable Object class that hosts many kinds.
 *
 * Each instance binds to exactly one kind, forever. The host resolves the
 * kind from, in order:
 *
 * 1. The value persisted in storage on first contact.
 * 2. The `<kind>:` prefix of the instance name (`ctx.id.name`).
 * 3. The hint that the client helper sends with every call. The hint only
 *    initializes instances reached through `get()` or `unique()`; `fromId()`
 *    never initializes.
 *
 * Export the returned class from your Worker and point one binding plus one
 * SQLite migration at it. You never add migrations for new kinds.
 *
 * @example
 * export class AppDO extends union({ counter: Counter, chat: ChatRoom }) {}
 */
export function union<R extends KindRegistry>(
  kinds: R,
  options: UnionOptions<R> = {},
): GenericDurableObjectClass<R> {
  for (const [name, Kind] of Object.entries(kinds)) {
    if (name.includes(":") || name.startsWith("__") || name.length === 0) {
      throw new Error(
        `claydo: invalid kind name '${name}'. ` +
          `Kind names must be non-empty, must not contain ':' and must not start with '__'.`,
      );
    }
    // Reject methods that the stub metadata would silently shadow.
    let proto: object | null = Kind.prototype as object;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of RESERVED_STUB_KEYS) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (descriptor && typeof descriptor.value === "function") {
          throw new Error(
            `claydo: kind '${name}' (class ${Kind.name}) ` +
              `defines a method named '${key}'. The stub reserves ` +
              `'${RESERVED_STUB_KEYS.join("', '")}' for metadata, so this ` +
              `method would not be callable. Rename the method.`,
          );
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
  }

  class GenericDurableObject extends DurableObject {
    declare readonly __kinds: R;
    #kind?: string;
    #impl?: object & KindHandlers;
    #loading?: Promise<void>;

    /** A human-readable identity for error messages and logs. */
    #identity(): string {
      return this.ctx.id.name ?? this.ctx.id.toString();
    }

    async #load(hint?: string, allowInit = true): Promise<object & KindHandlers> {
      if (this.#impl === undefined) {
        if (this.#loading === undefined) {
          this.#loading = this.#initialize(hint, allowInit).catch((error) => {
            // Allow a later call (possibly with a hint) to retry.
            this.#loading = undefined;
            throw error;
          });
        }
        await this.#loading;
      }
      if (hint !== undefined && hint !== this.#kind) {
        throw new Error(
          `claydo: instance '${this.#identity()}' is kind ` +
            `'${this.#kind}', but the caller expected kind '${hint}'.`,
        );
      }
      return this.#impl!;
    }

    async #initialize(hint?: string, allowInit = true): Promise<void> {
      const persisted = await this.ctx.storage.get<unknown>([
        KIND_STORAGE_KEY,
        IMPORT_STATE_KEY,
      ]);
      const importing = persisted.get(IMPORT_STATE_KEY) as
        | ImportState
        | undefined;
      if (importing !== undefined) {
        throw Object.assign(
          new Error(
            `claydo: instance '${this.#identity()}' is importing kind ` +
              `'${importing.kind}'. Traffic is blocked until the migration ` +
              `completes or is aborted.`,
          ),
          { code: "claydo_importing" },
        );
      }
      const stored = persisted.get(KIND_STORAGE_KEY) as string | undefined;
      const kind =
        stored ?? this.#kindFromName() ?? (allowInit ? hint : undefined);
      if (kind === undefined) {
        throw new Error(this.#noKindMessage(hint, allowInit));
      }
      const Kind = kinds[kind];
      if (Kind === undefined) {
        throw new Error(
          `claydo: unknown kind '${kind}' on instance ` +
            `'${this.#identity()}'. Registered kinds: ${Object.keys(kinds).join(", ")}.`,
        );
      }
      if (stored === undefined) {
        await this.ctx.storage.put(KIND_STORAGE_KEY, kind);
      }
      const impl = new Kind(this.ctx, this.env);
      // Framework classes (PartyServer `Server`, Cloudflare Agents `Agent`,
      // Think) run their startup hook (`onStart`) only from `fetch()`,
      // WebSocket events, or their own `setName` RPC — never from a plain
      // method call. Claydo dispatches RPC directly to methods, so without
      // this step an Agent kind reached by RPC first would run with
      // uninitialized internal state. The hook is idempotent; plain kinds
      // do not define it and skip this entirely.
      const ensure = (impl as Record<string, unknown>)[
        "__unsafe_ensureInitialized"
      ];
      if (typeof ensure === "function") {
        await (ensure as (this: object) => unknown).call(impl);
      }
      this.#kind = kind;
      this.#impl = impl;
    }

    #noKindMessage(hint: string | undefined, allowInit: boolean): string {
      const identity = this.#identity();
      let message = `claydo: instance '${identity}' has no kind yet.`;
      if (hint !== undefined && !allowInit) {
        return (
          message +
          ` It was accessed as kind '${hint}' through fromId(), which never ` +
          `initializes an instance. Create the instance first with ` +
          `kind(ns, '${hint}').get(name) or .unique(), then reach it by id.`
        );
      }
      const name = this.ctx.id.name;
      if (name !== undefined) {
        return (
          message +
          ` Its name has no registered '<kind>:' prefix. Raw namespace access ` +
          `(for example getByName('${name}')) reaches a different instance than ` +
          `kind(ns, '<kind>').get('${name}'). Access instances through the ` +
          `kind() helper, or use a '<kind>:' prefixed name.`
        );
      }
      return (
        message +
        ` Unique-ID instances initialize on their first call through ` +
        `kind(ns, '<kind>').unique().`
      );
    }

    #kindFromName(): string | undefined {
      const name = this.ctx.id.name;
      if (name === undefined) return undefined;
      const separator = name.indexOf(":");
      if (separator === -1) return undefined;
      const prefix = name.slice(0, separator);
      return prefix in kinds ? prefix : undefined;
    }

    async __claydoCall(
      kind: string,
      method: string,
      args: unknown[],
      allowInit = true,
    ): Promise<ClaydoCallResult> {
      try {
        const impl = await this.#load(kind, allowInit);
        if (
          typeof method !== "string" ||
          method.startsWith("__") ||
          RESERVED_METHODS.has(method)
        ) {
          throw new Error(
            `claydo: method '${method}' is reserved and is not callable through the stub.`,
          );
        }
        const fn = (impl as Record<string, unknown>)[method];
        if (
          typeof fn !== "function" ||
          fn === (Object.prototype as Record<string, unknown>)[method]
        ) {
          if (method in impl && typeof fn !== "function") {
            throw new Error(
              `claydo: '${method}' on kind '${kind}' is a ` +
                `property, not a method (type: ${typeof fn}). The stub only ` +
                `proxies methods; add a getter method to read it.`,
            );
          }
          throw new Error(
            `claydo: kind '${kind}' has no method '${method}'.`,
          );
        }
        return { ok: true, value: await fn.apply(impl, args) };
      } catch (error) {
        return { ok: false, error: toWireError(error) };
      }
    }

    async __claydoKind(): Promise<string | undefined> {
      if (this.#kind !== undefined) return this.#kind;
      const stored = await this.ctx.storage.get<string>(KIND_STORAGE_KEY);
      return stored ?? this.#kindFromName();
    }

    /**
     * PartyServer's `getServerByName()` and the Agents SDK's
     * `getAgentByName()` call this RPC method on the raw stub. They cannot
     * work against a claydo host (they address instances without the kind
     * prefix), so fail with directions instead of the runtime's opaque
     * "receiver does not implement" error.
     */
    async setName(): Promise<never> {
      throw new Error(
        "claydo: this namespace is a claydo host. getServerByName() " +
          "(PartyServer) and getAgentByName() (Agents SDK) are not " +
          "supported here, because they address instances without the " +
          "kind prefix. Use kind(ns, '<kind>').get(name) or " +
          "kinds(ns).<kind>.get(name) instead — see 'Third-party Durable " +
          "Object libraries' in the claydo README.",
      );
    }

    #checkMigrationAuth(secret: string | undefined): void {
      if (options.secret !== undefined && secret !== options.secret) {
        throw new Error(
          "claydo: invalid migration secret (rejected by the claydo " +
            "host's union() options). The same secret must be set on " +
            "exportable(), on union(), and in the driver options.",
        );
      }
    }

    async __claydoImportStatus(secret?: string): Promise<ImportStatus> {
      this.#checkMigrationAuth(secret);
      const persisted = await this.ctx.storage.get<unknown>([
        KIND_STORAGE_KEY,
        IMPORT_STATE_KEY,
      ]);
      const state = persisted.get(IMPORT_STATE_KEY) as ImportState | undefined;
      const kind =
        (persisted.get(KIND_STORAGE_KEY) as string | undefined) ?? this.#kind;
      return {
        kind,
        importing: state
          ? {
              kind: state.kind,
              seq: state.seq,
              cursor: state.cursor,
              ageMs: Date.now() - state.updatedAtMs,
            }
          : undefined,
      };
    }

    #checkImportEnabled(kind: string): void {
      const importable = options.importable ?? false;
      const enabled =
        importable === true ||
        (Array.isArray(importable) && importable.includes(kind));
      if (!enabled) {
        throw new Error(
          `claydo: imports are not enabled for kind '${kind}'. Pass ` +
            `{ importable: true } or { importable: ["${kind}"] } to union().`,
        );
      }
      if (!(kind in kinds)) {
        throw new Error(
          `claydo: unknown kind '${kind}'. Registered kinds: ` +
            `${Object.keys(kinds).join(", ")}.`,
        );
      }
    }

    async __claydoBeginImport(
      kind: string,
      token: string,
      secret?: string,
    ): Promise<ImportBegin> {
      this.#checkMigrationAuth(secret);
      this.#checkImportEnabled(kind);
      if (this.#impl !== undefined) {
        throw new Error(
          `claydo: instance '${this.#identity()}' is live as kind ` +
            `'${this.#kind}'. Imports only target untouched instances.`,
        );
      }
      const persisted = await this.ctx.storage.get<unknown>([
        KIND_STORAGE_KEY,
        IMPORT_STATE_KEY,
      ]);
      const pinned = persisted.get(KIND_STORAGE_KEY) as string | undefined;
      if (pinned !== undefined) {
        throw new Error(
          `claydo: instance '${this.#identity()}' is already live as kind ` +
            `'${pinned}'. Imports only target untouched instances. If racing ` +
            `traffic polluted this instance, wipe it with wipeTarget() from ` +
            `claydo/migrate.`,
        );
      }
      const nameKind = this.#kindFromName();
      if (nameKind !== undefined && nameKind !== kind) {
        throw new Error(
          `claydo: the target name '${this.ctx.id.name}' implies kind ` +
            `'${nameKind}', but the import declares kind '${kind}'.`,
        );
      }
      const state = persisted.get(IMPORT_STATE_KEY) as ImportState | undefined;
      if (state !== undefined) {
        if (state.kind !== kind) {
          throw new Error(
            `claydo: an import of kind '${state.kind}' is in progress on ` +
              `instance '${this.#identity()}'; cannot import kind '${kind}'.`,
          );
        }
        const ageMs = Date.now() - state.updatedAtMs;
        if (state.token !== token && ageMs < IMPORT_STALE_MS) {
          // A refusal is a normal outcome of correct concurrency, so it
          // travels as a value instead of polluting logs with a throw.
          return { ok: false, reason: "owned", ageMs };
        }
        // Adopt: same driver retrying, or a stale import from a crashed one.
        state.token = token;
        state.updatedAtMs = Date.now();
        await this.ctx.storage.put(IMPORT_STATE_KEY, state);
        return {
          ok: true,
          seq: state.seq,
          cursor: state.cursor,
          resumed: state.seq > 0,
        };
      }
      const fresh: ImportState = {
        kind,
        seq: 0,
        cursor: null,
        applied: { kv: 0, rows: {} },
        token,
        updatedAtMs: Date.now(),
      };
      await this.ctx.storage.put(IMPORT_STATE_KEY, fresh);
      return { ok: true, seq: 0, cursor: null, resumed: false };
    }

    async __claydoImport(
      kind: string,
      chunk: ExportChunk,
      seq: number,
      token: string,
      secret?: string,
    ): Promise<ImportAck> {
      this.#checkMigrationAuth(secret);
      this.#checkImportEnabled(kind);
      const state = await this.ctx.storage.get<ImportState>(IMPORT_STATE_KEY);
      if (state === undefined) {
        throw new Error(
          `claydo: no import is reserved on instance '${this.#identity()}'. ` +
            `Call __claydoBeginImport first (migrateInstance does this ` +
            `automatically).`,
        );
      }
      if (state.kind !== kind) {
        throw new Error(
          `claydo: an import of kind '${state.kind}' is in progress on ` +
            `instance '${this.#identity()}'; cannot import kind '${kind}'.`,
        );
      }
      if (state.token !== token) {
        throw new Error(
          `claydo: this import is owned by another migration driver ` +
            `(instance '${this.#identity()}').`,
        );
      }
      if (seq <= state.seq) {
        return { seq, alreadyApplied: true, done: false, applied: state.applied };
      }
      if (seq !== state.seq + 1) {
        throw new Error(
          `claydo: out-of-order import chunk on instance ` +
            `'${this.#identity()}': expected seq ${state.seq + 1}, got ${seq}.`,
        );
      }

      const sql = this.ctx.storage.sql;
      for (const table of chunk.tables ?? []) {
        sql.exec(table.ddl);
      }
      if (chunk.rows !== undefined) {
        const { table, columns, values, rowid } = chunk.rows;
        // When the rowid travels as an explicit `__rowid__` first column,
        // insert it as `rowid`. When a column aliases the rowid (INTEGER
        // PRIMARY KEY), the column itself carries it, wherever it sits.
        const cols =
          rowid === "__rowid__"
            ? ["rowid", ...columns.slice(1).map(quoteIdent)]
            : columns.map(quoteIdent);
        const statement =
          `INSERT INTO ${quoteIdent(table)} (${cols.join(", ")}) ` +
          `VALUES (${cols.map(() => "?").join(", ")})`;
        for (const row of values) {
          sql.exec(statement, ...(row as SqlValue[]));
        }
        state.applied.rows[table] =
          (state.applied.rows[table] ?? 0) + values.length;
      }
      if (chunk.kv !== undefined && chunk.kv.length > 0) {
        await this.ctx.storage.put(Object.fromEntries(chunk.kv));
        state.applied.kv += chunk.kv.length;
      }
      state.seq = seq;
      state.cursor = chunk.cursor;
      state.updatedAtMs = Date.now();

      if (chunk.cursor !== null) {
        await this.ctx.storage.put(IMPORT_STATE_KEY, state);
        return { seq, alreadyApplied: false, done: false, applied: state.applied };
      }

      // Final chunk: replay post DDL, restore sequences, verify, go live.
      for (const ddl of chunk.post ?? []) {
        sql.exec(ddl);
      }
      for (const [name, value] of chunk.sequences ?? []) {
        try {
          // `sqlite_sequence` has no unique constraint, so replace by hand.
          sql.exec(`DELETE FROM sqlite_sequence WHERE name = ?`, name);
          sql.exec(
            `INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`,
            name,
            value,
          );
        } catch {
          // No AUTOINCREMENT table was created; nothing to restore.
        }
      }
      if (chunk.totals !== undefined) {
        // Report zero-row tables in the summary too.
        for (const table of Object.keys(chunk.totals.rows)) {
          state.applied.rows[table] ??= 0;
        }
        const mismatches: string[] = [];
        if (chunk.totals.kv !== state.applied.kv) {
          mismatches.push(
            `kv: expected ${chunk.totals.kv}, applied ${state.applied.kv}`,
          );
        }
        for (const [table, count] of Object.entries(chunk.totals.rows)) {
          const applied = state.applied.rows[table] ?? 0;
          if (applied !== count) {
            mismatches.push(
              `table '${table}': expected ${count} rows, applied ${applied}`,
            );
          }
        }
        if (mismatches.length > 0) {
          await this.ctx.storage.put(IMPORT_STATE_KEY, state);
          throw new Error(
            `claydo: import verification failed on instance ` +
              `'${this.#identity()}': ${mismatches.join("; ")}. The driver ` +
              `aborts and rolls back automatically.`,
          );
        }
      }
      if (typeof chunk.alarm === "number") {
        await this.ctx.storage.setAlarm(
          Math.max(chunk.alarm, Date.now() + 1000),
        );
      }
      await this.ctx.storage.delete(IMPORT_STATE_KEY);
      await this.ctx.storage.put(KIND_STORAGE_KEY, kind);
      return { seq, alreadyApplied: false, done: true, applied: state.applied };
    }

    async __claydoAbortImport(token: string, secret?: string): Promise<boolean> {
      this.#checkMigrationAuth(secret);
      const state = await this.ctx.storage.get<ImportState>(IMPORT_STATE_KEY);
      if (state === undefined) return false;
      if (state.token !== token) {
        throw new Error(
          `claydo: cannot abort an import owned by another migration driver ` +
            `(instance '${this.#identity()}'). Use wipeTarget() to force.`,
        );
      }
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return true;
    }

    async __claydoReset(confirmId: string, secret?: string): Promise<void> {
      this.#checkMigrationAuth(secret);
      if (options.importable === undefined || options.importable === false) {
        throw new Error(
          "claydo: __claydoReset requires imports to be enabled on union().",
        );
      }
      const identity = this.#identity();
      if (confirmId !== identity) {
        throw new Error(
          `claydo: reset confirmation mismatch: expected '${identity}', ` +
            `got '${confirmId}'. Pass the exact instance name or id.`,
        );
      }
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this.#kind = undefined;
      this.#impl = undefined;
      this.#loading = undefined;
    }

    async fetch(request: Request): Promise<Response> {
      let impl: KindHandlers;
      try {
        impl = await this.#load(
          request.headers.get(KIND_HEADER) ?? undefined,
          request.headers.get(NO_INIT_HEADER) === null,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        if (
          (error as { code?: unknown } | null)?.code === "claydo_importing"
        ) {
          // Transient: a migration is filling this instance right now.
          return new Response(message, {
            status: 503,
            headers: { "retry-after": "2" },
          });
        }
        return new Response(message, { status: 400 });
      }
      if (typeof impl.fetch !== "function") {
        return new Response(
          `claydo: kind '${this.#kind}' does not implement fetch().`,
          { status: 501 },
        );
      }
      return impl.fetch(request);
    }

    /**
     * Run one forwarded handler. Errors from these paths have no direct
     * caller, so log them with kind and instance context before rethrowing.
     */
    async #forward(
      handler: string,
      run: (impl: object & KindHandlers) => unknown,
    ): Promise<void> {
      try {
        const impl = await this.#load();
        await run(impl);
      } catch (error) {
        console.error(
          `claydo: ${handler} failed on kind ` +
            `'${this.#kind ?? "?"}' instance '${this.#identity()}':`,
          error,
        );
        throw error;
      }
    }

    async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
      await this.#forward("alarm()", (impl) => impl.alarm?.(alarmInfo));
    }

    async webSocketMessage(
      ws: WebSocket,
      message: string | ArrayBuffer,
    ): Promise<void> {
      await this.#forward("webSocketMessage()", (impl) =>
        impl.webSocketMessage?.(ws, message),
      );
    }

    async webSocketClose(
      ws: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> {
      await this.#forward("webSocketClose()", (impl) =>
        impl.webSocketClose?.(ws, code, reason, wasClean),
      );
    }

    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
      await this.#forward("webSocketError()", (impl) =>
        impl.webSocketError?.(ws, error),
      );
    }
  }

  return GenericDurableObject as unknown as GenericDurableObjectClass<R>;
}

/**
 * Returns the logical name of the current instance, without the `<kind>:`
 * prefix. Returns `undefined` for instances created with `newUniqueId()` or
 * accessed with `idFromString()`.
 *
 * Safe to call anywhere in a kind implementation, including its constructor:
 * kinds construct lazily on first contact, after `ctx.id.name` is available.
 */
export function instanceName(ctx: DurableObjectState): string | undefined {
  const name = ctx.id.name;
  if (name === undefined) return undefined;
  const separator = name.indexOf(":");
  return separator === -1 ? name : name.slice(separator + 1);
}

/**
 * Clears all storage of the current instance but keeps its kind pinned.
 *
 * Use this instead of `ctx.storage.deleteAll()` inside a kind. A raw
 * `deleteAll()` also deletes the persisted kind marker, which turns
 * unique-ID instances into kind-less husks.
 */
export async function resetStorage(ctx: DurableObjectState): Promise<void> {
  const kind = await ctx.storage.get<string>(KIND_STORAGE_KEY);
  await ctx.storage.deleteAll();
  if (kind !== undefined) {
    await ctx.storage.put(KIND_STORAGE_KEY, kind);
  }
}
