import { DurableObject } from "cloudflare:workers";
import { claydoError } from "./errors";
import {
  isFacetProps,
  RESERVED_LIFECYCLE_METHODS,
  RESERVED_STUB_KEYS,
  type AlarmInfo,
  type FacetProps,
  type KindHandlers,
  type KindRegistry,
} from "./types";

/** Methods that `__claydoCall` refuses to dispatch. */
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

/** The instance surface of the facet class that `union()` creates. */
export interface FacetInstance extends Rpc.DurableObjectBranded {
  __claydoCall(method: string, args: unknown[]): Promise<unknown>;
  __claydoAlarm(info: AlarmInfo): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

/** The constructor of the facet class that `union()` creates. */
export type FacetClass = new (
  ctx: DurableObjectState,
  env: any,
) => FacetInstance;

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
      storage.kv.delete(key);
    }
  });
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
 * Creates the facet class for one registry. Each instance of this class is
 * one isolated kind facet: it constructs the kind implementation, forwards
 * lifecycle events to it, and dispatches RPC methods on it.
 */
export function createFacetClass(kinds: KindRegistry): FacetClass {
  class ClaydoKindFacet extends DurableObject<unknown> {
    readonly #props: FacetProps;
    #bridge?: AlarmBridge;
    #impl?: object & KindHandlers;
    #implLoading?: Promise<object & KindHandlers>;
    readonly #methods = new Map<string, (...args: unknown[]) => unknown>();

    constructor(ctx: DurableObjectState, env: unknown) {
      super(ctx, env);
      const props = ctx.props;
      if (!isFacetProps(props)) {
        throw claydoError(
          "CLAYDO_CONFIG",
          "this class only runs as a kind facet inside a claydo " +
            "supervisor. Bind the supervisor class in wrangler and reach " +
            "kinds through kind() or kinds().",
        );
      }
      this.#props = props;
      adaptFacetStorage(ctx, props.kind, () => this.#hostBridge());
      // The kind implementation gets a clean context: the props are a
      // claydo detail, not part of the kind's contract.
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
          this.ctx.exports as unknown as Record<string, unknown>
        )[this.#props.host] as
          | { get?: (id: DurableObjectId) => AlarmBridge }
          | undefined;
        if (typeof exported?.get !== "function") {
          throw claydoError(
            "CLAYDO_CONFIG",
            `cannot find the supervisor export '${this.#props.host}' from ` +
              `inside a kind facet. Keep the class returned by union() ` +
              `exported under that name.`,
          );
        }
        this.#bridge = exported.get(this.ctx.id);
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
      const Kind = kinds[kind];
      if (Kind === undefined) {
        throw claydoError(
          "CLAYDO_UNKNOWN_KIND",
          `this facet hosts kind '${kind}', which is not in the registry. ` +
            `Registered kinds: ${Object.keys(kinds).join(", ")}.`,
        );
      }
      const impl = new Kind(this.ctx, this.env) as object & KindHandlers;
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

    async __claydoCall(method: string, args: unknown[]): Promise<unknown> {
      const impl = await this.#load();
      const kind = this.#props.kind;
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
        const value = (impl as Record<string, unknown>)[method];
        if (method in impl && typeof value !== "function") {
          throw claydoError(
            "CLAYDO_NO_METHOD",
            `'${method}' on kind '${kind}' is a property, not a method ` +
              `(type: ${typeof value}). The stub only proxies methods; ` +
              `add a getter method to read it.`,
          );
        }
        if (method in impl && typeof value === "function") {
          throw claydoError(
            "CLAYDO_NO_METHOD",
            `'${method}' on kind '${kind}' is a function-valued instance ` +
              `field, not a prototype method. Workers RPC exposes ` +
              `prototype methods only.`,
          );
        }
        throw claydoError(
          "CLAYDO_NO_METHOD",
          `kind '${kind}' has no method '${method}'.`,
        );
      }
      return fn.apply(impl, args);
    }

    async __claydoAlarm(info: AlarmInfo): Promise<void> {
      const impl = await this.#load();
      await impl.alarm?.(info as unknown as AlarmInvocationInfo);
    }

    async fetch(request: Request): Promise<Response> {
      const impl = await this.#load();
      if (typeof impl.fetch !== "function") {
        return new Response(
          `claydo: kind '${this.#props.kind}' does not implement fetch().`,
          { status: 501 },
        );
      }
      return impl.fetch(request);
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

  return ClaydoKindFacet as unknown as FacetClass;
}
