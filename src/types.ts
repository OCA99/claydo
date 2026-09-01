import { DurableObject as CloudflareDurableObject } from "cloudflare:workers";
import { quoteIdent } from "./migrate-wire";

/**
 * Internal props that distinguish a facet-hosted claydo kind from the
 * supervisor Durable Object. Props live outside the kind's database.
 */
export interface ClaydoFacetProps {
  readonly __claydoFacet: true;
  readonly kind: string;
  readonly hostExport: string;
}

/** A kind implementation. */
export type KindClass = new (ctx: DurableObjectState, env: any) => object;

/**
 * The registry maps a kind name to its implementation class.
 * The kind name becomes part of the instance name: `<kind>:<name>`.
 */
export type KindRegistry = Record<string, KindClass>;

/** The header that carries the kind hint on `fetch()` calls to the stub. */
export const KIND_HEADER = "x-claydo-kind";

/**
 * The header that marks a `fetch()` from a `fromId()` stub. It tells the
 * host that the kind hint must validate only, never initialize.
 */
export const NO_INIT_HEADER = "x-claydo-no-init";

/** The storage key that persists the kind of an instance. */
export const KIND_STORAGE_KEY = "__claydo:kind";

/** The facet name that owns one instance's user data. */
export function kindFacetName(kind: string): string {
  return `kind:${kind}`;
}

/** True when a Durable Object invocation is a claydo facet. */
export function facetProps(
  ctx: DurableObjectState,
): ClaydoFacetProps | undefined {
  const props = ctx.props as Partial<ClaydoFacetProps> | undefined;
  return props?.__claydoFacet === true &&
    typeof props.kind === "string" &&
    typeof props.hostExport === "string"
    ? (props as ClaydoFacetProps)
    : undefined;
}

interface AlarmHostStub {
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
}

interface LoopbackHostNamespace {
  (options: { props?: unknown }): DurableObjectClass;
  get(id: DurableObjectId): AlarmHostStub;
}

/**
 * Facet-local replacement for `storage.deleteAll()`.
 *
 * workerd currently rejects native `deleteAll()` from a facet with an
 * internal actor-parent assertion. Drop user schema and KV explicitly.
 */
async function deleteAllFacetStorage(
  storage: DurableObjectStorage,
): Promise<void> {
  storage.transactionSync(() => {
    // Defers FK checks until commit, after every user table is gone. The
    // whole reset rolls back if any drop fails; partial destruction is not
    // observable.
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
 * Gives a facet-hosted kind the normal Durable Object alarm API even though
 * native facet alarms are not implemented yet. Alarm state stays in the
 * supervisor; calls relay through its loopback namespace.
 */
export function facetContext(
  ctx: DurableObjectState,
  props: ClaydoFacetProps,
): DurableObjectState {
  const exported = (ctx.exports as unknown as Record<string, unknown>)[
    props.hostExport
  ] as LoopbackHostNamespace | undefined;
  if (
    exported === undefined ||
    typeof exported !== "function" ||
    typeof exported.get !== "function"
  ) {
    throw new Error(
      `claydo: cannot find exported host class '${props.hostExport}' in ` +
        `ctx.exports. Export the class returned by union() under that name.`,
    );
  }
  const host = exported.get(ctx.id);
  let syncTransactionDepth = 0;
  const assertAlarmOutsideSyncTransaction = (): void => {
    if (syncTransactionDepth > 0) {
      throw new Error(
        "claydo: alarm operations inside storage.transactionSync() cannot " +
          "be atomic across facet and supervisor storage. Commit the " +
          "transaction, then call the alarm method.",
      );
    }
  };
  const storage = new Proxy(ctx.storage, {
    get(target, property) {
      if (property === "setAlarm") {
        return (
          scheduledTime: number | Date,
          options?: DurableObjectSetAlarmOptions,
        ): Promise<void> => {
          assertAlarmOutsideSyncTransaction();
          const timestamp =
            scheduledTime instanceof Date
              ? scheduledTime.getTime()
              : scheduledTime;
          return host.__claydoSetAlarm(props.kind, timestamp, options);
        };
      }
      if (property === "getAlarm") {
        return (
          options?: DurableObjectGetAlarmOptions,
        ): Promise<number | null> => {
          assertAlarmOutsideSyncTransaction();
          return host.__claydoGetAlarm(props.kind, options);
        };
      }
      if (property === "deleteAlarm") {
        return (
          options?: DurableObjectSetAlarmOptions,
        ): Promise<void> => {
          assertAlarmOutsideSyncTransaction();
          return host.__claydoDeleteAlarm(props.kind, options);
        };
      }
      if (property === "transaction") {
        return <T>(
          closure: (txn: DurableObjectTransaction) => Promise<T>,
        ): Promise<T> =>
          target.transaction((txn) =>
            closure(
              new Proxy(txn, {
                get(transaction, transactionProperty) {
                  if (
                    transactionProperty === "setAlarm" ||
                    transactionProperty === "getAlarm" ||
                    transactionProperty === "deleteAlarm"
                  ) {
                    return (): never => {
                      throw new Error(
                        "claydo: alarm operations inside storage.transaction() " +
                          "cannot be atomic across facet and supervisor storage. " +
                          "Commit the transaction, then call the alarm method.",
                      );
                    };
                  }
                  const value = Reflect.get(
                    transaction,
                    transactionProperty,
                    transaction,
                  );
                  return typeof value === "function"
                    ? value.bind(transaction)
                    : value;
                },
              }),
            ),
          );
      }
      if (property === "transactionSync") {
        return <T>(closure: () => T): T =>
          target.transactionSync(() => {
            syncTransactionDepth += 1;
            try {
              return closure();
            } finally {
              syncTransactionDepth -= 1;
            }
          });
      }
      if (property === "deleteAll") {
        return async (): Promise<void> => {
          await deleteAllFacetStorage(target);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DurableObjectStorage;
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "storage") return storage;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DurableObjectState;
}

/**
 * The recommended base class for kinds.
 *
 * It behaves like Cloudflare's `DurableObject`, but supplies the supervisor-
 * backed alarm API when the instance runs inside a facet. Use `this.ctx`
 * (rather than the raw constructor parameter) for alarm calls.
 */
export abstract class FacetDurableObject<
  Env = unknown,
  Props = unknown,
> extends CloudflareDurableObject<Env, Props> {
  constructor(ctx: DurableObjectState<Props>, env: Env) {
    super(ctx, env);
    const props = facetProps(ctx);
    if (props !== undefined) {
      Object.defineProperty(this, "ctx", {
        value: facetContext(ctx, props),
        writable: true,
        configurable: true,
      });
    }
  }
}

/**
 * Handler methods that the host Durable Object forwards to the kind
 * implementation. All handlers are optional.
 */
export interface KindHandlers {
  fetch?(request: Request): Response | Promise<Response>;
  alarm?(alarmInfo?: AlarmInvocationInfo): void | Promise<void>;
  webSocketMessage?(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): void | Promise<void>;
  webSocketClose?(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void | Promise<void>;
  webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
}
