import { DurableObject } from "cloudflare:workers";
import {
  KIND_HEADER,
  KIND_STORAGE_KEY,
  NO_INIT_HEADER,
  type KindHandlers,
  type KindRegistry,
} from "./types";

/**
 * Methods that remote callers must not invoke through `__claydoCall`.
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
 * Method names that the typed stub shadows with metadata. `union()` rejects
 * kind classes that define these as methods, so the shadowing can never hide
 * a real method at runtime.
 */
const RESERVED_STUB_KEYS = ["id", "name", "kind", "stub"] as const;

/** A serializable snapshot of an error, carried through the RPC envelope. */
export interface WireError {
  name: string;
  message: string;
  /** The stack captured where the error was thrown, inside the kind. */
  stack?: string;
  /** Own enumerable, structured-cloneable fields of the error. */
  props?: Record<string, unknown>;
}

/**
 * The result envelope of a dispatched RPC call. The client helper unwraps it
 * and rethrows errors locally with the remote stack and fields attached.
 */
export type ClaydoCallResult =
  | { ok: true; value: unknown }
  | { ok: false; error: WireError };

function toWireError(error: unknown): WireError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  const wire: WireError = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  const props: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    const value = (error as unknown as Record<string, unknown>)[key];
    try {
      structuredClone(value);
      props[key] = value;
    } catch {
      // Skip fields that do not serialize.
    }
  }
  if (Object.keys(props).length > 0) wire.props = props;
  return wire;
}

