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

/** The facet role of a starting instance, when it has one. */
export interface FacetRole {
  identity: FacetIdentity;
  /** True when the identity came from storage rather than props. */
  persisted: boolean;
}

/**
 * Interprets a starting instance's props. Returns the facet role, or
 * `undefined` for the supervisor role.
 *
 * The runtime gives unconfigured instances an empty props object, so
 * absent, null, and empty props normally mean supervisor. Empty props on
 * an instance whose storage holds a persisted facet identity mean the
 * runtime started an existing facet without replaying its startup props
 * (for example on a hibernation wake); the identity restores the facet
 * role. Props that claydo did not write are a configuration error, never
 * a silent role guess.
 */
export function readFacetIdentity(
  ctx: DurableObjectState,
): FacetRole | undefined {
  const props = (ctx as { props?: unknown }).props;
  const empty =
    props === undefined ||
    props === null ||
    (typeof props === "object" && Object.keys(props).length === 0);
  if (empty) {
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
    return isFacetIdentity(identity)
      ? { identity, persisted: true }
      : undefined;
  }
  if (isFacetIdentity(props)) return { identity: props, persisted: false };
  throw claydoError(
    "CLAYDO_CONFIG",
    "the union class reserves ctx.props to select between its supervisor " +
      "and facet roles. Do not configure props on this class.",
  );
}

/** Methods that `call()` refuses to dispatch. */
const RESERVED_METHODS = new Set<string>([
  ...RESERVED_LIFECYCLE_METHODS,
  ...RESERVED_STUB_KEYS,
  "constructor",
]);

/** The supervisor methods that back the facet's alarm API. */
interface AlarmBridge {
  __claydoSetAlarm(kind: string, time: number): Promise<void>;
  __claydoGetAlarm(
    kind: string,
    options?: DurableObjectGetAlarmOptions,
  ): Promise<number | null>;
  __claydoDeleteAlarm(kind: string): Promise<void>;
}

/** Quotes an SQLite identifier. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
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
 * serialization failure. Non-Error throwables that cannot clone become
 * plain Errors carrying their string form.
 */
function wireSafeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) {
    if (isCloneable(error)) return error;
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

function isCloneable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
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
 * The methods are replaced in place on the real storage object, so
 * references captured in a kind constructor behave the same as `this.ctx`.
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

  const replacements: Record<string, unknown> = {
    setAlarm: (scheduledTime: number | Date): Promise<void> => {
      assertOutsideTransaction();
      const time =
        scheduledTime instanceof Date
          ? scheduledTime.getTime()
          : scheduledTime;
      return bridge().__claydoSetAlarm(kind, time);
    },
    getAlarm: (
      options?: DurableObjectGetAlarmOptions,
    ): Promise<number | null> => {
      assertOutsideTransaction();
      return bridge().__claydoGetAlarm(kind, options);
    },
    deleteAlarm: (): Promise<void> => {
      assertOutsideTransaction();
      return bridge().__claydoDeleteAlarm(kind);
    },
    put: (key: unknown, ...rest: unknown[]): unknown => {
      assertWritableKeys(key);
      return (nativePut as (...args: unknown[]) => unknown)(key, ...rest);
    },
    delete: (key: unknown, ...rest: unknown[]): unknown => {
      assertWritableKeys(key);
      return (nativeDelete as (...args: unknown[]) => unknown)(key, ...rest);
    },
    transaction: <T>(
      closure: (txn: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> =>
      nativeTransaction(async (txn) => {
        transactionDepth += 1;
        try {
          return await closure(
            new Proxy(txn, {
              get(target, property) {
                if (
                  property === "setAlarm" ||
                  property === "getAlarm" ||
                  property === "deleteAlarm"
                ) {
                  return rejectAlarmInTransaction;
                }
                const value = Reflect.get(target, property, target);
                if (typeof value !== "function") return value;
                if (property === "put" || property === "delete") {
                  return (key: unknown, ...rest: unknown[]): unknown => {
                    assertWritableKeys(key);
                    return (value as (...args: unknown[]) => unknown).call(
                      target,
                      key,
                      ...rest,
                    );
                  };
                }
                return value.bind(target);
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
    put: (key: unknown, ...rest: unknown[]): unknown => {
      assertWritableKeys(key);
      return (nativeKvPut as (...args: unknown[]) => unknown)(key, ...rest);
    },
    delete: (key: unknown): unknown => {
      assertWritableKeys(key);
      return nativeKvDelete(key as string);
    },
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
  readonly #onStart: (instance: object) => void | Promise<void>;
  #implLoading?: Promise<object & KindHandlers>;

  constructor(
    ctx: DurableObjectState,
    env: unknown,
    identity: FacetIdentity,
    persisted: boolean,
    kinds: KindRegistry,
    options: UnionOptions,
  ) {
    this.#ctx = ctx;
    this.#env = env;
    this.#identity = identity;
    this.#kinds = kinds;
    this.#onStart = options.onStart ?? defaultOnStart;
    // Persist the facet's identity under the one reserved key in the
    // kind's key-value store, so the facet can select its role even when
    // the runtime starts it without props.
    if (!persisted) {
      ctx.storage.kv.put(FACET_IDENTITY_KEY, identity);
    }
    adaptFacetStorage(ctx, identity.kind, () => this.#hostBridge());
    // The kind implementation gets a clean context: the props are a claydo
    // detail, not part of the kind's contract.
    try {
      Object.defineProperty(ctx, "props", {
        value: undefined,
        configurable: true,
      });
    } catch {
      // A frozen context still works; the kind just sees the props.
    }
  }

  #instanceIdentity(): string {
    return this.#ctx.id.name ?? this.#ctx.id.toString();
  }

  /**
   * The supervisor loopback for alarm relays. Resolved on every call:
   * `get()` is cheap, and a memoized stub would go stale if the
   * supervisor object resets while this facet stays live.
   */
  #hostBridge(): AlarmBridge {
    const exported = (
      this.#ctx.exports as unknown as Record<string, unknown>
    )[this.#identity.host] as
      | { get?: (id: DurableObjectId) => AlarmBridge }
      | undefined;
    if (typeof exported?.get !== "function") {
      throw claydoError(
        "CLAYDO_CONFIG",
        `cannot find the union export '${this.#identity.host}' from ` +
          `inside a kind facet. Keep the class returned by union() ` +
          `exported under that name.`,
      );
    }
    return exported.get(this.#ctx.id);
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
    await this.#onStart(impl);
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
