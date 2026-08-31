import { DurableObject as CloudflareDurableObject } from "cloudflare:workers";
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
  facetContext,
  facetProps,
  kindFacetName,
  KIND_HEADER,
  KIND_STORAGE_KEY,
  NO_INIT_HEADER,
  type ClaydoFacetProps,
  type KindHandlers,
  type KindRegistry,
} from "./types";

const RESERVED_METHODS = new Set([
  "constructor",
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);
const RESERVED_STUB_KEYS = ["id", "name", "kind", "stub"] as const;

/** A serializable error snapshot carried through the claydo RPC envelope. */
export interface WireError {
  name: string;
  message: string;
  stack?: string;
  props?: Record<string, unknown>;
}

/** The result envelope of a dispatched kind RPC call. */
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
      // Non-cloneable error fields cannot cross Workers RPC.
    }
  }
  if (Object.keys(props).length > 0) wire.props = props;
  return wire;
}

interface FacetRuntimeStub {
  __claydoCall(
    kind: string,
    method: string,
    args: unknown[],
    allowInit?: boolean,
  ): Promise<ClaydoCallResult>;
  __claydoAlarm(alarmInfo?: AlarmInfoWire): Promise<void>;
  __claydoWebSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void>;
  __claydoWebSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
  __claydoWebSocketError(ws: WebSocket, error: unknown): Promise<void>;
  __claydoApplyImport(chunk: ExportChunk): Promise<void>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

type AlarmInfoWire = Pick<
  AlarmInvocationInfo,
  "isRetry" | "retryCount" | "scheduledTime"
>;

interface LoopbackHostClass {
  (options: { props?: unknown }): DurableObjectClass;
  get(
    id: DurableObjectId,
    options?: DurableObjectNamespaceGetDurableObjectOptions,
  ): GenericDurableObjectInstance<KindRegistry>;
}

/** The instance type of the class returned by {@link union}. */
export interface GenericDurableObjectInstance<R extends KindRegistry>
  extends Rpc.DurableObjectBranded {
  readonly __kinds: R;
  ctx: DurableObjectState;
  env: unknown;
  __claydoCall(
    kind: string,
    method: string,
    args: unknown[],
    allowInit?: boolean,
  ): Promise<ClaydoCallResult>;
  __claydoKind(): Promise<string | undefined>;
  __claydoSetAlarm(kind: string, timestamp: number): Promise<void>;
  __claydoGetAlarm(kind: string): Promise<number | null>;
  __claydoDeleteAlarm(kind: string): Promise<void>;
  __claydoFacetReset(kind: string): Promise<void>;
  __claydoBeginImport(
    kind: string,
    token: string,
    secret?: string,
  ): Promise<ImportBegin>;
  __claydoImport(
    kind: string,
    chunk: ExportChunk,
    seq: number,
    token: string,
    secret?: string,
  ): Promise<ImportAck>;
  __claydoImportStatus(secret?: string): Promise<ImportStatus>;
  __claydoAbortImport(token: string, secret?: string): Promise<boolean>;
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

/** The constructor type returned by {@link union}. */
export type GenericDurableObjectClass<R extends KindRegistry> = new (
  ctx: DurableObjectState,
  env: any,
) => GenericDurableObjectInstance<R>;

/** Options for {@link union}. */
export interface UnionOptions<R extends KindRegistry> {
  importable?: boolean | (keyof R & string)[];
  secret?: string;
  /**
   * Overrides the top-level export name used to obtain the facet class from
   * `ctx.exports`. Normally inferred from the exported subclass name.
   */
  exportName?: string;
}

/**
 * Creates one supervisor Durable Object class that hosts every kind in an
 * isolated Durable Object facet.
 *
 * The exported class is both supervisor and facet runtime. This is why one
 * binding and one SQLite migration still cover every kind: the supervisor
 * obtains its own class handle from `ctx.exports`, configures it with
 * `{ props: { kind } }`, and starts one isolated facet per instance.
 */
export function union<R extends KindRegistry>(
  kinds: R,
  options: UnionOptions<R> = {},
): GenericDurableObjectClass<R> {
  validateRegistry(kinds);

  class GenericDurableObject extends CloudflareDurableObject<any> {
    declare readonly __kinds: R;
    readonly #facetProps: ClaydoFacetProps | undefined;
    #kind?: string;
    #kindLoading?: Promise<string>;
    #impl?: object & KindHandlers;
    #implLoading?: Promise<object & KindHandlers>;

    constructor(ctx: DurableObjectState, env: unknown) {
      super(ctx, env);
      this.#facetProps = facetProps(ctx);
    }

    #identity(): string {
      return this.ctx.id.name ?? this.ctx.id.toString();
    }

    #hostExport(): string {
      return (
        this.#facetProps?.hostExport ??
        options.exportName ??
        this.constructor.name
      );
    }

    #hostClass(): LoopbackHostClass {
      const name = this.#hostExport();
      const exported = (this.ctx.exports as unknown as Record<string, unknown>)[
        name
      ] as LoopbackHostClass | undefined;
      if (
        exported === undefined ||
        typeof exported !== "function" ||
        typeof exported.get !== "function"
      ) {
        throw new Error(
          `claydo: cannot find Durable Object export '${name}' in ` +
            `ctx.exports. Export the union() subclass under that name, or ` +
            `pass { exportName: "YourExport" } to union().`,
        );
      }
      return exported;
    }

