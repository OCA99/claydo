import type { GdoCallResult, GenericDurableObjectInstance } from "./host";
import { KIND_HEADER, type KindRegistry } from "./types";

/** Keys that are not exposed as RPC methods on the typed stub. */
type ReservedKey =
  | "ctx"
  | "env"
  | "fetch"
  | "alarm"
  | "webSocketMessage"
  | "webSocketClose"
  | "webSocketError"
  | `__${string}`;

/**
 * A typed stub for one kind instance. Every public method of the kind class
 * becomes an async method on the stub.
 */
export type KindStub<T> = {
  [K in Exclude<keyof T, ReservedKey | symbol | number> as T[K] extends (
    ...args: any[]
  ) => any
    ? K
    : never]: T[K] extends (...args: infer A) => infer Ret
    ? (...args: A) => Promise<Awaited<Ret>>
    : never;
} & {
  /** The Durable Object ID of this instance. */
  readonly id: DurableObjectId;
  /** The logical name, when the stub was created with `get(name)`. */
  readonly name: string | undefined;
  /** The kind of this instance. */
  readonly kind: string;
  /** The raw Durable Object stub, for escape hatches such as `cloudflare:test`. */
  readonly stub: DurableObjectStub;
  /**
   * Sends a request to the `fetch()` handler of the kind implementation.
   * The helper attaches the kind hint header automatically.
   */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

/** Extracts the kind registry from a Durable Object namespace type. */
export type RegistryOf<NS> =
  NS extends DurableObjectNamespace<infer T>
    ? T extends { readonly __kinds: infer R }
      ? R extends KindRegistry
        ? R
        : never
      : never
    : never;

type KindNames<NS> = keyof RegistryOf<NS> & string;

type KindInstance<NS, K extends KindNames<NS>> = InstanceType<
  RegistryOf<NS>[K]
>;

/** Accessor for one kind inside a generic Durable Object namespace. */
export interface KindAccessor<T> {
  /**
   * Returns a stub for the named instance. The full Durable Object name is
   * `<kind>:<name>`, so equal names under different kinds map to different
   * instances.
   */
  get(
    name: string,
    options?: DurableObjectNamespaceGetDurableObjectOptions,
  ): KindStub<T>;
  /** Creates a new unique instance. Store `stub.id.toString()` to find it again. */
  unique(options?: DurableObjectNamespaceNewUniqueIdOptions): KindStub<T>;
  /** Returns a stub from a stored ID string or a `DurableObjectId`. */
  fromId(id: string | DurableObjectId): KindStub<T>;
  /** Returns the Durable Object ID that `get(name)` resolves to. */
  idFromName(name: string): DurableObjectId;
}

type AnyHost = GenericDurableObjectInstance<KindRegistry>;

/**
 * Returns a typed accessor for one kind inside a generic Durable Object
 * namespace.
 *
 * @example
 * const counter = kind(env.APP_DO, "counter").get("user-42");
 * await counter.increment(2);
 */
export function kind<
  NS extends DurableObjectNamespace<any>,
  K extends KindNames<NS>,
>(namespace: NS, kindName: K): KindAccessor<KindInstance<NS, K>> {
  const ns = namespace as unknown as DurableObjectNamespace<AnyHost>;
  return {
    get: (name, options) =>
      makeStub(
        ns.get(ns.idFromName(`${kindName}:${name}`), options),
        kindName,
        name,
      ),
    unique: (options) => makeStub(ns.get(ns.newUniqueId(options)), kindName),
    fromId: (id) =>
      makeStub(
        ns.get(typeof id === "string" ? ns.idFromString(id) : id),
        kindName,
      ),
    idFromName: (name) => ns.idFromName(`${kindName}:${name}`),
  };
}

function makeStub<T>(
  stub: DurableObjectStub<AnyHost>,
  kindName: string,
  name?: string,
): KindStub<T> {
  const meta: Record<string, unknown> = {
    id: stub.id,
    name,
    kind: kindName,
    stub,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set(KIND_HEADER, kindName);
      return stub.fetch(request);
    },
  };
  return new Proxy(meta, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (Object.prototype.hasOwnProperty.call(target, prop)) {
        return target[prop];
      }
      // Do not present the stub as a thenable to `await`.
      if (prop === "then") return undefined;
      return async (...args: unknown[]) => {
        // The RPC type mapping widens the `ok` literal, so restate the type.
        const result = (await stub.__gdoCall(
          kindName,
          prop,
          args,
        )) as GdoCallResult;
        if (result.ok) return result.value;
        const error = new Error(result.error.message);
        error.name = result.error.name;
        throw error;
      };
    },
  }) as KindStub<T>;
}
