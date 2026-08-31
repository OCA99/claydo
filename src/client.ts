import type {
  ClaydoCallResult,
  GenericDurableObjectInstance,
  WireError,
} from "./host";
import { KIND_HEADER, NO_INIT_HEADER, type KindRegistry } from "./types";

/**
 * Keys that are not exposed as RPC methods on the typed stub: lifecycle
 * handlers, internals, and the stub metadata keys (`union()` rejects kind
 * classes that define the metadata keys as methods).
 */
type ReservedKey =
  | "ctx"
  | "env"
  | "fetch"
  | "alarm"
  | "webSocketMessage"
  | "webSocketClose"
  | "webSocketError"
  | "id"
  | "name"
  | "kind"
  | "stub"
  | "then"
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
  /**
   * The raw supervisor Durable Object stub, for helpers such as
   * `runDurableObjectAlarm`. User SQL/KV lives in its child facet.
   */
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

/**
 * The union of kind names registered on a namespace. Use this to type kind
 * names built at runtime before passing them to `kind()`.
 */
export type KindNameOf<NS> = keyof RegistryOf<NS> & string;

type KindInstance<NS, K extends KindNameOf<NS>> = InstanceType<
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
  /**
   * Returns a stub from a stored ID string or a `DurableObjectId`.
   * `fromId()` never initializes an instance: the instance must already have
   * a kind (from a previous `get()` or `unique()` contact), or every call
   * fails.
   */
  fromId(id: string | DurableObjectId): KindStub<T>;
  /** Returns the Durable Object ID that `get(name)` resolves to. */
  idFromName(name: string): DurableObjectId;
}

type AnyHost = GenericDurableObjectInstance<KindRegistry>;

/**
 * Returns a typed accessor for one kind inside a generic Durable Object
 * namespace.
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
  const ns = namespace as unknown as DurableObjectNamespace<AnyHost>;
  return {
    get: (name, options) =>
      makeStub(ns.get(ns.idFromName(`${kindName}:${name}`), options), kindName, {
        name,
        allowInit: true,
      }),
    unique: (options) =>
      makeStub(ns.get(ns.newUniqueId(options)), kindName, { allowInit: true }),
    fromId: (id) =>
      makeStub(
        ns.get(typeof id === "string" ? ns.idFromString(id) : id),
        kindName,
        { allowInit: false },
      ),
    idFromName: (name) => ns.idFromName(`${kindName}:${name}`),
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
  allowInit: boolean;
}

function makeStub<T>(
  stub: DurableObjectStub<AnyHost>,
  kindName: string,
  { name, allowInit }: StubOptions,
): KindStub<T> {
  const meta: Record<string, unknown> = {
    id: stub.id,
    name,
    kind: kindName,
    stub,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set(KIND_HEADER, kindName);
      if (!allowInit) request.headers.set(NO_INIT_HEADER, "1");
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
        let result: ClaydoCallResult;
        try {
          // The RPC type mapping widens the `ok` literal, so restate the type.
          result = (await stub.__claydoCall(
            kindName,
            prop,
            args,
            allowInit,
          )) as ClaydoCallResult;
        } catch (transport) {
          // The call failed outside the envelope: transport errors, or the
          // return value did not serialize. Add call context.
          const message =
            transport instanceof Error ? transport.message : String(transport);
          throw new Error(
            `claydo: call to ${kindName}.${prop}() failed: ${message}`,
            { cause: transport },
          );
        }
        if (result.ok) return result.value;
        throw reviveError(result.error, kindName, prop);
      };
    },
  }) as KindStub<T>;
}

/**
 * Rebuilds an error thrown inside a kind. The revived error keeps the
 * original name, message, serializable fields, and stack; the local frames
 * follow after a marker line. `instanceof` custom classes does not survive
 * the hop; match on `error.name` instead.
 */
function reviveError(wire: WireError, kindName: string, method: string): Error {
  const error = new Error(wire.message);
  error.name = wire.name;
  if (wire.props) Object.assign(error, wire.props);
  const localFrames = error.stack?.split("\n").slice(1).join("\n");
  const remote = wire.stack ?? `${wire.name}: ${wire.message}`;
  error.stack =
    `${remote}\n    at [remote call ${kindName}.${method}() via claydo]` +
    (localFrames ? `\n${localFrames}` : "");
  return error;
}
