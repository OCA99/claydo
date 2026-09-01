/**
 * A kind implementation. Any class with a `(ctx, env)` constructor works.
 * This includes every `DurableObject` subclass, so classes from libraries
 * such as PartyServer can register directly.
 */
export type KindClass = new (ctx: DurableObjectState, env: any) => object;

/**
 * The registry maps a kind name to its implementation class.
 * The kind name becomes part of the instance name: `<kind>:<name>`.
 */
export type KindRegistry = Record<string, KindClass>;

/**
 * Lifecycle handlers that claydo forwards to the kind implementation.
 * All handlers are optional.
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

/**
 * Kind methods with these names are lifecycle handlers. Claydo invokes them
 * through platform events; the typed stub does not proxy them as RPC.
 */
export const RESERVED_LIFECYCLE_METHODS = [
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
] as const;

/**
 * Names the typed stub reserves for metadata and control flow. `union()`
 * rejects kind classes that define these names as prototype methods,
 * because the stub could never call them.
 */
export const RESERVED_STUB_KEYS = [
  "ctx",
  "env",
  "id",
  "name",
  "kind",
  "stub",
  "then",
] as const;

export type ReservedLifecycleMethod =
  (typeof RESERVED_LIFECYCLE_METHODS)[number];
export type ReservedStubKey = (typeof RESERVED_STUB_KEYS)[number];

/** Internal: the props that a claydo supervisor gives each kind facet. */
export interface FacetProps {
  readonly claydoFacet: true;
  /** The kind this facet hosts. */
  readonly kind: string;
  /** The top-level export name of the supervisor class. */
  readonly host: string;
}

/** Internal: true when `props` identify a claydo facet. */
export function isFacetProps(props: unknown): props is FacetProps {
  const candidate = props as Partial<FacetProps> | undefined;
  return (
    candidate?.claydoFacet === true &&
    typeof candidate.kind === "string" &&
    typeof candidate.host === "string"
  );
}

/**
 * Internal: the header the typed stub sets on `fetch()` so the supervisor
 * can verify the caller's expected kind before routing.
 */
export const KIND_HEADER = "x-claydo-kind";

/**
 * The one reserved key in a kind's key-value store. It holds the facet's
 * identity, so the facet can select its role even when the runtime starts
 * it without props (for example on a hibernation wake). `deleteAll()`
 * preserves it.
 */
export const FACET_IDENTITY_KEY = "__claydo";

/** Internal: the persisted facet identity record. */
export interface FacetIdentity {
  readonly v: 1;
  readonly kind: string;
  readonly host: string;
}

/** Internal: true when `value` is a persisted facet identity. */
export function isFacetIdentity(value: unknown): value is FacetIdentity {
  const candidate = value as Partial<FacetIdentity> | undefined;
  return (
    candidate?.v === 1 &&
    typeof candidate.kind === "string" &&
    typeof candidate.host === "string"
  );
}

/**
 * Internal: the serializable subset of `AlarmInvocationInfo` that crosses
 * the supervisor-to-facet RPC hop when an alarm fires.
 */
export interface AlarmInfo {
  scheduledTime: number;
  isRetry: boolean;
  retryCount: number;
}

/**
 * Returns the logical instance name without its `<kind>:` prefix, or
 * `undefined` for unique-ID instances. Works inside kind implementations:
 * a kind facet shares the identity of its instance.
 */
export function instanceName(ctx: DurableObjectState): string | undefined {
  const name = ctx.id.name;
  if (name === undefined) return undefined;
  const separator = name.indexOf(":");
  return separator === -1 ? name : name.slice(separator + 1);
}
