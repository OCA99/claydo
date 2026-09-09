import { claydoError } from "./errors";
import {
  FACET_IDENTITY_KEY,
  isFacetIdentity,
  RESERVED_LIFECYCLE_METHODS,
  RESERVED_STUB_KEYS,
  type AlarmInfo,
  type FacetIdentity,
  type KindHandlers,
  type KindRegistry,
} from "./types";
import type { UnionOptions } from "./supervisor";

/** Methods that `call()` refuses to dispatch. */
const RESERVED_METHODS = new Set<string>([
  ...RESERVED_LIFECYCLE_METHODS,
  ...RESERVED_STUB_KEYS,
  "constructor",
]);

/** Storage methods that relay to the supervisor's alarm bridge. */
const ALARM_METHODS = new Set(["setAlarm", "getAlarm", "deleteAlarm"]);

/** Storage methods that write keys and must protect the reserved key. */
const KEYED_WRITE_METHODS = new Set(["put", "delete"]);

/** The supervisor methods that back the facet's alarm API. */
interface AlarmBridge {
  __claydoSetAlarm(kind: string, time: number): Promise<void>;
  __claydoGetAlarm(
    kind: string,
    options?: DurableObjectGetAlarmOptions,
  ): Promise<number | null>;
  __claydoDeleteAlarm(kind: string): Promise<void>;
}

/** The facet role of a starting instance, when it has one. */
export interface FacetRole {
  identity: FacetIdentity;
  /** The kind's own props: the startup props minus claydo's field. */
  kindProps: Record<string, unknown> | undefined;
  /** True when the identity came from storage rather than props. */
  persisted: boolean;
}

/**
 * Interprets a starting instance's props. Returns the facet role, or
 * `undefined` for the supervisor role.
 *
 * Claydo's identity travels under the one reserved props field
 * (`__claydo`); all other props belong to the application and pass
 * through. Props without the reserved field mean supervisor — unless the
 * instance's storage holds a persisted facet identity, which means the
 * runtime started an existing facet without replaying its startup props
 * (for example on a hibernation wake). A malformed reserved field is a
 * configuration error, never a silent role guess.
 */
export function readFacetIdentity(
  ctx: DurableObjectState,
): FacetRole | undefined {
  const props = (ctx as { props?: unknown }).props;
  const record =
    typeof props === "object" && props !== null
      ? (props as Record<string, unknown>)
      : undefined;
  const branded = record?.[FACET_IDENTITY_KEY];
  if (branded === undefined) {
    const kv = (ctx.storage as { kv?: DurableObjectStorage["kv"] } | undefined)
      ?.kv;
    if (kv === undefined || typeof kv.get !== "function") {
      throw claydoError(
        "CLAYDO_CONFIG",
        "this class requires the SQLite storage backend. List it in " +
          "new_sqlite_classes (not new_classes) in the wrangler " +
          "configuration.",
      );
    }
    const identity = kv.get<unknown>(FACET_IDENTITY_KEY);
    if (!isFacetIdentity(identity)) return undefined;
    const storedProps = (identity as { props?: unknown }).props;
    return {
      identity,
      kindProps:
        typeof storedProps === "object" && storedProps !== null
          ? (storedProps as Record<string, unknown>)
          : undefined,
      persisted: true,
    };
  }
  if (!isFacetIdentity(branded)) {
    throw claydoError(
      "CLAYDO_CONFIG",
      `the union class reserves the '${FACET_IDENTITY_KEY}' props field ` +
        `for its role selection. Do not configure that field.`,
    );
  }
  const kindProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record!)) {
    if (key !== FACET_IDENTITY_KEY) kindProps[key] = value;
  }
  return {
    identity: branded,
    kindProps: Object.keys(kindProps).length > 0 ? kindProps : undefined,
    persisted: false,
  };
}

/** Quotes an SQLite identifier. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Releases a per-call loopback stub handle once its call settled. */
function disposeStub(stub: unknown): void {
  const disposeSymbol = (Symbol as { dispose?: symbol }).dispose;
  if (disposeSymbol === undefined) return;
  const dispose = (stub as Record<symbol, unknown>)[disposeSymbol];
  if (typeof dispose === "function") {
    try {
      (dispose as (this: unknown) => void).call(stub);
    } catch {
      // Never let handle cleanup mask the call's own outcome.
    }
  }
}

