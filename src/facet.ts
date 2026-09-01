import { claydoError } from "./errors";
import {
  FACET_IDENTITY_KEY,
  isFacetIdentity,
  RESERVED_LIFECYCLE_METHODS,
  RESERVED_STUB_KEYS,
  type AlarmInfo,
  type FacetIdentity,
  type FacetProps,
  type KindHandlers,
  type KindRegistry,
} from "./types";

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

/**
 * Facet-local replacement for `storage.deleteAll()`.
 *
 * The Workers runtime does not implement native `deleteAll()` inside a
 * facet yet, so claydo drops the kind's schema and key-value data
 * explicitly, in one synchronous transaction.
 */
function deleteAllFacetStorage(
  storage: DurableObjectStorage,
  transactionSync: <T>(closure: () => T) => T,
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
      storage.kv.delete(key);
    }
  });
}

/**
 * Returns an error that survives RPC serialization. Errors whose own
 * fields all clone pass through unchanged; an error with a non-cloneable
 * field (an open socket, a function) is rebuilt with its name, message,
 * stack, and every cloneable own field, so the caller always receives the
 * real error instead of an opaque serialization failure.
 */
function wireSafeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const fields = new Map<string, unknown>();
  let dirty = false;
  for (const key of Object.keys(error)) {
    try {
      const value = (error as unknown as Record<string, unknown>)[key];
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
    (safe as unknown as Record<string, unknown>)[key] = value;
  }
  return safe;
}

/**
 * Rewires the facet's own storage object so the kind gets the normal
 * Durable Object storage API:
 *
 * - Alarm methods relay to the supervisor, because a facet has no native
 *   alarm of its own. Alarm state lives in supervisor storage, so an alarm
 *   write is not atomic with the facet's data writes. Claydo therefore
 *   rejects alarm calls inside transactions instead of losing atomicity
 *   silently.
 * - `deleteAll()` clears the kind's tables and key-value data explicitly.
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
      deleteAllFacetStorage(storage, nativeTransactionSync);
    },
  };
  for (const [name, value] of Object.entries(replacements)) {
    Object.defineProperty(storage, name, { value, configurable: true });
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

/**
 * The facet role of a union instance. One isolated kind facet: it
 * constructs the kind implementation, forwards lifecycle events to it, and
 * dispatches RPC methods on it.
 */
export class FacetCore {
  readonly #ctx: DurableObjectState;
  readonly #env: unknown;
  readonly #props: FacetProps;
  readonly #kinds: KindRegistry;
  #bridge?: AlarmBridge;
  #impl?: object & KindHandlers;
  #implLoading?: Promise<object & KindHandlers>;
  readonly #methods = new Map<string, (...args: unknown[]) => unknown>();

  constructor(
    ctx: DurableObjectState,
    env: unknown,
    props: FacetProps,
    kinds: KindRegistry,
  ) {
    this.#ctx = ctx;
    this.#env = env;
    this.#props = props;
    this.#kinds = kinds;
    // Persist the facet's identity under the one reserved key in the
    // kind's key-value store, so the facet can select its role even when
    // the runtime starts it without props.
    const identity = ctx.storage.kv.get<unknown>(FACET_IDENTITY_KEY);
    if (
      !isFacetIdentity(identity) ||
      identity.kind !== props.kind ||
      identity.host !== props.host
    ) {
      ctx.storage.kv.put(FACET_IDENTITY_KEY, {
        v: 1,
        kind: props.kind,
        host: props.host,
      } satisfies FacetIdentity);
    }
    adaptFacetStorage(ctx, props.kind, () => this.#hostBridge());
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

  #hostBridge(): AlarmBridge {
    if (this.#bridge === undefined) {
      const exported = (
        this.#ctx.exports as unknown as Record<string, unknown>
      )[this.#props.host] as
        | { get?: (id: DurableObjectId) => AlarmBridge }
        | undefined;
      if (typeof exported?.get !== "function") {
        throw claydoError(
          "CLAYDO_CONFIG",
          `cannot find the union export '${this.#props.host}' from ` +
            `inside a kind facet. Keep the class returned by union() ` +
            `exported under that name.`,
        );
      }
      this.#bridge = exported.get(this.#ctx.id);
    }
    return this.#bridge;
  }

  async #load(): Promise<object & KindHandlers> {
    if (this.#impl !== undefined) return this.#impl;
    this.#implLoading ??= this.#construct().catch((error) => {
      this.#implLoading = undefined;
      throw error;
    });
    this.#impl = await this.#implLoading;
    return this.#impl;
  }

  async #construct(): Promise<object & KindHandlers> {
    const kind = this.#props.kind;
    const Kind = this.#kinds[kind];
    if (Kind === undefined) {
      throw claydoError(
        "CLAYDO_UNKNOWN_KIND",
        `this facet hosts kind '${kind}', which is not in the registry. ` +
          `Registered kinds: ${Object.keys(this.#kinds).join(", ")}.`,
      );
    }
    const impl = new Kind(this.#ctx, this.#env) as object & KindHandlers;
    // Frameworks such as PartyServer and the Agents SDK defer their setup
    // to this hook. Run it so their instances are usable immediately.
    const ensure = (impl as Record<string, unknown>)[
      "__unsafe_ensureInitialized"
    ];
    if (typeof ensure === "function") {
      await (ensure as (this: object) => unknown).call(impl);
    }
    return impl;
  }

  async call(kind: string, method: string, args: unknown[]): Promise<unknown> {
    if (kind !== this.#props.kind) {
      throw claydoError(
        "CLAYDO_KIND_MISMATCH",
        `this facet is kind '${this.#props.kind}', not '${kind}'.`,
        { actualKind: this.#props.kind, expectedKind: kind },
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
    let fn = this.#methods.get(method);
    if (fn === undefined) {
      fn = prototypeMethod(impl, method);
      if (fn !== undefined) this.#methods.set(method, fn);
    }
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

  async deliverAlarm(info: AlarmInfo): Promise<void> {
    try {
      const impl = await this.#load();
      await impl.alarm?.(info as unknown as AlarmInvocationInfo);
    } catch (error) {
      throw wireSafeError(error);
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const impl = await this.#load();
      if (typeof impl.fetch !== "function") {
        return new Response(
          `claydo: kind '${this.#props.kind}' does not implement fetch().`,
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
    const impl = await this.#load();
    await impl.webSocketMessage?.(ws, message);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    const impl = await this.#load();
    await impl.webSocketClose?.(ws, code, reason, wasClean);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const impl = await this.#load();
    await impl.webSocketError?.(ws, error);
  }
}
