export { union, instanceName, resetStorage } from "./host";
export type {
  ClaydoCallResult,
  GenericDurableObjectClass,
  GenericDurableObjectInstance,
  UnionOptions,
  WireError,
} from "./host";
export { kind, kinds } from "./client";
export type {
  KindAccessor,
  KindNameOf,
  KindStub,
  RegistryOf,
} from "./client";
/**
 * Use this as the base class for claydo kinds. It is Cloudflare's Durable
 * Object with facet alarm virtualization built in.
 */
export { FacetDurableObject as DurableObject } from "./types";
export type { KindClass, KindHandlers, KindRegistry } from "./types";
