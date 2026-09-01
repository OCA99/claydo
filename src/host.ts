import { DurableObject as CloudflareDurableObject } from "cloudflare:workers";
import {
  DEFAULT_IMPORT_LIMITS,
  IMPORT_STALE_MS,
  IMPORT_CHECKPOINT_KEY,
  IMPORT_STATE_KEY,
  quoteIdent,
  type ExportChunk,
  type ImportAck,
  type ImportBegin,
  type ImportCheckpoint,
  type ImportLimits,
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
  RESERVED_LIFECYCLE_METHODS,
  RESERVED_STUB_KEYS,
  type ClaydoFacetProps,
  type KindHandlers,
  type KindRegistry,
} from "./types";

const RESERVED_METHODS = new Set<string>(RESERVED_LIFECYCLE_METHODS);

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
    try {
      const value = (error as unknown as Record<string, unknown>)[key];
      structuredClone(value);
      props[key] = value;
    } catch {
      // Skip throwing getters and non-cloneable fields.
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
  __claydoApplyImport(
    chunk: ExportChunk,
    seq: number,
    migrationId: string,
  ): Promise<boolean>;
  __claydoImportCheckpoint(): Promise<ImportCheckpoint | undefined>;
  __claydoRemoveImportCheckpoint(): Promise<void>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

type AlarmInfoWire = Pick<
  AlarmInvocationInfo,
  "isRetry" | "retryCount" | "scheduledTime"
>;

const IMPORT_FACET_PREFIX = "import:";
const IMPORT_RECEIPT_KEY = "__claydo:import-receipt";
const RESET_STATE_KEY = "__claydo:reset";

interface ImportReceipt {
  kind: string;
  migrationId: string;
  token: string;
  seq: number;
  applied: { kv: number; rows: Record<string, number> };
  cleanupPending: boolean;
}

interface ResetState {
  kinds: string[];
}

function importFacetName(kind: string): string {
  return `${IMPORT_FACET_PREFIX}${kind}`;
}

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
  __claydoSetAlarm(
    kind: string,
    timestamp: number,
    options?: DurableObjectSetAlarmOptions,
  ): Promise<void>;
  __claydoGetAlarm(
    kind: string,
    options?: DurableObjectGetAlarmOptions,
  ): Promise<number | null>;
  __claydoDeleteAlarm(
    kind: string,
    options?: DurableObjectSetAlarmOptions,
  ): Promise<void>;
  __claydoBeginImport(
    kind: string,
    token: string,
    secret?: string,
    limits?: ImportLimits,
    migrationId?: string,
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
    readonly #methodCache = new Map<
      string,
      (...args: unknown[]) => unknown
    >();
    readonly #facetClasses = new Map<string, DurableObjectClass>();
    #importTail: Promise<void> = Promise.resolve();

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

    #facets(): DurableObjectFacets {
      const facets = (
        this.ctx as DurableObjectState & {
          facets?: DurableObjectFacets;
        }
      ).facets;
      if (facets === undefined || typeof facets.get !== "function") {
        throw new Error(
          "claydo: this Workers runtime does not support Durable Object " +
            "facets. Use a current compatibility date (the examples use " +
            "2026-08-01) and current Workers runtime.",
        );
      }
      return facets;
    }

    #namedFacet(kind: string, name: string): FacetRuntimeStub {
      const facets = this.#facets();
      let configured = this.#facetClasses.get(name);
      if (configured === undefined) {
        const hostClass = this.#hostClass();
        const props: ClaydoFacetProps = {
          __claydoFacet: true,
          kind,
          hostExport: this.#hostExport(),
        };
        configured = hostClass({ props });
        this.#facetClasses.set(name, configured);
      }
      return facets.get(name, () => ({
        class: configured,
      })) as unknown as FacetRuntimeStub;
    }

    #facet(kind: string): FacetRuntimeStub {
      return this.#namedFacet(kind, kindFacetName(kind));
    }

    #importFacet(kind: string): FacetRuntimeStub {
      return this.#namedFacet(kind, importFacetName(kind));
    }

    #deleteKindFacets(kind: string): void {
      const facets = this.#facets();
      facets.delete(kindFacetName(kind));
      facets.delete(importFacetName(kind));
    }

    #kindFromName(): string | undefined {
      const name = this.ctx.id.name;
      if (name === undefined) return undefined;
      const separator = name.indexOf(":");
      if (separator === -1) return undefined;
      const prefix = name.slice(0, separator);
      return Object.prototype.hasOwnProperty.call(kinds, prefix)
        ? prefix
        : undefined;
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
      await this.#recoverReset();
      const persisted = await this.ctx.storage.get<unknown>([
        KIND_STORAGE_KEY,
        IMPORT_STATE_KEY,
        IMPORT_RECEIPT_KEY,
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
      if (!Object.prototype.hasOwnProperty.call(kinds, kind)) {
        throw new Error(
          `claydo: unknown kind '${kind}' on instance ` +
            `'${this.#identity()}'. Registered kinds: ` +
            `${Object.keys(kinds).join(", ")}.`,
        );
      }
      if (stored === undefined) {
        await this.ctx.storage.put(KIND_STORAGE_KEY, kind);
      } else {
        await this.#cleanupImportArtifacts(
          kind,
          persisted.get(IMPORT_RECEIPT_KEY) as ImportReceipt | undefined,
        );
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
      const adaptedContext = facetContext(this.ctx, this.#facetProps!);
      const impl = new Kind(this.ctx, this.env) as object & KindHandlers;
      // Recommended claydo kinds already receive this context from their
      // base class. Reinstalling it also makes normal DurableObject and
      // framework classes use the supervisor-backed alarm API after their
      // constructor has completed.
      try {
        Object.defineProperty(impl, "ctx", {
          value: adaptedContext,
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
        let fn = this.#methodCache.get(method);
        if (fn === undefined) {
          fn = prototypeMethod(impl, method);
          if (fn !== undefined) this.#methodCache.set(method, fn);
        }
        if (fn === undefined) {
          const value = (impl as Record<string, unknown>)[method];
          if (method in impl && typeof value !== "function") {
            throw new Error(
              `claydo: '${method}' on kind '${kind}' is a property, not a ` +
                `method (type: ${typeof value}). The stub only proxies methods; ` +
                `add a getter method to read it.`,
            );
          }
          if (method in impl && typeof value === "function") {
            throw new Error(
              `claydo: '${method}' on kind '${kind}' is a function-valued ` +
                `instance field, not a prototype method. Workers RPC exposes ` +
                `prototype methods only.`,
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
      return (await this.#facet(resolved).__claydoCall(
        resolved,
        method,
        args,
        allowInit,
      )) as ClaydoCallResult;
    }

    async __claydoKind(): Promise<string | undefined> {
      if (this.#facetProps !== undefined) return this.#facetProps.kind;
      if (await this.#recoverReset()) return undefined;
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

    async __claydoSetAlarm(
      kind: string,
      timestamp: number,
      alarmOptions?: DurableObjectSetAlarmOptions,
    ): Promise<void> {
      await this.#assertAlarmKind(kind);
      await this.ctx.storage.setAlarm(timestamp, alarmOptions);
    }

    async __claydoGetAlarm(
      kind: string,
      alarmOptions?: DurableObjectGetAlarmOptions,
    ): Promise<number | null> {
      await this.#assertAlarmKind(kind);
      return this.ctx.storage.getAlarm(alarmOptions);
    }

    async __claydoDeleteAlarm(
      kind: string,
      alarmOptions?: DurableObjectSetAlarmOptions,
    ): Promise<void> {
      await this.#assertAlarmKind(kind);
      await this.ctx.storage.deleteAlarm(alarmOptions);
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
      if (!Object.prototype.hasOwnProperty.call(kinds, kind)) {
        throw new Error(
          `claydo: unknown kind '${kind}'. Registered kinds: ` +
            `${Object.keys(kinds).join(", ")}.`,
        );
      }
    }

    async __claydoImportStatus(secret?: string): Promise<ImportStatus> {
      this.#checkMigrationAuth(secret);
      await this.#recoverReset();
      const persisted = await this.ctx.storage.get<unknown>([
        KIND_STORAGE_KEY,
        IMPORT_STATE_KEY,
        IMPORT_RECEIPT_KEY,
      ]);
      const state = persisted.get(IMPORT_STATE_KEY) as ImportState | undefined;
      const kind =
        (persisted.get(KIND_STORAGE_KEY) as string | undefined) ?? this.#kind;
      const receipt = persisted.get(IMPORT_RECEIPT_KEY) as
        | ImportReceipt
        | undefined;
      if (kind !== undefined && state === undefined) {
        await this.#cleanupImportArtifacts(kind, receipt);
      }
      return {
        kind,
        completed:
          receipt === undefined
            ? undefined
            : {
                kind: receipt.kind,
                seq: receipt.seq,
                migrationId: receipt.migrationId,
              },
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

    async #cleanupImportArtifacts(
      kind: string,
      receipt: ImportReceipt | undefined,
    ): Promise<void> {
      if (receipt?.cleanupPending !== true) return;
      await this.#facet(kind).__claydoRemoveImportCheckpoint();
      this.#facets().delete(importFacetName(kind));
      receipt.cleanupPending = false;
      await this.ctx.storage.put(IMPORT_RECEIPT_KEY, receipt);
    }

    async __claydoBeginImport(
      kind: string,
      token: string,
      secret?: string,
      limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
      migrationId = crypto.randomUUID(),
    ): Promise<ImportBegin> {
      return this.#withImportLock(() =>
        this.#beginImport(kind, token, secret, limits, migrationId),
      );
    }

    async #beginImport(
      kind: string,
      token: string,
      secret?: string,
      limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
      migrationId = crypto.randomUUID(),
    ): Promise<ImportBegin> {
      this.#checkMigrationAuth(secret);
      this.#checkImportEnabled(kind);
      await this.#recoverReset();
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
        const checkpoint =
          await this.#importFacet(kind).__claydoImportCheckpoint();
        const hasMigrationId = typeof state.migrationId === "string";
        if (
          checkpoint?.seq !== state.seq ||
          checkpoint?.migrationId !== state.migrationId
        ) {
          state.restartRequired = true;
        }
        state.token = token;
        state.migrationId = hasMigrationId
          ? state.migrationId
          : migrationId;
        state.updatedAtMs = Date.now();
        await this.ctx.storage.put(IMPORT_STATE_KEY, state);
        const hasLimits = state.limits !== undefined;
        return {
          ok: true,
          seq: state.seq,
          cursor: state.cursor,
          resumed: state.seq > 0 || (checkpoint?.seq ?? 0) > 0,
          limits: hasLimits ? state.limits : DEFAULT_IMPORT_LIMITS,
          restartRequired:
            state.restartRequired || !hasLimits || !hasMigrationId,
          migrationId: state.migrationId,
        };
      }
      // A previous failed import may have left an unreferenced facet after a
      // runtime interruption. Facet deletion is isolated and cannot touch
      // supervisor metadata or another kind.
      this.#deleteKindFacets(kind);
      const fresh: ImportState = {
        kind,
        migrationId,
        seq: 0,
        cursor: null,
        applied: { kv: 0, rows: {} },
        token,
        limits,
        restartRequired: false,
        updatedAtMs: Date.now(),
      };
      await this.ctx.storage.put(IMPORT_STATE_KEY, fresh);
      return {
        ok: true,
        seq: 0,
        cursor: null,
        resumed: false,
        limits,
        restartRequired: false,
        migrationId,
      };
    }

    async __claydoImport(
      kind: string,
      chunk: ExportChunk,
      seq: number,
      token: string,
      secret?: string,
    ): Promise<ImportAck> {
      return this.#withImportLock(() =>
        this.#applyImport(kind, chunk, seq, token, secret),
      );
    }

    async #withImportLock<T>(run: () => Promise<T>): Promise<T> {
      const previous = this.#importTail;
      let release!: () => void;
      this.#importTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await run();
      } finally {
        release();
      }
    }

    async #applyImport(
      kind: string,
      chunk: ExportChunk,
      seq: number,
      token: string,
      secret?: string,
    ): Promise<ImportAck> {
      this.#checkMigrationAuth(secret);
      this.#checkImportEnabled(kind);
      await this.#recoverReset();
      const state = await this.ctx.storage.get<ImportState>(IMPORT_STATE_KEY);
      if (state === undefined) {
        const persisted = await this.ctx.storage.get<unknown>([
          KIND_STORAGE_KEY,
          IMPORT_RECEIPT_KEY,
        ]);
        const pinned = persisted.get(KIND_STORAGE_KEY) as string | undefined;
        const receipt = persisted.get(IMPORT_RECEIPT_KEY) as
          | ImportReceipt
          | undefined;
        if (
          pinned === kind &&
          chunk.cursor === null &&
          receipt?.kind === kind &&
          receipt.token === token &&
          receipt.seq === seq
        ) {
          return {
            seq,
            alreadyApplied: true,
            done: true,
            applied: receipt.applied,
          };
        }
        throw new Error(
          `claydo: no import is reserved on instance '${this.#identity()}'. ` +
            `Call __claydoBeginImport first (migrateInstance does this ` +
            `automatically).`,
        );
      }
      if (state.kind !== kind || state.token !== token) {
        throw Object.assign(
          new Error(
            `claydo: this import is owned by another migration driver.`,
          ),
          { code: "CLAYDO_IMPORT_OWNED" },
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

      let facetApplied: boolean;
      try {
        facetApplied = await this.#importFacet(kind).__claydoApplyImport(
          chunk,
          seq,
          state.migrationId,
        );
      } catch (error) {
        if (chunk.cursor === null) {
          state.restartRequired = true;
          state.cursor = null;
          state.updatedAtMs = Date.now();
          await this.ctx.storage.put(IMPORT_STATE_KEY, state);
        }
        throw error;
      }
      if (chunk.rows !== undefined) {
        state.applied.rows[chunk.rows.table] =
          (state.applied.rows[chunk.rows.table] ?? 0) +
          chunk.rows.values.length;
      }
      if (chunk.kv !== undefined) {
        state.applied.kv += chunk.kv.length;
      }
      state.seq = seq;
      state.cursor = chunk.cursor;
      state.updatedAtMs = Date.now();

      if (chunk.cursor !== null) {
        await this.ctx.storage.put(IMPORT_STATE_KEY, state);
        return {
          seq,
          alreadyApplied: !facetApplied,
          done: false,
          applied: state.applied,
        };
      }

      if (chunk.totals !== undefined) {
        for (const table of Object.keys(chunk.totals.rows)) {
          state.applied.rows[table] ??= 0;
        }
      }
      // Traffic is blocked by IMPORT_STATE_KEY, so replacing a clone left by
      // an interrupted finalization is safe. The staging checkpoint remains
      // present until supervisor publication commits, so a replay cannot
      // re-run final DDL.
      this.#facets().delete(kindFacetName(kind));
      this.#facets().clone(importFacetName(kind), kindFacetName(kind));
      // Kind visibility, import-state removal, and alarm transfer commit
      // atomically in supervisor storage after the facet verifies its final
      // chunk. A crash cannot expose a live kind without its alarm or leave
      // a live kind blocked by stale import metadata.
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put(KIND_STORAGE_KEY, kind);
        await txn.delete(IMPORT_STATE_KEY);
        await txn.put(IMPORT_RECEIPT_KEY, {
          kind,
          migrationId: state.migrationId,
          token,
          seq,
          applied: state.applied,
          cleanupPending: true,
        } satisfies ImportReceipt);
        if (typeof chunk.alarm === "number") {
          await txn.setAlarm(Math.max(chunk.alarm, Date.now() + 1000));
        } else {
          await txn.deleteAlarm();
        }
      });
      this.#kind = kind;
      await this.#facet(kind).__claydoRemoveImportCheckpoint();
      this.#facets().delete(importFacetName(kind));
      await this.ctx.storage.put(IMPORT_RECEIPT_KEY, {
        kind,
        migrationId: state.migrationId,
        token,
        seq,
        applied: state.applied,
        cleanupPending: false,
      } satisfies ImportReceipt);
      return {
        seq,
        alreadyApplied: !facetApplied,
        done: true,
        applied: state.applied,
      };
    }

    async __claydoAbortImport(
      token: string,
      secret?: string,
    ): Promise<boolean> {
      return this.#withImportLock(() => this.#abortImport(token, secret));
    }

    async #abortImport(
      token: string,
      secret?: string,
    ): Promise<boolean> {
      this.#checkMigrationAuth(secret);
      await this.#recoverReset();
      const state = await this.ctx.storage.get<ImportState>(IMPORT_STATE_KEY);
      if (state === undefined) return false;
      if (state.token !== token) {
        throw Object.assign(
          new Error(
            `claydo: cannot abort an import owned by another migration driver. ` +
              `Use wipeTarget() to force.`,
          ),
          { code: "CLAYDO_IMPORT_OWNED" },
        );
      }
      this.#deleteKindFacets(state.kind);
      await this.ctx.storage.delete(IMPORT_STATE_KEY);
      await this.ctx.storage.deleteAlarm();
      return true;
    }

    async __claydoReset(
      confirmId: string,
      secret?: string,
    ): Promise<void> {
      this.#checkMigrationAuth(secret);
      await this.#recoverReset();
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
      const resetKinds = [...new Set(
        [pinned, importing?.kind, nameKind].filter(
          (value): value is string => value !== undefined,
        ),
      )];
      await this.ctx.storage.transaction(async (txn) => {
        await txn.put(RESET_STATE_KEY, { kinds: resetKinds } satisfies ResetState);
        await txn.deleteAlarm();
      });
      await this.#recoverReset();
      this.#kind = undefined;
      this.#kindLoading = undefined;
    }

    async #recoverReset(): Promise<boolean> {
      const reset = await this.ctx.storage.get<ResetState>(RESET_STATE_KEY);
      if (reset === undefined) return false;
      for (const kind of reset.kinds) {
        this.#deleteKindFacets(kind);
      }
      await this.ctx.storage.deleteAll();
      this.#kind = undefined;
      this.#kindLoading = undefined;
      return true;
    }

    async __claydoApplyImport(
      chunk: ExportChunk,
      seq: number,
      migrationId: string,
    ): Promise<boolean> {
      if (this.#facetProps === undefined) {
        throw new Error("claydo: import chunks can only apply inside a facet.");
      }
      const current =
        this.ctx.storage.kv.get<ImportCheckpoint>(IMPORT_CHECKPOINT_KEY);
      if (
        current !== undefined &&
        current.migrationId !== migrationId
      ) {
        throw new Error(
          `claydo: staging facet belongs to migration ` +
            `'${current.migrationId}', not '${migrationId}'.`,
        );
      }
      if (seq <= (current?.seq ?? 0)) {
        if (chunk.cursor === null && chunk.totals !== undefined) {
          this.#verifyImportTotals(chunk.totals);
          this.#verifyImportForeignKeys();
        }
        return false;
      }
      if (
        chunk.kv?.some(([key]) => key === IMPORT_CHECKPOINT_KEY) === true
      ) {
        throw new Error(
          `claydo: old instance uses reserved staging key ` +
            `'${IMPORT_CHECKPOINT_KEY}'. Rename it before migrating.`,
        );
      }
      // Parent and child tables can arrive in different chunks. Enforce
      // referential integrity after the complete snapshot is present.
      this.ctx.storage.sql.exec("PRAGMA foreign_keys = OFF");
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        for (const table of chunk.tables ?? []) {
          sql.exec(table.ddl);
        }
        if (chunk.rows !== undefined) {
          const { table, columns, values, rowid } = chunk.rows;
          const cols =
            rowid === "__rowid__"
              ? ["rowid", ...columns.slice(1).map(quoteIdent)]
              : columns.map(quoteIdent);
          const rowsPerStatement = Math.max(
            1,
            Math.floor(100 / cols.length),
          );
          for (let offset = 0; offset < values.length; offset += rowsPerStatement) {
            const batch = values.slice(offset, offset + rowsPerStatement);
            const tuple = `(${cols.map(() => "?").join(", ")})`;
            const statement =
              `INSERT INTO ${quoteIdent(table)} (${cols.join(", ")}) ` +
              `VALUES ${batch.map(() => tuple).join(", ")}`;
            sql.exec(statement, ...(batch.flat() as SqlValue[]));
          }
        }
        for (const [key, value] of chunk.kv ?? []) {
          this.ctx.storage.kv.put(key, value);
        }
        if (chunk.cursor === null) {
          for (const ddl of chunk.post ?? []) {
            sql.exec(ddl);
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
        }
        this.ctx.storage.kv.put(IMPORT_CHECKPOINT_KEY, {
          migrationId,
          seq,
        } satisfies ImportCheckpoint);
      });

      if (chunk.totals !== undefined) {
        this.#verifyImportTotals(chunk.totals);
        this.#verifyImportForeignKeys();
      }
      return true;
    }

    async __claydoImportCheckpoint(): Promise<
      ImportCheckpoint | undefined
    > {
      if (this.#facetProps === undefined) {
        throw new Error("claydo: import checkpoint is only available in a facet.");
      }
      return this.ctx.storage.kv.get<ImportCheckpoint>(IMPORT_CHECKPOINT_KEY);
    }

    #verifyImportTotals(
      totals: NonNullable<ExportChunk["totals"]>,
    ): void {
      const mismatches: string[] = [];
      let kv = 0;
      for (const [key] of this.ctx.storage.kv.list()) {
        if (key !== IMPORT_CHECKPOINT_KEY) kv += 1;
      }
      if (kv !== totals.kv) {
        mismatches.push(`kv: expected ${totals.kv}, applied ${kv}`);
      }
      for (const [table, expected] of Object.entries(totals.rows)) {
        const actual = this.ctx.storage.sql
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

    #verifyImportForeignKeys(): void {
      const violations = this.ctx.storage.sql
        .exec(`PRAGMA foreign_key_check`)
        .toArray();
      if (violations.length > 0) {
        throw new Error(
          `claydo: import verification failed: ${violations.length} ` +
            `foreign key violation(s).`,
        );
      }
      this.ctx.storage.sql.exec("PRAGMA foreign_keys = ON");
    }

    async __claydoRemoveImportCheckpoint(): Promise<void> {
      if (this.#facetProps === undefined) {
        throw new Error("claydo: import cleanup is only available in a facet.");
      }
      this.ctx.storage.kv.delete(IMPORT_CHECKPOINT_KEY);
    }

    async fetch(request: Request): Promise<Response> {
      if (this.#facetProps !== undefined) {
        try {
          const impl = await this.#loadImpl();
          if (typeof impl.fetch !== "function") {
            return new Response(
              `claydo: kind '${this.#facetProps.kind}' does not implement fetch().`,
              { status: 501 },
            );
          }
          return await impl.fetch(request);
        } catch (error) {
          console.error(
            `claydo: fetch failed on kind '${this.#facetProps.kind}' ` +
              `instance '${this.#identity()}':`,
            error,
          );
          return new Response("claydo: kind request failed.", { status: 500 });
        }
      }
      let kind: string;
      try {
        kind = await this.#resolveKind(
          request.headers.get(KIND_HEADER) ?? undefined,
          request.headers.get(NO_INIT_HEADER) === null,
        );
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
      return this.#facet(kind).fetch(request);
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
      if (await this.#recoverReset()) return;
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
    }

    async webSocketMessage(
      ws: WebSocket,
      message: string | ArrayBuffer,
    ): Promise<void> {
      if (this.#facetProps !== undefined) {
        await this.__claydoWebSocketMessage(ws, message);
        return;
      }
      // Root/supervisor sockets are not part of the facet-native topology,
      // and WebSocket objects cannot cross facet RPC. Close defensively
      // instead of attempting an impossible forwarding call.
      ws.close(1012, "claydo: reconnect through the facet endpoint");
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
      // Facet-owned sockets receive this callback directly on the facet.
    }

    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
      if (this.#facetProps !== undefined) {
        await this.__claydoWebSocketError(ws, error);
        return;
      }
      // Facet-owned sockets receive this callback directly on the facet.
    }
  }

  return GenericDurableObject as unknown as GenericDurableObjectClass<R>;
}

function prototypeMethod(
  instance: object,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  let prototype: object | null = Object.getPrototypeOf(instance);
  while (prototype !== null && prototype !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor !== undefined) {
      return typeof descriptor.value === "function"
        ? (descriptor.value as (...args: unknown[]) => unknown)
        : undefined;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
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
              `named '${key}'. The stub reserves that name for metadata or ` +
              `control flow, so the method would not be callable. Rename it.`,
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
 * Clears facet-local kind storage. The isolated supervisor keeps kind
 * identity intact.
 */
export async function resetStorage(ctx: DurableObjectState): Promise<void> {
  await ctx.storage.deleteAll();
}