function rejectReservedKey(): never {
  throw claydoError(
    "CLAYDO_CONFIG",
    `the key '${FACET_IDENTITY_KEY}' is reserved: it holds this facet's ` +
      `identity. Choose another key name.`,
  );
}

function assertWritableKeys(key: unknown): void {
  if (key === FACET_IDENTITY_KEY) rejectReservedKey();
  if (Array.isArray(key) && key.includes(FACET_IDENTITY_KEY)) {
    rejectReservedKey();
  }
  if (
    typeof key === "object" &&
    key !== null &&
    !Array.isArray(key) &&
    Object.hasOwn(key, FACET_IDENTITY_KEY)
  ) {
    rejectReservedKey();
  }
}

/**
 * Facet-local replacement for `storage.deleteAll()`.
 *
 * The Workers runtime does not implement native `deleteAll()` inside a
 * facet yet, so claydo drops the kind's schema and key-value data
 * explicitly, in one synchronous transaction. The facet's identity record
 * survives.
 */
function deleteAllFacetStorage(
  storage: DurableObjectStorage,
  transactionSync: <T>(closure: () => T) => T,
  kvDelete: (key: string) => void,
): void {
  transactionSync(() => {
    // Defer foreign key checks until commit, after every table is gone.
    // The whole reset rolls back if any drop fails, so partial destruction
    // is not observable.
    storage.sql.exec("PRAGMA defer_foreign_keys = ON");
    const schema = storage.sql
      .exec<{ type: string; name: string }>(
        `SELECT type, name FROM sqlite_master
         WHERE type IN ('view', 'table')
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
         ORDER BY CASE type WHEN 'view' THEN 0 ELSE 1 END, name`,
      )
      .toArray();
    for (const { type, name } of schema) {
      storage.sql.exec(
        `${type === "view" ? "DROP VIEW" : "DROP TABLE"} IF EXISTS ${quoteIdent(name)}`,
      );
    }
    for (const [key] of [...storage.kv.list()]) {
      if (key === FACET_IDENTITY_KEY) continue;
      kvDelete(key);
    }
  });
}

/**
 * Returns an error that survives RPC serialization. Errors whose own
 * fields (and `cause`) all clone pass through unchanged; anything else is
 * rebuilt with its name, message, stack, and every cloneable field, so
 * the caller always receives the real error instead of an opaque
 * serialization failure. Non-Error throwables become plain Errors
 * carrying their string form: Workers RPC tunnels Errors specially, and
 * raw values have no defined delivery.
 */
function wireSafeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  const fields = new Map<string, unknown>();
  let dirty = false;
  // `cause` is non-enumerable but serializes over RPC; probe it too.
  const keys = [...Object.keys(error)];
  if ("cause" in error && !keys.includes("cause")) keys.push("cause");
  for (const key of keys) {
    try {
      let value = (error as unknown as Record<string, unknown>)[key];
      if (key === "cause" && value instanceof Error && depth < 3) {
        const safe = wireSafeError(value, depth + 1);
        if (safe !== value) {
          value = safe;
          dirty = true;
        }
      }
      structuredClone(value);
      fields.set(key, value);
    } catch {
      // A throwing getter or a non-cloneable value: drop the field.
      dirty = true;
    }
  }
  if (!dirty) return error;
  const safe = new Error(error.message);
  safe.name = error.name;
  if (error.stack !== undefined) safe.stack = error.stack;
  for (const [key, value] of fields) {
    if (key === "cause") {
      Object.defineProperty(safe, "cause", { value, configurable: true });
    } else {
      (safe as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return safe;
}

/**
 * Rewires the facet's own storage object so the kind gets the normal
 * Durable Object storage API:
 *
 * - Alarm methods relay to the supervisor, because a facet has no native
 *   alarm of its own. Alarm state lives with the instance, so an alarm
 *   write is not atomic with the facet's data writes. Claydo therefore
 *   rejects alarm calls inside transactions instead of losing atomicity
 *   silently.
 * - `deleteAll()` clears the kind's tables and key-value data explicitly.
 * - Writes to the reserved identity key are rejected.
 *
 * The same interception sets drive the storage object and the transaction
 * proxy, so the two surfaces cannot diverge. The methods are replaced in
 * place on the real storage object, so references captured in a kind
 * constructor behave the same as `this.ctx`.
 */
function adaptFacetStorage(
  ctx: DurableObjectState,
  kind: string,
  bridge: () => AlarmBridge,
): void {
  const storage = ctx.storage;
  const nativeTransaction = storage.transaction.bind(storage);
  const nativeTransactionSync = storage.transactionSync.bind(storage);
  const nativePut = storage.put.bind(storage);
  const nativeDelete = storage.delete.bind(storage);
  const nativeKvPut = storage.kv.put.bind(storage.kv);
  const nativeKvDelete = storage.kv.delete.bind(storage.kv);
  let transactionDepth = 0;

  const rejectAlarmInTransaction = (): never => {
    throw claydoError(
      "CLAYDO_ALARM_IN_TRANSACTION",
      "alarm operations inside a storage transaction cannot be atomic " +
        "with the kind's data writes, because alarm state lives with the " +
        "instance, outside the kind's database. Commit the transaction, " +
        "then call the alarm method.",
    );
  };
  const assertOutsideTransaction = (): void => {
    if (transactionDepth > 0) rejectAlarmInTransaction();
  };
  const guardedWrite =
    (write: (...args: unknown[]) => unknown) =>
    (key: unknown, ...rest: unknown[]): unknown => {
      assertWritableKeys(key);
      return write(key, ...rest);
    };

  const withBridge = async <T>(
    run: (host: AlarmBridge) => Promise<T>,
  ): Promise<T> => {
    const host = bridge();
    try {
      return await run(host);
    } finally {
      disposeStub(host);
    }
  };
  const replacements: Record<string, unknown> = {
    setAlarm: (scheduledTime: number | Date): Promise<void> => {
      assertOutsideTransaction();
      const time =
        scheduledTime instanceof Date
          ? scheduledTime.getTime()
          : scheduledTime;
      return withBridge((host) => host.__claydoSetAlarm(kind, time));
    },
    getAlarm: (
      options?: DurableObjectGetAlarmOptions,
    ): Promise<number | null> => {
      assertOutsideTransaction();
      return withBridge((host) => host.__claydoGetAlarm(kind, options));
    },
    deleteAlarm: (): Promise<void> => {
      assertOutsideTransaction();
      return withBridge((host) => host.__claydoDeleteAlarm(kind));
    },
    put: guardedWrite(nativePut as (...args: unknown[]) => unknown),
    delete: guardedWrite(nativeDelete as (...args: unknown[]) => unknown),
    transaction: <T>(
      closure: (txn: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> =>
      nativeTransaction(async (txn) => {
        transactionDepth += 1;
        try {
          return await closure(
            new Proxy(txn, {
              get(target, property) {
                if (typeof property === "string") {
                  if (ALARM_METHODS.has(property)) {
                    return rejectAlarmInTransaction;
                  }
                  if (KEYED_WRITE_METHODS.has(property)) {
                    const value = Reflect.get(target, property, target) as (
                      ...args: unknown[]
                    ) => unknown;
                    return guardedWrite(value.bind(target));
                  }
                }
                const value = Reflect.get(target, property, target);
                return typeof value === "function"
                  ? value.bind(target)
                  : value;
              },
            }),
          );
        } finally {
          transactionDepth -= 1;
        }
      }),
    transactionSync: <T>(closure: () => T): T =>
      nativeTransactionSync(() => {
        transactionDepth += 1;
        try {
          return closure();
        } finally {
          transactionDepth -= 1;
        }
      }),
    deleteAll: async (): Promise<void> => {
      deleteAllFacetStorage(storage, nativeTransactionSync, nativeKvDelete);
    },
  };
  for (const [name, value] of Object.entries(replacements)) {
    Object.defineProperty(storage, name, { value, configurable: true });
  }
  const kvReplacements: Record<string, unknown> = {
    put: guardedWrite(nativeKvPut as (...args: unknown[]) => unknown),
    delete: guardedWrite(nativeKvDelete as (...args: unknown[]) => unknown),
  };
  for (const [name, value] of Object.entries(kvReplacements)) {
    Object.defineProperty(storage.kv, name, { value, configurable: true });
  }
}

/** Finds `name` as a prototype method of `instance`. */
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

/**
 * Finds the property descriptor of `name` anywhere on `instance` or its
 * prototype chain, without invoking getters.
 */
function findDescriptor(
  instance: object,
  name: string,
): PropertyDescriptor | undefined {
  let target: object | null = instance;
  while (target !== null && target !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor !== undefined) return descriptor;
    target = Object.getPrototypeOf(target);
  }
  return undefined;
}

/** The default start hook: PartyServer and the Agents SDK defer their
 * setup to `__unsafe_ensureInitialized()`. */
async function defaultOnStart(instance: object): Promise<void> {
  const ensure = (instance as Record<string, unknown>)[
    "__unsafe_ensureInitialized"
  ];
  if (typeof ensure === "function") {
    await (ensure as (this: object) => unknown).call(instance);
  }
}

/**
 * The facet role of a union instance. One isolated kind facet: it
 * constructs the kind implementation, forwards lifecycle events to it, and
 * dispatches RPC methods on it.
 */
export class FacetCore {
  readonly #ctx: DurableObjectState;
  readonly #env: unknown;
  readonly #identity: FacetIdentity;
  readonly #kinds: KindRegistry;
  readonly #options: UnionOptions;
  readonly #className: () => string;
  readonly #kindProps: Record<string, unknown> | undefined;
  readonly #rawKvPut: (key: string, value: unknown) => void;
  #implLoading?: Promise<object & KindHandlers>;

  constructor(
    ctx: DurableObjectState,
    env: unknown,
    role: FacetRole,
    kinds: KindRegistry,
    options: UnionOptions,
    className: () => string,
  ) {
    this.#ctx = ctx;
    this.#env = env;
    this.#identity = role.identity;
    this.#kinds = kinds;
    this.#options = options;
    this.#className = className;
    this.#kindProps = role.kindProps;
    this.#rawKvPut = ctx.storage.kv.put.bind(ctx.storage.kv);
    // Persist the facet's identity (and the kind's own props, so a
    // propless wake restores them too) under the one reserved key.
    if (!role.persisted) {
      this.#rawKvPut(FACET_IDENTITY_KEY, this.#identityRecord());
    }
    adaptFacetStorage(ctx, role.identity.kind, () => this.#hostBridge());
    // The kind sees its own props: the startup props minus claydo's
    // reserved field.
    try {
      Object.defineProperty(ctx, "props", {
        value: role.kindProps,
        configurable: true,
      });
    } catch {
      // A frozen context still works; the kind just sees the raw props.
    }
  }

  #instanceIdentity(): string {
    return this.#ctx.id.name ?? this.#ctx.id.toString();
  }

  #identityRecord(host = this.#identity.host): FacetIdentity {
    return {
      ...this.#identity,
      host,
      ...(this.#kindProps !== undefined ? { props: this.#kindProps } : {}),
    } as FacetIdentity;
  }

  /**
   * The current export name of the union class. The current code (the
   * `name` option or the exported class's own name) wins over the
   * persisted identity, so an export rename does not strand facets woken
   * from storage with the old name.
   */
  #hostExport(): string {
    return this.#options.name ?? this.#className();
  }

  /**
   * The supervisor loopback for alarm relays. Resolved on every call:
   * `get()` is cheap, and a memoized stub would go stale if the
   * supervisor object resets while this facet stays live.
   */
  #hostBridge(): AlarmBridge {
    const exports = this.#ctx.exports as unknown as Record<string, unknown>;
    const current = this.#hostExport();
    const candidates =
      current === this.#identity.host
        ? [current]
        : [current, this.#identity.host];
    for (const host of candidates) {
      const exported = exports[host] as
        | { get?: (id: DurableObjectId) => AlarmBridge }
        | undefined;
      if (typeof exported?.get === "function") {
        if (host !== this.#identity.host) {
          // The export was renamed; refresh the persisted identity so
          // later propless wakes resolve directly.
          this.#rawKvPut(FACET_IDENTITY_KEY, this.#identityRecord(host));
        }
        return exported.get(this.#ctx.id);
      }
    }
    throw claydoError(
      "CLAYDO_CONFIG",
      `cannot find the union export '${current}' from inside a kind ` +
        `facet. Keep the class returned by union() exported under that ` +
        `name, or pass its export name to union() as { name: "..." }.`,
    );
  }

  #load(): Promise<object & KindHandlers> {
    return (this.#implLoading ??= this.#construct().catch((error) => {
      this.#implLoading = undefined;
      throw error;
    }));
  }

  async #construct(): Promise<object & KindHandlers> {
    const kind = this.#identity.kind;
    const Kind = this.#kinds[kind];
    if (Kind === undefined) {
      throw claydoError(
        "CLAYDO_UNKNOWN_KIND",
        `this facet hosts kind '${kind}', which is not in the registry. ` +
          `Registered kinds: ${Object.keys(this.#kinds).join(", ")}.`,
      );
    }
    const impl = new Kind(this.#ctx, this.#env) as object & KindHandlers;
    await (this.#options.onStart ?? defaultOnStart)(impl);
    return impl;
  }

  async call(
    kind: string,
    method: string,
    args: unknown[],
    _init: boolean,
  ): Promise<unknown> {
    if (kind !== this.#identity.kind) {
      throw claydoError(
        "CLAYDO_KIND_MISMATCH",
        `this facet is kind '${this.#identity.kind}', not '${kind}'.`,
        { actualKind: this.#identity.kind, expectedKind: kind },
      );
    }
    try {
      return await this.#dispatch(kind, method, args);
    } catch (error) {
      throw wireSafeError(error);
    }
  }

  async #dispatch(
    kind: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const impl = await this.#load();
    if (
      typeof method !== "string" ||
      method.startsWith("__") ||
      RESERVED_METHODS.has(method)
    ) {
      throw claydoError(
        "CLAYDO_NO_METHOD",
        `'${method}' is reserved and is not callable through the stub.`,
      );
    }
    const fn = prototypeMethod(impl, method);
    if (fn === undefined) {
      // Diagnose through descriptors: a getter must not run on a failed
      // dispatch, and its exception must not replace this error.
      const descriptor = findDescriptor(impl, method);
      if (descriptor !== undefined) {
        if (descriptor.get !== undefined || descriptor.set !== undefined) {
          throw claydoError(
            "CLAYDO_NO_METHOD",
            `'${method}' on kind '${kind}' is an accessor property, not a ` +
              `method. The stub only proxies methods; add a regular ` +
              `method to read it.`,
          );
        }
        if (typeof descriptor.value === "function") {
          throw claydoError(
            "CLAYDO_NO_METHOD",
            `'${method}' on kind '${kind}' is a function-valued instance ` +
              `field, not a prototype method. Workers RPC exposes ` +
              `prototype methods only; declare it as a class method.`,
          );
        }
        throw claydoError(
          "CLAYDO_NO_METHOD",
          `'${method}' on kind '${kind}' is a property, not a method ` +
            `(type: ${typeof descriptor.value}). The stub only proxies ` +
            `methods; add a getter method to read it.`,
        );
      }
      throw claydoError(
        "CLAYDO_NO_METHOD",
        `kind '${kind}' has no method '${method}'.`,
      );
    }
    return fn.apply(impl, args);
  }

  /** Logs background failures with identity before rethrowing: these
   * paths have no application caller to report through. */
  #logBackgroundFailure(handler: string, error: unknown): void {
    console.error(
      `claydo: ${handler} failed on kind '${this.#identity.kind}' ` +
        `instance '${this.#instanceIdentity()}':`,
      error,
    );
  }

  async deliverAlarm(info: AlarmInfo): Promise<void> {
    try {
      const impl = await this.#load();
      if (typeof impl.alarm !== "function") {
        console.error(
          `claydo: kind '${this.#identity.kind}' instance ` +
            `'${this.#instanceIdentity()}' received an alarm but defines ` +
            `no alarm() handler; the alarm is dropped.`,
        );
        return;
      }
      await impl.alarm(info as unknown as AlarmInvocationInfo);
    } catch (error) {
      this.#logBackgroundFailure("alarm()", error);
      throw wireSafeError(error);
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const impl = await this.#load();
      if (typeof impl.fetch !== "function") {
        return new Response(
          `claydo: kind '${this.#identity.kind}' does not implement fetch().`,
          { status: 501 },
        );
      }
      return await impl.fetch(request);
    } catch (error) {
      throw wireSafeError(error);
    }
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    try {
      const impl = await this.#load();
      await impl.webSocketMessage?.(ws, message);
    } catch (error) {
      this.#logBackgroundFailure("webSocketMessage()", error);
      throw wireSafeError(error);
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    try {
      const impl = await this.#load();
      await impl.webSocketClose?.(ws, code, reason, wasClean);
    } catch (error) {
      this.#logBackgroundFailure("webSocketClose()", error);
      throw wireSafeError(error);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    try {
      const impl = await this.#load();
      await impl.webSocketError?.(ws, error);
    } catch (handlerError) {
      this.#logBackgroundFailure("webSocketError()", handlerError);
      throw wireSafeError(handlerError);
    }
  }
}
