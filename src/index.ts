import { createFacetClass } from "./facet";
import {
  createSupervisorClass,
  type SupervisorClass,
  type UnionOptions,
} from "./supervisor";
import { RESERVED_STUB_KEYS, type KindRegistry } from "./types";
import { claydoError } from "./errors";

/**
 * Creates one Durable Object class that hosts every registered kind.
 *
 * Each instance of the returned class is one kind instance. The class is a
 * thin supervisor: it owns the instance's identity and its native alarm,
 * and it runs the kind implementation inside a Durable Object facet with
 * its own isolated SQLite database.
 *
 * Export the returned class, and export its facet class next to it under
 * the same name plus `Facet`:
 *
 * @example
 * export class AppDO extends union({ counter: Counter, chat: ChatRoom }) {}
 * export const AppDOFacet = AppDO.Facet;
 *
 * In the wrangler configuration, bind `AppDO` and list both classes as new
 * SQLite classes. The facet class needs no binding.
 */
export function union<R extends KindRegistry>(
  kinds: R,
  options: UnionOptions = {},
): SupervisorClass<R> {
  validateRegistry(kinds);
  const Supervisor = createSupervisorClass(kinds, options);
  Object.defineProperty(Supervisor, "Facet", {
    value: createFacetClass(kinds),
  });
  return Supervisor as unknown as SupervisorClass<R>;
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