/** The instance type of the class that {@link union} returns. */
export interface GenericDurableObjectInstance<R extends KindRegistry>
  extends Rpc.DurableObjectBranded {
  /** Phantom field. It carries the registry type for client-side inference. */
  readonly __kinds: R;
  ctx: DurableObjectState;
  env: unknown;
  /** Dispatches an RPC call to the kind implementation. Internal. */
  __claydoCall(
    kind: string,
    method: string,
    args: unknown[],
    allowInit?: boolean,
  ): Promise<ClaydoCallResult>;
  /**
   * Returns the kind of this instance, or `undefined` when the instance has
   * no kind yet. This call never initializes the instance.
   */
  __claydoKind(): Promise<string | undefined>;
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
 * 3. The hint that the client helper sends with every call. The hint only
 *    initializes instances reached through `get()` or `unique()`; `fromId()`
 *    never initializes.
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
  for (const [name, Kind] of Object.entries(kinds)) {
    if (name.includes(":") || name.startsWith("__") || name.length === 0) {
      throw new Error(
        `claydo: invalid kind name '${name}'. ` +
          `Kind names must be non-empty, must not contain ':' and must not start with '__'.`,
      );
    }
    // Reject methods that the stub metadata would silently shadow.
    let proto: object | null = Kind.prototype as object;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of RESERVED_STUB_KEYS) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (descriptor && typeof descriptor.value === "function") {
          throw new Error(
            `claydo: kind '${name}' (class ${Kind.name}) ` +
              `defines a method named '${key}'. The stub reserves ` +
              `'${RESERVED_STUB_KEYS.join("', '")}' for metadata, so this ` +
              `method would not be callable. Rename the method.`,
          );
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
  }

  class GenericDurableObject extends DurableObject {
    declare readonly __kinds: R;
    #kind?: string;
    #impl?: object & KindHandlers;
    #loading?: Promise<void>;

    /** A human-readable identity for error messages and logs. */
    #identity(): string {
      return this.ctx.id.name ?? this.ctx.id.toString();
    }

    async #load(hint?: string, allowInit = true): Promise<object & KindHandlers> {
      if (this.#impl === undefined) {
        if (this.#loading === undefined) {
          this.#loading = this.#initialize(hint, allowInit).catch((error) => {
            // Allow a later call (possibly with a hint) to retry.
            this.#loading = undefined;
            throw error;
          });
        }
        await this.#loading;
      }
      if (hint !== undefined && hint !== this.#kind) {
        // The structured fields survive the RPC hop (see toWireError), so
        // callers can branch on `code` instead of parsing the message.
        throw Object.assign(
          new Error(
            `claydo: instance '${this.#identity()}' is kind ` +
              `'${this.#kind}', but the caller expected kind '${hint}'.`,
          ),
          {
            code: "CLAYDO_KIND_MISMATCH",
            actualKind: this.#kind,
            expectedKind: hint,
          },
        );
      }
      return this.#impl!;
    }

    async #initialize(hint?: string, allowInit = true): Promise<void> {
      const stored = await this.ctx.storage.get<string>(KIND_STORAGE_KEY);
      const kind =
        stored ?? this.#kindFromName() ?? (allowInit ? hint : undefined);
      if (kind === undefined) {
        throw new Error(this.#noKindMessage(hint, allowInit));
      }
      const Kind = kinds[kind];
      if (Kind === undefined) {
        throw new Error(
          `claydo: unknown kind '${kind}' on instance ` +
            `'${this.#identity()}'. Registered kinds: ${Object.keys(kinds).join(", ")}.`,
        );
      }
      if (stored === undefined) {
        await this.ctx.storage.put(KIND_STORAGE_KEY, kind);
      }
      const impl = new Kind(this.ctx, this.env);
      // Framework classes (PartyServer `Server`, Cloudflare Agents `Agent`,
      // Think) run their startup hook (`onStart`) only from `fetch()`,
      // WebSocket events, or their own `setName` RPC — never from a plain
      // method call. Claydo dispatches RPC directly to methods, so without
      // this step an Agent kind reached by RPC first would run with
      // uninitialized internal state. The hook is idempotent; plain kinds
      // do not define it and skip this entirely.
      const ensure = (impl as Record<string, unknown>)[
        "__unsafe_ensureInitialized"
      ];
      if (typeof ensure === "function") {
        await (ensure as (this: object) => unknown).call(impl);
      }
      this.#kind = kind;
      this.#impl = impl;
    }

    #noKindMessage(hint: string | undefined, allowInit: boolean): string {
      const identity = this.#identity();
      let message = `claydo: instance '${identity}' has no kind yet.`;
      if (hint !== undefined && !allowInit) {
        return (
          message +
          ` It was accessed as kind '${hint}' through fromId(), which never ` +
          `initializes an instance. Create the instance first with ` +
          `kind(ns, '${hint}').get(name) or .unique(), then reach it by id.`
        );
      }
      const name = this.ctx.id.name;
      if (name !== undefined) {
        return (
          message +
          ` Its name has no registered '<kind>:' prefix. Raw namespace access ` +
          `(for example getByName('${name}')) reaches a different instance than ` +
          `kind(ns, '<kind>').get('${name}'). Access instances through the ` +
          `kind() helper, or use a '<kind>:' prefixed name.`
        );
      }
      return (
        message +
        ` Unique-ID instances initialize on their first call through ` +
        `kind(ns, '<kind>').unique().`
      );
    }

    #kindFromName(): string | undefined {
      const name = this.ctx.id.name;
      if (name === undefined) return undefined;
      const separator = name.indexOf(":");
      if (separator === -1) return undefined;
      const prefix = name.slice(0, separator);
      return prefix in kinds ? prefix : undefined;
    }

    async __claydoCall(
      kind: string,
      method: string,
      args: unknown[],
      allowInit = true,
    ): Promise<ClaydoCallResult> {
      try {
        const impl = await this.#load(kind, allowInit);
        if (
          typeof method !== "string" ||
          method.startsWith("__") ||
          RESERVED_METHODS.has(method)
        ) {
          throw new Error(
            `claydo: method '${method}' is reserved and is not callable through the stub.`,
          );
        }
        const fn = (impl as Record<string, unknown>)[method];
        if (
          typeof fn !== "function" ||
          fn === (Object.prototype as Record<string, unknown>)[method]
        ) {
          if (method in impl && typeof fn !== "function") {
            throw new Error(
              `claydo: '${method}' on kind '${kind}' is a ` +
                `property, not a method (type: ${typeof fn}). The stub only ` +
                `proxies methods; add a getter method to read it.`,
            );
          }
          throw new Error(
            `claydo: kind '${kind}' has no method '${method}'.`,
          );
        }
        return { ok: true, value: await fn.apply(impl, args) };
      } catch (error) {
        return { ok: false, error: toWireError(error) };
      }
    }

    async __claydoKind(): Promise<string | undefined> {
      if (this.#kind !== undefined) return this.#kind;
      const stored = await this.ctx.storage.get<string>(KIND_STORAGE_KEY);
      return stored ?? this.#kindFromName();
    }

    /**
     * PartyServer's `getServerByName()` and the Agents SDK's
     * `getAgentByName()` call this RPC method on the raw stub. They cannot
     * work against a claydo host (they address instances without the kind
     * prefix), so fail with directions instead of the runtime's opaque
     * "receiver does not implement" error.
     */
    async setName(): Promise<never> {
      throw new Error(
        "claydo: this namespace is a claydo host. getServerByName() " +
          "(PartyServer) and getAgentByName() (Agents SDK) are not " +
          "supported here, because they address instances without the " +
          "kind prefix. Use kind(ns, '<kind>').get(name) or " +
          "kinds(ns).<kind>.get(name) instead — see 'Third-party Durable " +
          "Object libraries' in the claydo README.",
      );
    }

    async fetch(request: Request): Promise<Response> {
      let impl: KindHandlers;
      try {
        impl = await this.#load(
          request.headers.get(KIND_HEADER) ?? undefined,
          request.headers.get(NO_INIT_HEADER) === null,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return new Response(message, { status: 400 });
      }
      if (typeof impl.fetch !== "function") {
        return new Response(
          `claydo: kind '${this.#kind}' does not implement fetch().`,
          { status: 501 },
        );
      }
      return impl.fetch(request);
    }

    /**
     * Run one forwarded handler. Errors from these paths have no direct
     * caller, so log them with kind and instance context before rethrowing.
     */
    async #forward(
      handler: string,
      run: (impl: object & KindHandlers) => unknown,
    ): Promise<void> {
      try {
        const impl = await this.#load();
        await run(impl);
      } catch (error) {
        console.error(
          `claydo: ${handler} failed on kind ` +
            `'${this.#kind ?? "?"}' instance '${this.#identity()}':`,
          error,
        );
        throw error;
      }
    }

    async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
      await this.#forward("alarm()", (impl) => impl.alarm?.(alarmInfo));
    }

    async webSocketMessage(
      ws: WebSocket,
      message: string | ArrayBuffer,
    ): Promise<void> {
      await this.#forward("webSocketMessage()", (impl) =>
        impl.webSocketMessage?.(ws, message),
      );
    }

    async webSocketClose(
      ws: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> {
      await this.#forward("webSocketClose()", (impl) =>
        impl.webSocketClose?.(ws, code, reason, wasClean),
      );
    }

    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
      await this.#forward("webSocketError()", (impl) =>
        impl.webSocketError?.(ws, error),
      );
    }
  }

  return GenericDurableObject as unknown as GenericDurableObjectClass<R>;
}

/**
 * Returns the logical name of the current instance, without the `<kind>:`
 * prefix. Returns `undefined` for instances created with `newUniqueId()` or
 * accessed with `idFromString()`.
 *
 * Safe to call anywhere in a kind implementation, including its constructor:
 * kinds construct lazily on first contact, after `ctx.id.name` is available.
 */
export function instanceName(ctx: DurableObjectState): string | undefined {
  const name = ctx.id.name;
  if (name === undefined) return undefined;
  const separator = name.indexOf(":");
  return separator === -1 ? name : name.slice(separator + 1);
}

/**
 * Clears all storage of the current instance but keeps its kind pinned.
 *
 * Use this instead of `ctx.storage.deleteAll()` inside a kind. A raw
 * `deleteAll()` also deletes the persisted kind marker, which turns
 * unique-ID instances into kind-less husks.
 */
export async function resetStorage(ctx: DurableObjectState): Promise<void> {
  const kind = await ctx.storage.get<string>(KIND_STORAGE_KEY);
  await ctx.storage.deleteAll();
  if (kind !== undefined) {
    await ctx.storage.put(KIND_STORAGE_KEY, kind);
  }
}
