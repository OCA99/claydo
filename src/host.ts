import { DurableObject } from "cloudflare:workers";
import {
  KIND_HEADER,
  KIND_STORAGE_KEY,
  type KindHandlers,
  type KindRegistry,
} from "./types";

/**
 * Methods that remote callers must not invoke through `__gdoCall`.
 * Lifecycle handlers run through their dedicated host handlers instead.
 */
const RESERVED_METHODS = new Set([
  "constructor",
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);

/**
 * The result envelope of a dispatched RPC call. The client helper unwraps it
 * and throws errors locally. This keeps error propagation clean and explicit.
 */
export type GdoCallResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string } };

/** The instance type of the class that {@link union} returns. */
export interface GenericDurableObjectInstance<R extends KindRegistry>
  extends Rpc.DurableObjectBranded {
  /** Phantom field. It carries the registry type for client-side inference. */
  readonly __kinds: R;
  ctx: DurableObjectState;
  env: unknown;
  /** Dispatches an RPC call to the kind implementation. Internal. */
  __gdoCall(
    kind: string,
    method: string,
    args: unknown[],
  ): Promise<GdoCallResult>;
  /**
   * Returns the kind of this instance, or `undefined` when the instance has
   * no kind yet. This call never initializes the instance.
   */
  __gdoKind(): Promise<string | undefined>;
  fetch(request: Request): Promise<Response>;
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void>;
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
  webSocketError(ws: WebSocket, error: unknown): Promise<void>;
}

/** The constructor type of the class that {@link union} returns. */
export type GenericDurableObjectClass<R extends KindRegistry> = new (
  ctx: DurableObjectState,
  env: any,
) => GenericDurableObjectInstance<R>;

/**
 * Creates one Durable Object class that hosts many kinds.
 *
 * Each instance binds to exactly one kind, forever. The host resolves the
 * kind from, in order:
 *
 * 1. The value persisted in storage on first contact.
 * 2. The `<kind>:` prefix of the instance name (`ctx.id.name`).
 * 3. The hint that the client helper sends with every call.
 *
 * Export the returned class from your Worker and point one binding plus one
 * SQLite migration at it. You never add migrations for new kinds.
 *
 * @example
 * export class AppDO extends union({ counter: Counter, chat: ChatRoom }) {}
 */
export function union<R extends KindRegistry>(
  kinds: R,
): GenericDurableObjectClass<R> {
  for (const name of Object.keys(kinds)) {
    if (name.includes(":") || name.startsWith("__") || name.length === 0) {
      throw new Error(
        `generic-durable-objects: invalid kind name '${name}'. ` +
          `Kind names must be non-empty, must not contain ':' and must not start with '__'.`,
      );
    }
  }

  class GenericDurableObject extends DurableObject {
    declare readonly __kinds: R;
    #kind?: string;
    #impl?: object & KindHandlers;
    #loading?: Promise<void>;

    async #load(hint?: string): Promise<object & KindHandlers> {
      if (this.#impl === undefined) {
        if (this.#loading === undefined) {
          this.#loading = this.#initialize(hint).catch((error) => {
            // Allow a later call (possibly with a hint) to retry.
            this.#loading = undefined;
            throw error;
          });
        }
        await this.#loading;
      }
      if (hint !== undefined && hint !== this.#kind) {
        throw new Error(
          `generic-durable-objects: this instance is kind '${this.#kind}', ` +
            `but the caller expected kind '${hint}'.`,
        );
      }
      return this.#impl!;
    }

    async #initialize(hint?: string): Promise<void> {
      const stored = await this.ctx.storage.get<string>(KIND_STORAGE_KEY);
      const kind = stored ?? this.#kindFromName() ?? hint;
      if (kind === undefined) {
        throw new Error(
          "generic-durable-objects: this instance has no kind yet. " +
            "Access it through kind() from a Worker, or use a name with a '<kind>:' prefix.",
        );
      }
      const Kind = kinds[kind];
      if (Kind === undefined) {
        throw new Error(
          `generic-durable-objects: unknown kind '${kind}'. ` +
            `Registered kinds: ${Object.keys(kinds).join(", ")}.`,
        );
      }
      if (stored === undefined) {
        await this.ctx.storage.put(KIND_STORAGE_KEY, kind);
      }
      this.#kind = kind;
      this.#impl = new Kind(this.ctx, this.env);
    }

    #kindFromName(): string | undefined {
      const name = this.ctx.id.name;
      if (name === undefined) return undefined;
      const separator = name.indexOf(":");
      if (separator === -1) return undefined;
      const prefix = name.slice(0, separator);
      return prefix in kinds ? prefix : undefined;
    }

    async __gdoCall(
      kind: string,
      method: string,
      args: unknown[],
    ): Promise<GdoCallResult> {
      try {
        const impl = await this.#load(kind);
        if (
          typeof method !== "string" ||
          method.startsWith("__") ||
          RESERVED_METHODS.has(method)
        ) {
          throw new Error(
            `generic-durable-objects: method '${method}' is reserved and is not callable through the stub.`,
          );
        }
        const fn = (impl as Record<string, unknown>)[method];
        if (
          typeof fn !== "function" ||
          fn === (Object.prototype as Record<string, unknown>)[method]
        ) {
          throw new Error(
            `generic-durable-objects: kind '${kind}' has no method '${method}'.`,
          );
        }
        return { ok: true, value: await fn.apply(impl, args) };
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        return { ok: false, error: { name: cause.name, message: cause.message } };
      }
    }

    async __gdoKind(): Promise<string | undefined> {
      if (this.#kind !== undefined) return this.#kind;
      const stored = await this.ctx.storage.get<string>(KIND_STORAGE_KEY);
      return stored ?? this.#kindFromName();
    }

    async fetch(request: Request): Promise<Response> {
      let impl: KindHandlers;
      try {
        impl = await this.#load(request.headers.get(KIND_HEADER) ?? undefined);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return new Response(message, { status: 400 });
      }
      if (typeof impl.fetch !== "function") {
        return new Response(
          `generic-durable-objects: kind '${this.#kind}' does not implement fetch().`,
          { status: 501 },
        );
      }
      return impl.fetch(request);
    }

    async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
      const impl = await this.#load();
      await impl.alarm?.(alarmInfo);
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

  return GenericDurableObject as unknown as GenericDurableObjectClass<R>;
}

/**
 * Returns the logical name of the current instance, without the `<kind>:`
 * prefix. Returns `undefined` for instances created with `newUniqueId()` or
 * accessed with `idFromString()`.
 *
 * Call this from inside a kind implementation, outside the constructor.
 */
export function instanceName(ctx: DurableObjectState): string | undefined {
  const name = ctx.id.name;
  if (name === undefined) return undefined;
  const separator = name.indexOf(":");
  return separator === -1 ? name : name.slice(separator + 1);
}