    #facet(kind: string): FacetRuntimeStub {
      const hostClass = this.#hostClass();
      const props: ClaydoFacetProps = {
        __claydoFacet: true,
        kind,
        hostExport: this.#hostExport(),
      };
      const configured = hostClass({ props });
      return this.ctx.facets.get(kindFacetName(kind), () => ({
        class: configured,
      })) as unknown as FacetRuntimeStub;
    }

    #kindFromName(): string | undefined {
      const name = this.ctx.id.name;
      if (name === undefined) return undefined;
      const separator = name.indexOf(":");
      if (separator === -1) return undefined;
      const prefix = name.slice(0, separator);
      return prefix in kinds ? prefix : undefined;
    }

    async #resolveKind(hint?: string, allowInit = true): Promise<string> {
      if (this.#facetProps !== undefined) return this.#facetProps.kind;
      if (this.#kind === undefined) {
        this.#kindLoading ??= this.#initializeKind(hint, allowInit).catch(
          (error) => {
            this.#kindLoading = undefined;
            throw error;
          },
        );
        this.#kind = await this.#kindLoading;
      }
      if (hint !== undefined && hint !== this.#kind) {
        throw Object.assign(
          new Error(
            `claydo: instance '${this.#identity()}' is kind ` +
              `'${this.#kind}', but the caller expected kind '${hint}'.`,
          ),
          {
            code: "CLAYDO_KIND_MISMATCH",
            actualKind: this.#kind,
            expectedKind: hint,
          },
        );
      }
      return this.#kind;
    }

    async #initializeKind(
      hint: string | undefined,
      allowInit: boolean,
    ): Promise<string> {
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
          { code: "CLAYDO_IMPORTING" },
        );
      }
      const stored = persisted.get(KIND_STORAGE_KEY) as string | undefined;
      const kind =
        stored ?? this.#kindFromName() ?? (allowInit ? hint : undefined);
      if (kind === undefined) {
        throw new Error(this.#noKindMessage(hint, allowInit));
      }
      if (!(kind in kinds)) {
        throw new Error(
          `claydo: unknown kind '${kind}' on instance ` +
            `'${this.#identity()}'. Registered kinds: ` +
            `${Object.keys(kinds).join(", ")}.`,
        );
      }
      if (stored === undefined) {
        await this.ctx.storage.put(KIND_STORAGE_KEY, kind);
      }
      return kind;
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
          ` Its name has no registered '<kind>:' prefix. Raw namespace ` +
          `access (for example getByName('${name}')) reaches a different ` +
          `instance than kind(ns, '<kind>').get('${name}'). Access instances ` +
          `through the kind() helper, or use a '<kind>:' prefixed name.`
        );
      }
      return (
        message +
        ` Unique-ID instances initialize on their first call through ` +
        `kind(ns, '<kind>').unique().`
      );
    }

    async #loadImpl(): Promise<object & KindHandlers> {
      if (this.#facetProps === undefined) {
        throw new Error("claydo: kind implementation requested on supervisor.");
      }
      this.#implLoading ??= this.#constructImpl().catch((error) => {
        this.#implLoading = undefined;
        throw error;
      });
      this.#impl = await this.#implLoading;
      return this.#impl;
    }

    async #constructImpl(): Promise<object & KindHandlers> {
      const kind = this.#facetProps!.kind;
      const Kind = kinds[kind];
      if (Kind === undefined) {
        throw new Error(
          `claydo: facet requested unknown kind '${kind}'. Registered kinds: ` +
            `${Object.keys(kinds).join(", ")}.`,
        );
      }
      const impl = new Kind(this.ctx, this.env) as object & KindHandlers;
      // Recommended claydo kinds already receive this context from their
      // base class. Reinstalling it also makes normal DurableObject and
      // framework classes use the supervisor-backed alarm API after their
      // constructor has completed.
      try {
        Object.defineProperty(impl, "ctx", {
          value: facetContext(this.ctx, this.#facetProps!),
          writable: true,
          configurable: true,
        });
      } catch (error) {
        throw new Error(
          `claydo: kind '${kind}' does not allow its ctx property to be ` +
            `adapted for facet alarms. Extend DurableObject from "claydo" ` +
            `or make ctx configurable.`,
          { cause: error },
        );
      }
      const ensure = (impl as Record<string, unknown>)[
        "__unsafe_ensureInitialized"
      ];
      if (typeof ensure === "function") {
        await (ensure as (this: object) => unknown).call(impl);
      }
      return impl;
    }

    async #dispatch(
      kind: string,
      method: string,
      args: unknown[],
    ): Promise<ClaydoCallResult> {
      try {
        const impl = await this.#loadImpl();
        if (
          typeof method !== "string" ||
          method.startsWith("__") ||
          RESERVED_METHODS.has(method)
        ) {
          throw new Error(
            `claydo: method '${method}' is reserved and is not callable ` +
              `through the stub.`,
          );
        }
        const fn = (impl as Record<string, unknown>)[method];
        if (
          typeof fn !== "function" ||
          fn === (Object.prototype as Record<string, unknown>)[method]
        ) {
          if (method in impl && typeof fn !== "function") {
            throw new Error(
              `claydo: '${method}' on kind '${kind}' is a property, not a ` +
                `method (type: ${typeof fn}). The stub only proxies methods; ` +
                `add a getter method to read it.`,
            );
          }
          throw new Error(`claydo: kind '${kind}' has no method '${method}'.`);
        }
        return { ok: true, value: await fn.apply(impl, args) };
      } catch (error) {
        return { ok: false, error: toWireError(error) };
      }
    }

    async __claydoCall(
      kind: string,
      method: string,
      args: unknown[],
      allowInit = true,
    ): Promise<ClaydoCallResult> {
      if (this.#facetProps !== undefined) {
        if (kind !== this.#facetProps.kind) {
          return {
            ok: false,
            error: toWireError(
              new Error(
                `claydo: facet is kind '${this.#facetProps.kind}', not ` +
                  `'${kind}'.`,
              ),
            ),
          };
        }
        return this.#dispatch(kind, method, args);
      }
      let resolved: string;
      try {
        resolved = await this.#resolveKind(kind, allowInit);
      } catch (error) {
        return { ok: false, error: toWireError(error) };
      }
      // Do not envelope transport/serialization failures from the facet:
      // the client distinguishes them and adds kind + method call context.
      const result = (await this.#facet(resolved).__claydoCall(
        resolved,
        method,
        args,
        allowInit,
      )) as ClaydoCallResult;
      await this.#completeFacetReset(resolved);
      return result;
    }

    async __claydoKind(): Promise<string | undefined> {
      if (this.#facetProps !== undefined) return this.#facetProps.kind;
      if (this.#kind !== undefined) return this.#kind;
      const stored = await this.ctx.storage.get<string>(KIND_STORAGE_KEY);
      return stored ?? this.#kindFromName();
    }

    async #assertAlarmKind(kind: string): Promise<void> {
      if (this.#facetProps !== undefined) {
        throw new Error("claydo: alarm bridge called on a facet.");
      }
      const actual = await this.__claydoKind();
      if (actual !== kind) {
        throw new Error(
          `claydo: kind '${kind}' cannot control the alarm for ` +
            `kind '${actual ?? "uninitialized"}'.`,
        );
      }
    }

    async __claydoSetAlarm(kind: string, timestamp: number): Promise<void> {
      await this.#assertAlarmKind(kind);
      await this.ctx.storage.setAlarm(timestamp);
    }

    async __claydoGetAlarm(kind: string): Promise<number | null> {
      await this.#assertAlarmKind(kind);
      return this.ctx.storage.getAlarm();
    }

    async __claydoDeleteAlarm(kind: string): Promise<void> {
      await this.#assertAlarmKind(kind);
      await this.ctx.storage.deleteAlarm();
    }

    async __claydoFacetReset(kind: string): Promise<void> {
      await this.#assertAlarmKind(kind);
      await this.ctx.storage.put("__claydo:reset-facet", kind);
    }

    async #completeFacetReset(kind: string): Promise<void> {
      const requested = await this.ctx.storage.get<string>(
        "__claydo:reset-facet",
      );
      if (requested !== kind) return;
      await this.ctx.storage.delete("__claydo:reset-facet");
      this.ctx.facets.abort(
        kindFacetName(kind),
        new Error("claydo: facet reset completed"),
      );
    }

    async setName(): Promise<never> {
      throw new Error(
        "claydo: this namespace is a claydo host. getServerByName() " +
          "(PartyServer) and getAgentByName() (Agents SDK) are not " +
          "supported because they omit the kind prefix. Use " +
          "kind(ns, '<kind>').get(name) instead.",
      );
    }

    #checkMigrationAuth(secret: string | undefined): void {
      if (options.secret !== undefined && secret !== options.secret) {
        throw new Error(
          "claydo: invalid migration secret (rejected by union() options). " +
            "Use the same secret on exportable(), union(), and the driver.",
        );
      }
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

    async __claydoBeginImport(
      kind: string,
      token: string,
      secret?: string,
    ): Promise<ImportBegin> {
      this.#checkMigrationAuth(secret);
      this.#checkImportEnabled(kind);
      const persisted = await this.ctx.storage.get<unknown>([
        KIND_STORAGE_KEY,
        IMPORT_STATE_KEY,
      ]);
      const pinned = persisted.get(KIND_STORAGE_KEY) as string | undefined;
      if (pinned !== undefined || this.#kind !== undefined) {
        throw new Error(
          `claydo: instance '${this.#identity()}' is live as kind ` +
            `'${pinned ?? this.#kind}'. Imports only target untouched ` +
            `instances. If racing traffic polluted this instance, wipe it ` +
            `with wipeTarget() from claydo/migrate.`,
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
            `claydo: an import of kind '${state.kind}' is already in progress.`,
          );
        }
        const ageMs = Date.now() - state.updatedAtMs;
        if (state.token !== token && ageMs < IMPORT_STALE_MS) {
          return { ok: false, reason: "owned", ageMs };
        }
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
      // A previous failed import may have left an unreferenced facet after a
      // runtime interruption. Facet deletion is isolated and cannot touch
      // supervisor metadata or another kind.
      this.ctx.facets.delete(kindFacetName(kind));
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
      if (state.kind !== kind || state.token !== token) {
        throw new Error(
          `claydo: this import is owned by another migration driver.`,
        );
      }
      if (seq <= state.seq) {
        return { seq, alreadyApplied: true, done: false, applied: state.applied };
      }
      if (seq !== state.seq + 1) {
        throw new Error(
          `claydo: out-of-order import chunk: expected seq ${state.seq + 1}, ` +
            `got ${seq}.`,
        );
      }

      await this.#facet(kind).__claydoApplyImport(chunk);
      if (chunk.rows !== undefined) {
        state.applied.rows[chunk.rows.table] =
          (state.applied.rows[chunk.rows.table] ?? 0) +
          chunk.rows.values.length;
      }
      if (chunk.kv !== undefined) state.applied.kv += chunk.kv.length;
      state.seq = seq;
      state.cursor = chunk.cursor;
      state.updatedAtMs = Date.now();

      if (chunk.cursor !== null) {
        await this.ctx.storage.put(IMPORT_STATE_KEY, state);
        return { seq, alreadyApplied: false, done: false, applied: state.applied };
      }

      if (chunk.totals !== undefined) {
        for (const table of Object.keys(chunk.totals.rows)) {
          state.applied.rows[table] ??= 0;
        }
      }
      // Kind visibility, import-state removal, and alarm transfer commit
      // atomically in supervisor storage after the facet verifies its final
      // chunk. A crash cannot expose a live kind without its alarm or leave
      // a live kind blocked by stale import metadata.
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put(KIND_STORAGE_KEY, kind);
        await txn.delete(IMPORT_STATE_KEY);
        if (typeof chunk.alarm === "number") {
          await txn.setAlarm(Math.max(chunk.alarm, Date.now() + 1000));
        } else {
          await txn.deleteAlarm();
        }
      });
      this.#kind = kind;
      return { seq, alreadyApplied: false, done: true, applied: state.applied };
    }

    async __claydoAbortImport(
      token: string,
      secret?: string,
    ): Promise<boolean> {
      this.#checkMigrationAuth(secret);
      const state = await this.ctx.storage.get<ImportState>(IMPORT_STATE_KEY);
      if (state === undefined) return false;
      if (state.token !== token) {
        throw new Error(
          `claydo: cannot abort an import owned by another migration driver. ` +
            `Use wipeTarget() to force.`,
        );
      }
      this.ctx.facets.delete(kindFacetName(state.kind));
      await this.ctx.storage.delete(IMPORT_STATE_KEY);
      await this.ctx.storage.deleteAlarm();
      return true;
    }

    async __claydoReset(
      confirmId: string,
      secret?: string,
    ): Promise<void> {
      this.#checkMigrationAuth(secret);
      if (options.importable === undefined || options.importable === false) {
        throw new Error(
          "claydo: reset requires imports to be enabled on union().",
        );
      }
      const identity = this.#identity();
      if (confirmId !== identity) {
        throw new Error(
          `claydo: reset confirmation mismatch: expected '${identity}', ` +
            `got '${confirmId}'.`,
        );
      }
      const persisted = await this.ctx.storage.get<unknown>([
        KIND_STORAGE_KEY,
        IMPORT_STATE_KEY,
      ]);
      const pinned = persisted.get(KIND_STORAGE_KEY) as string | undefined;
      const importing = persisted.get(IMPORT_STATE_KEY) as
        | ImportState
        | undefined;
      const nameKind = this.#kindFromName();
      for (const kind of new Set(
        [pinned, importing?.kind, nameKind].filter(
          (value): value is string => value !== undefined,
        ),
      )) {
        this.ctx.facets.delete(kindFacetName(kind));
      }
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this.#kind = undefined;
      this.#kindLoading = undefined;
    }

    async __claydoApplyImport(chunk: ExportChunk): Promise<void> {
      if (this.#facetProps === undefined) {
        throw new Error("claydo: import chunks can only apply inside a facet.");
      }
      const sql = this.ctx.storage.sql;
      for (const table of chunk.tables ?? []) {
        try {
          sql.exec(table.ddl);
        } catch (error) {
          if (!String(error).includes("already exists")) throw error;
        }
      }
      if (chunk.rows !== undefined) {
        const { table, columns, values, rowid } = chunk.rows;
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
      }
      if (chunk.kv !== undefined && chunk.kv.length > 0) {
        await this.ctx.storage.put(Object.fromEntries(chunk.kv));
      }
      if (chunk.cursor !== null) return;

      for (const ddl of chunk.post ?? []) {
        try {
          sql.exec(ddl);
        } catch (error) {
          if (!String(error).includes("already exists")) throw error;
        }
      }
      for (const [name, value] of chunk.sequences ?? []) {
        try {
          sql.exec(`DELETE FROM sqlite_sequence WHERE name = ?`, name);
          sql.exec(
            `INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`,
            name,
            value,
          );
        } catch {
          // No AUTOINCREMENT table exists.
        }
      }
      if (chunk.totals === undefined) return;
      const mismatches: string[] = [];
      const kv = (await this.ctx.storage.list()).size;
      if (kv !== chunk.totals.kv) {
        mismatches.push(`kv: expected ${chunk.totals.kv}, applied ${kv}`);
      }
      for (const [table, expected] of Object.entries(chunk.totals.rows)) {
        const actual = sql
          .exec<{ n: number }>(
            `SELECT count(*) AS n FROM ${quoteIdent(table)}`,
          )
          .one().n;
        if (actual !== expected) {
          mismatches.push(
            `table '${table}': expected ${expected}, applied ${actual}`,
          );
        }
      }
      if (mismatches.length > 0) {
        throw new Error(
          `claydo: import verification failed: ${mismatches.join("; ")}.`,
        );
      }
    }

    async fetch(request: Request): Promise<Response> {
      if (this.#facetProps !== undefined) {
        const impl = await this.#loadImpl();
        if (typeof impl.fetch !== "function") {
          return new Response(
            `claydo: kind '${this.#facetProps.kind}' does not implement fetch().`,
            { status: 501 },
          );
        }
        return impl.fetch(request);
      }
      try {
        const kind = await this.#resolveKind(
          request.headers.get(KIND_HEADER) ?? undefined,
          request.headers.get(NO_INIT_HEADER) === null,
        );
        const response = await this.#facet(kind).fetch(request);
        await this.#completeFacetReset(kind);
        return response;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        if ((error as { code?: unknown } | null)?.code === "CLAYDO_IMPORTING") {
          return new Response(message, {
            status: 503,
            headers: { "retry-after": "2" },
          });
        }
        return new Response(message, { status: 400 });
      }
    }

    async #runHandler(
      name: string,
      run: (impl: object & KindHandlers) => unknown,
    ): Promise<void> {
      try {
        const impl = await this.#loadImpl();
        await run(impl);
      } catch (error) {
        console.error(
          `claydo: ${name} failed on kind ` +
            `'${this.#facetProps?.kind ?? "?"}' instance ` +
            `'${this.#identity()}':`,
          error,
        );
        throw error;
      }
    }

    async __claydoAlarm(alarmInfo?: AlarmInfoWire): Promise<void> {
      await this.#runHandler("alarm()", (impl) => impl.alarm?.(alarmInfo));
    }

    async __claydoWebSocketMessage(
      ws: WebSocket,
      message: string | ArrayBuffer,
    ): Promise<void> {
      await this.#runHandler("webSocketMessage()", (impl) =>
        impl.webSocketMessage?.(ws, message),
      );
    }

    async __claydoWebSocketClose(
      ws: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> {
      await this.#runHandler("webSocketClose()", (impl) =>
        impl.webSocketClose?.(ws, code, reason, wasClean),
      );
    }

    async __claydoWebSocketError(
      ws: WebSocket,
      error: unknown,
    ): Promise<void> {
      await this.#runHandler("webSocketError()", (impl) =>
        impl.webSocketError?.(ws, error),
      );
    }

    async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
      if (this.#facetProps !== undefined) {
        await this.__claydoAlarm(alarmInfo);
        return;
      }
      const kind = await this.#resolveKind();
      await this.#facet(kind).__claydoAlarm(
        alarmInfo === undefined
          ? undefined
          : {
              isRetry: alarmInfo.isRetry,
              retryCount: alarmInfo.retryCount,
              scheduledTime: alarmInfo.scheduledTime,
            },
      );
      await this.#completeFacetReset(kind);
    }

    async webSocketMessage(
      ws: WebSocket,
      message: string | ArrayBuffer,
    ): Promise<void> {
      if (this.#facetProps !== undefined) {
        await this.__claydoWebSocketMessage(ws, message);
        return;
      }
      const kind = await this.#resolveKind();
      await this.#facet(kind).__claydoWebSocketMessage(ws, message);
    }

    async webSocketClose(
      ws: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> {
      if (this.#facetProps !== undefined) {
        await this.__claydoWebSocketClose(ws, code, reason, wasClean);
        return;
      }
      const kind = await this.#resolveKind();
      await this.#facet(kind).__claydoWebSocketClose(
        ws,
        code,
        reason,
        wasClean,
      );
    }

    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
      if (this.#facetProps !== undefined) {
        await this.__claydoWebSocketError(ws, error);
        return;
      }
      const kind = await this.#resolveKind();
      await this.#facet(kind).__claydoWebSocketError(ws, error);
    }
  }

  return GenericDurableObject as unknown as GenericDurableObjectClass<R>;
}

