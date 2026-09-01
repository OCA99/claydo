import { DurableObject } from "cloudflare:workers";
import { claydoError } from "./errors";
import { FacetCore } from "./facet";
import {
  SupervisorCore,
  type SupervisorClass,
  type UnionOptions,
} from "./supervisor";
import {
  isFacetProps,
  RESERVED_STUB_KEYS,
  type AlarmInfo,
  type FacetProps,
  type KindRegistry,
} from "./types";

/**
 * Creates one Durable Object class that hosts every registered kind.
 *
 * Each instance of the returned class is one kind instance. The class
 * plays one of two roles, selected once at construction: without facet
 * props it is the supervisor, which owns the instance's identity and its
 * native alarm; with facet props it is the kind's facet, which runs the
 * kind implementation against its own isolated SQLite database. The
 * supervisor starts the facet from the worker's own top-level export, so
 * one export and one migration entry cover everything:
 *
 * @example
 * export class AppDO extends union({ counter: Counter, chat: ChatRoom }) {}
 *
 * In the wrangler configuration, bind `AppDO` and list it in
 * `new_sqlite_classes`.
 */
export function union<R extends KindRegistry>(
  kinds: R,
  options: UnionOptions = {},
): SupervisorClass<R> {
  validateRegistry(kinds);

  class ClaydoUnion extends DurableObject<unknown> {
    declare readonly __kinds: R;
    readonly #core: SupervisorCore | FacetCore;

    constructor(ctx: DurableObjectState, env: unknown) {
      // Role selection happens exactly once, before any other code runs.
      // No facet props: supervisor. Valid facet props: facet. Anything
      // else is a configuration error, never a silent role guess.
      const props = (ctx as { props?: unknown }).props;
      const facetProps = readFacetProps(props);
      super(ctx, env);
      this.#core =
        facetProps === undefined
          ? new SupervisorCore(ctx, kinds, options, () =>
              this.constructor.name,
            )
          : new FacetCore(ctx, env, facetProps, kinds);
    }

    #supervisor(method: string): SupervisorCore {
      if (!(this.#core instanceof SupervisorCore)) {
        throw claydoError(
          "CLAYDO_CONFIG",
          `'${method}' is internal to claydo and is not available on a ` +
            `kind facet.`,
        );
      }
      return this.#core;
    }

    #facet(method: string): FacetCore {
      if (!(this.#core instanceof FacetCore)) {
        throw claydoError(
          "CLAYDO_CONFIG",
          `'${method}' is internal to claydo and is not available on a ` +
            `supervisor.`,
        );
      }
      return this.#core;
    }

    async __claydoCall(
      kind: string,
      method: string,
      args: unknown[],
      init: boolean,
    ): Promise<unknown> {
      return this.#core instanceof FacetCore
        ? this.#core.call(kind, method, args)
        : this.#core.call(kind, method, args, init);
    }

    async __claydoInit(kind: string): Promise<string> {
      return this.#supervisor("__claydoInit").init(kind);
    }

    async __claydoSetAlarm(kind: string, time: number): Promise<void> {
      return this.#supervisor("__claydoSetAlarm").setKindAlarm(kind, time);
    }

    async __claydoGetAlarm(
      kind: string,
      options?: DurableObjectGetAlarmOptions,
    ): Promise<number | null> {
      return this.#supervisor("__claydoGetAlarm").getKindAlarm(
        kind,
        options,
      );
    }

    async __claydoDeleteAlarm(kind: string): Promise<void> {
      return this.#supervisor("__claydoDeleteAlarm").deleteKindAlarm(kind);
    }

    async __claydoAlarm(info: AlarmInfo): Promise<void> {
      return this.#facet("__claydoAlarm").deliverAlarm(info);
    }

    async fetch(request: Request): Promise<Response> {
      return this.#core.fetch(request);
    }

    async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
      // A facet has no native alarm; the supervisor delivers kind alarms
      // through __claydoAlarm.
      return this.#supervisor("alarm").alarm(alarmInfo);
    }

    async webSocketMessage(
      ws: WebSocket,
      message: string | ArrayBuffer,
    ): Promise<void> {
      if (this.#core instanceof FacetCore) {
        await this.#core.webSocketMessage(ws, message);
      }
      // The supervisor never accepts WebSockets, so there is nothing to
      // forward in the supervisor role.
    }

    async webSocketClose(
      ws: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> {
      if (this.#core instanceof FacetCore) {
        await this.#core.webSocketClose(ws, code, reason, wasClean);
      }
    }

    async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
      if (this.#core instanceof FacetCore) {
        await this.#core.webSocketError(ws, error);
      }
    }

    /**
     * PartyServer's `getServerByName()` and the Agents SDK's
     * `getAgentByName()` call this method on raw namespace stubs. They
     * bypass the kind prefix, so they cannot address a claydo instance.
     */
    async setName(): Promise<never> {
      throw claydoError(
        "CLAYDO_CONFIG",
        "this namespace is a claydo union. getServerByName() " +
          "(PartyServer) and getAgentByName() (Agents SDK) omit the kind " +
          "prefix, so they cannot address instances here. Use " +
          "kind(ns, '<kind>').get(name) instead.",
      );
    }
  }

  return ClaydoUnion as unknown as SupervisorClass<R>;
}

/**
 * Interprets the props of a starting instance. Returns the facet props, or
 * `undefined` for the supervisor role. The runtime gives unconfigured
 * instances an empty props object, so absent, null, and empty props all
 * mean supervisor. Props that claydo did not write are a configuration
 * error, never a silent role guess.
 */
function readFacetProps(props: unknown): FacetProps | undefined {
  if (props === undefined || props === null) return undefined;
  if (typeof props === "object" && Object.keys(props).length === 0) {
    return undefined;
  }
  if (isFacetProps(props)) return props;
  throw claydoError(
    "CLAYDO_CONFIG",
    "the union class reserves ctx.props to select between its supervisor " +
      "and facet roles. Do not configure props on this class.",
  );
}

function validateRegistry(kinds: KindRegistry): void {
  for (const [name, Kind] of Object.entries(kinds)) {
    if (name.includes(":") || name.startsWith("__") || name.length === 0) {
      throw claydoError(
        "CLAYDO_CONFIG",
        `invalid kind name '${name}'. Kind names must be non-empty, must ` +
          `not contain ':', and must not start with '__'.`,
      );
    }
    let proto: object | null = Kind.prototype as object;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of RESERVED_STUB_KEYS) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (descriptor && typeof descriptor.value === "function") {
          throw claydoError(
            "CLAYDO_CONFIG",
            `kind '${name}' (class ${Kind.name}) defines a method named ` +
              `'${key}'. The stub reserves that name for metadata or ` +
              `control flow, so the method would not be callable. Rename it.`,
          );
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
  }
}

export { kind, kinds } from "./client";
export type {
  KindAccessor,
  KindNameOf,
  KindStub,
  RegistryOf,
} from "./client";
export { claydoError, isClaydoError } from "./errors";
export type { ClaydoError, ClaydoErrorCode } from "./errors";
export type {
  SupervisorClass,
  SupervisorInstance,
  UnionOptions,
} from "./supervisor";
export { instanceName } from "./types";
export type { KindClass, KindHandlers, KindRegistry } from "./types";
