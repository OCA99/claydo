import { claydoError } from "./errors";
import {
  FACET_IDENTITY_KEY,
  instanceName,
  isFacetIdentity,
  type KindClass,
} from "./types";

/** PartyServer/Agents classes with the SDK's name/bootstrap contract. */
export type SdkKindClass = KindClass &
  (new (...args: any[]) => {
    readonly name: string;
    setName(name: string, ...args: any[]): Promise<void>;
  });

const sdkPrototypes = new WeakSet<object>();

function context(instance: object): { ctx: DurableObjectState; kind: string } {
  // PartyServer/Agents inherit the protected ctx property from
  // DurableObject. Read it without wrapping the native state or its ID.
  const ctx = Reflect.get(instance, "ctx") as DurableObjectState | undefined;
  const identity = ctx?.storage.kv.get(FACET_IDENTITY_KEY);
  if (ctx === undefined || !isFacetIdentity(identity)) {
    throw claydoError(
      "CLAYDO_CONFIG",
      "sdk() kinds must run inside a claydo union facet.",
    );
  }
  return { ctx, kind: identity.kind };
}

/** Internal: inherited by subclasses and instrumentation wrappers. */
export function isSdkKind(instance: object): boolean {
  let prototype: object | null = instance;
  while (prototype !== null) {
    if (sdkPrototypes.has(prototype)) return true;
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

/**
 * Opts a PartyServer, Agent, or McpAgent class into SDK-compatible names
 * and startup. Register sdk(MyAgent) in union(), then pass a
 * kindNamespace() to the SDK's normal routing helpers.
 *
 * The SDK owns initialization (including delivery of authenticated
 * props); claydo does not call __unsafe_ensureInitialized() eagerly.
 * Static APIs and the original instance type are preserved.
 */
export function sdk<T extends SdkKindClass>(Kind: T): T {
  if (isSdkKind(Kind.prototype)) return Kind;
  // TypeScript cannot express an accessor-only structural constraint.
  // Keep the public constructor type while implementing against object.
  const Base = Kind as new (...args: any[]) => object;
  class SdkKind extends Base {
    get name(): string {
      const { ctx, kind } = context(this);
      const logical = instanceName(ctx);
      if (logical !== undefined) return logical;
      const name = Reflect.get(Kind.prototype, "name", this) as string;
      const prefix = `${kind}:`;
      return name.startsWith(prefix) ? name.slice(prefix.length) : name;
    }

    async setName(name: string, ...args: any[]): Promise<void> {
      const { kind } = context(this);
      // Preserve the SDK's name validation instead of making an
      // invalid name valid by adding the kind prefix.
      const setName = Reflect.get(Kind.prototype, "setName", this) as (
        name: string,
        ...args: any[]
      ) => Promise<void>;
      await setName.call(
        this,
        typeof name !== "string" || name === "" ? name : `${kind}:${name}`,
        ...args,
      );
    }
  }
  sdkPrototypes.add(SdkKind.prototype);
  Object.defineProperty(SdkKind, "name", { value: Kind.name });
  return SdkKind as unknown as T;
}