function validateRegistry(kinds: KindRegistry): void {
  for (const [name, Kind] of Object.entries(kinds)) {
    if (name.includes(":") || name.startsWith("__") || name.length === 0) {
      throw new Error(
        `claydo: invalid kind name '${name}'. Kind names must be non-empty, ` +
          `must not contain ':', and must not start with '__'.`,
      );
    }
    let proto: object | null = Kind.prototype as object;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of RESERVED_STUB_KEYS) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (descriptor && typeof descriptor.value === "function") {
          throw new Error(
            `claydo: kind '${name}' (class ${Kind.name}) defines a method ` +
              `named '${key}'. The stub reserves ` +
              `'${RESERVED_STUB_KEYS.join("', '")}' for metadata, so this ` +
              `method would not be callable. Rename the method.`,
          );
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
  }
}

/** Returns the logical instance name without its `<kind>:` prefix. */
export function instanceName(ctx: DurableObjectState): string | undefined {
  const name = ctx.id.name;
  if (name === undefined) return undefined;
  const separator = name.indexOf(":");
  return separator === -1 ? name : name.slice(separator + 1);
}

/**
 * Clears all kind storage. The kind pin lives in the isolated supervisor,
 * so unlike the pre-facet architecture, a normal `deleteAll()` is safe.
 */
export async function resetStorage(ctx: DurableObjectState): Promise<void> {
  await ctx.storage.deleteAll();
}
