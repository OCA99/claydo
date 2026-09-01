import { DurableObject } from "cloudflare:workers";
import { claydoError } from "./errors";
import { FacetCore, readFacetIdentity } from "./facet";
import {
  SupervisorCore,
  type SupervisorClass,
  type UnionOptions,
} from "./supervisor";
import {
  RESERVED_STUB_KEYS,
  type AlarmInfo,
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
      // Role selection happens exactly once, before any other code runs:
      // supervisor without a facet identity, facet with one (from props,
      // or from the persisted record on a propless wake).
      const role = readFacetIdentity(ctx);
      super(ctx, env);
      this.#core =
        role === undefined
          ? new SupervisorCore(ctx, kinds, options, () =>
              this.constructor.name,
            )
          : new FacetCore(
              ctx,
              env,
              role.identity,
              role.persisted,
              kinds,
              options,
            );
    }

    #supervisor(): SupervisorCore {
      if (!(this.#core instanceof SupervisorCore)) {
        throw claydoError(
          "CLAYDO_CONFIG",
          "this method is internal to claydo and is not available on a " +
            "kind facet.",
        );
      }
      return this.#core;
    }

    #facet(): FacetCore {
      if (!(this.#core instanceof FacetCore)) {
        throw claydoError(
          "CLAYDO_CONFIG",
          "this method is internal to claydo and is not available on a " +
            "supervisor.",
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
      return this.#core.call(kind, method, args, init);
    }

    async __claydoSetAlarm(kind: string, time: number): Promise<void> {
      return this.#supervisor().setKindAlarm(kind, time);
    }

    async __claydoGetAlarm(
      kind: string,
      options?: DurableObjectGetAlarmOptions,
    ): Promise<number | null> {
      return this.#supervisor().getKindAlarm(kind, options);
    }

    async __claydoDeleteAlarm(kind: string): Promise<void> {
      return this.#supervisor().deleteKindAlarm(kind);
    }

    async __claydoAlarm(info: AlarmInfo): Promise<void> {
      return this.#facet().deliverAlarm(info);
    }

    async fetch(request: Request): Promise<Response> {
      return this.#core.fetch(request);
    }

    async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
      // A facet has no native alarm; the supervisor delivers kind alarms
      // through __claydoAlarm.
      return this.#supervisor().alarm(alarmInfo);
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
