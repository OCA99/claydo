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

/** The header that carries the kind hint on `fetch()` calls to the stub. */
export const KIND_HEADER = "x-gdo-kind";

/**
 * The header that marks a `fetch()` from a `fromId()` stub. It tells the
 * host that the kind hint must validate only, never initialize.
 */
export const NO_INIT_HEADER = "x-gdo-no-init";

/** The storage key that persists the kind of an instance. */
export const KIND_STORAGE_KEY = "__gdo:kind";

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
