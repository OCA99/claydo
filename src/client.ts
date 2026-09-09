import type { SupervisorInstance } from "./supervisor";
import {
  composeInstanceName,
  INIT_HEADER,
  KIND_HEADER,
  RESERVED_LIFECYCLE_METHODS,
  RESERVED_STUB_KEYS,
  type KindRegistry,
  type ReservedLifecycleMethod,
  type ReservedStubKey,
} from "./types";

/**
 * Keys that are not exposed as RPC methods on the typed stub: lifecycle
 * handlers, internals, and the stub metadata keys.
 */
type ReservedKey = ReservedLifecycleMethod | ReservedStubKey | `__${string}`;

/**
 * Property names the stub proxy answers locally with `undefined` instead
 * of an RPC-firing function: reserved kind names, and the probe keys that
 * serializers, inspectors, and coercion read (`then`, `toJSON`,
 * `constructor`, `valueOf`). Without this, `JSON.stringify(stub)` or
 * `${stub}` would fire real RPC calls.
 */
const LOCAL_UNDEFINED_KEYS = new Set<string>([
  ...RESERVED_STUB_KEYS,
  ...RESERVED_LIFECYCLE_METHODS,
  "toJSON",
  "constructor",
  "valueOf",
]);

/**
 * A typed stub for one kind instance. Every public prototype method of the
 * kind class becomes an async method on the stub.
 *
 * Prototype methods only: arrow-function instance fields
 * (`method = async () => {...}`) appear callable in this type, because
 * TypeScript cannot distinguish them from prototype methods, but they
 * reject at runtime with `CLAYDO_NO_METHOD`. Declare methods as regular
 * class methods.
 *
 * Errors thrown by the kind propagate natively: `name`, `message`,
 * `stack`, and own enumerable fields such as `code` survive the hop;
 * `instanceof` custom classes does not, so match on `error.name` or
 * `error.code`.
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
  /** Sends a request to the `fetch()` handler of the kind implementation. */
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

/**
 * The union of kind names registered on a namespace. Use this to type kind
 * names built at runtime before passing them to `kind()`.
 */
export type KindNameOf<NS> = keyof RegistryOf<NS> & string;

type KindInstance<NS, K extends KindNameOf<NS>> = InstanceType<
  RegistryOf<NS>[K]
>;

/** Accessor for one kind inside a union namespace. */
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
  /**
   * Returns a stub from a stored ID string or a `DurableObjectId`.
   * `fromId()` never initializes an instance: the instance must already
   * have a kind (from a previous `get()` or `unique()` contact), or every
   * call fails with `CLAYDO_UNINITIALIZED`.
   */
  fromId(id: string | DurableObjectId): KindStub<T>;
  /** Returns the Durable Object ID that `get(name)` resolves to. */
  idFromName(name: string): DurableObjectId;
}

type AnySupervisor = SupervisorInstance<KindRegistry>;

/**
 * Returns a typed accessor for one kind inside a union namespace.
 *
 * Prefer {@link kinds} for literal kind names: its property access produces
 * better TypeScript diagnostics. Use `kind()` when the kind name is a
 * runtime value typed as {@link KindNameOf}.
 *
 * @example
 * const counter = kind(env.APP_DO, "counter").get("user-42");
 * await counter.increment(2);
 */
export function kind<
  NS extends DurableObjectNamespace<any>,
  K extends KindNameOf<NS>,
>(namespace: NS, kindName: K): KindAccessor<KindInstance<NS, K>> {
  const ns = namespace as unknown as DurableObjectNamespace<AnySupervisor>;
  return {
    get: (name, options) =>
      makeStub(
        ns.get(ns.idFromName(composeInstanceName(kindName, name)), options),
        kindName,
        { name, mode: "named" },
      ),
    unique: (options) =>
      makeStub(ns.get(ns.newUniqueId(options)), kindName, {
        mode: "unique",
      }),
    fromId: (id) =>
      makeStub(
        ns.get(typeof id === "string" ? ns.idFromString(id) : id),
        kindName,
        { mode: "fromId" },
      ),
    idFromName: (name) => ns.idFromName(composeInstanceName(kindName, name)),
  };
}

/**
 * Returns an object with one typed accessor per registered kind.
 *
 * @example
 * const app = kinds(env.APP_DO);
 * await app.counter.get("user-42").increment(2);
 * const room = app.chat.get("lobby");
 */
export function kinds<NS extends DurableObjectNamespace<any>>(
  namespace: NS,
): {
  [K in KindNameOf<NS>]: KindAccessor<KindInstance<NS, K>>;
} {
  return new Proxy({} as Record<string, unknown>, {
    get: (_, prop) =>
      typeof prop === "string" ? kind(namespace, prop as never) : undefined,
  }) as { [K in KindNameOf<NS>]: KindAccessor<KindInstance<NS, K>> };
}

interface StubOptions {
  name?: string;
  mode: "named" | "unique" | "fromId";
}

function makeStub<T>(
  stub: DurableObjectStub<AnySupervisor>,
  kindName: string,
  { name, mode }: StubOptions,
): KindStub<T> {
  const meta: Record<string, unknown> = {
    id: stub.id,
    name,
    kind: kindName,
    stub,
    // Coercion in template literals must not fire RPC calls.
    toString: () =>
      `[claydo ${kindName} stub${name === undefined ? "" : ` '${name}'`}]`,
    fetch: async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input as RequestInfo, init);
      // Forwarded requests can carry claydo headers from an untrusted
      // client; the stub owns both, so it always overwrites them.
      request.headers.set(KIND_HEADER, kindName);
      if (mode === "fromId") {
        // fromId() never initializes.
        request.headers.delete(INIT_HEADER);
      } else {
        // First contact through get() or unique() may pin the kind; the
        // supervisor does it in the same round trip.
        request.headers.set(INIT_HEADER, "1");
      }
      return stub.fetch(request);
    },
  };
  return new Proxy(meta, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (Object.hasOwn(target, prop)) {
        return target[prop];
      }
      // Serializer and inspector probes must not become RPC calls, and
      // reserved names fail fast without a round trip.
      if (LOCAL_UNDEFINED_KEYS.has(prop) || prop.startsWith("__")) {
        return undefined;
      }
      // Await the RPC promise directly instead of chaining on it: a
      // .then/.catch chain wraps the RPC result in a native promise and
      // can leave the underlying result undisposed.
      return async (...args: unknown[]) => {
        try {
          return await (stub.__claydoCall(
            kindName,
            prop,
            args,
            mode !== "fromId",
          ) as Promise<unknown>);
        } catch (error) {
          // Serialization failures originate at this call site, not in
          // the kind, so add the call context the raw error lacks.
          if (error instanceof Error && error.name === "DataCloneError") {
            throw new Error(
              `claydo: call to ${kindName}.${prop}() failed to ` +
                `serialize: ${error.message}`,
              { cause: error },
            );
          }
          throw error;
        }
      };
    },
  }) as KindStub<T>;
}
