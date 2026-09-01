import { claydoError, type ClaydoErrorCode } from "./errors";
import type { AlarmInfo, FacetProps, KindRegistry } from "./types";

/** Options for `union()`. */
export interface UnionOptions {
  /**
   * The top-level export name of the union class. By default claydo reads
   * the name of the exported subclass, which matches the usual
   * `export class AppDO extends union({...}) {}` pattern. Set this option
   * when the export name differs from the class name, for example under a
   * minifier that renames classes.
   */
  name?: string;
}

/** The storage key that pins the kind of a unique-ID instance. */
const KIND_KEY = "kind";

/** The storage key prefix of one kind's scheduled alarm. */
const ALARM_PREFIX = "alarm:";

/** The instance type of the class that `union()` returns. */
export interface SupervisorInstance<R extends KindRegistry>
  extends Rpc.DurableObjectBranded {
  /** Type-level registry brand; `kinds()` reads it from namespace types. */
  readonly __kinds: R;
  __claydoCall(
    kind: string,
    method: string,
    args: unknown[],
    init: boolean,
  ): Promise<unknown>;
  __claydoInit(kind: string): Promise<string>;
  __claydoSetAlarm(kind: string, time: number): Promise<void>;
  __claydoGetAlarm(
    kind: string,
    options?: DurableObjectGetAlarmOptions,
  ): Promise<number | null>;
  __claydoDeleteAlarm(kind: string): Promise<void>;
  __claydoAlarm(info: AlarmInfo): Promise<void>;
  fetch(request: Request): Promise<Response>;
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void>;
}

/** The class that `union()` returns. */
export type SupervisorClass<R extends KindRegistry> = new (
  ctx: DurableObjectState,
  env: any,
) => SupervisorInstance<R>;

/** The wire surface the supervisor uses on a kind facet. */
interface FacetStub {
  __claydoCall(
    kind: string,
    method: string,
    args: unknown[],
    init: boolean,
  ): Promise<unknown>;
  __claydoAlarm(info: AlarmInfo): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

/** The shape of the union class's own entry in `ctx.exports`. */
interface OwnExportEntry {
  (options: { props?: unknown }): unknown;
  get?(id: DurableObjectId): unknown;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * The supervisor role of a union instance. It owns the instance's identity,
 * routes every interaction to the kind's facet, and multiplexes the
 * instance's single native alarm across kinds.
 */
export class SupervisorCore {
  readonly #ctx: DurableObjectState;
  readonly #kinds: KindRegistry;
  readonly #options: UnionOptions;
  readonly #className: () => string;
  #kind?: string;
  #kindLoading?: Promise<string>;
  readonly #facetClasses = new Map<string, unknown>();

  constructor(
    ctx: DurableObjectState,
    kinds: KindRegistry,
    options: UnionOptions,
    className: () => string,
  ) {
    this.#ctx = ctx;
    this.#kinds = kinds;
    this.#options = options;
    this.#className = className;
  }

  #identity(): string {
    return this.#ctx.id.name ?? this.#ctx.id.toString();
  }

  #hostExport(): string {
    return this.#options.name ?? this.#className();
  }

  #config(message: string): never {
    throw claydoError("CLAYDO_CONFIG", message);
  }

  #facets(): DurableObjectFacets {
    const facets = (
      this.#ctx as DurableObjectState & { facets?: DurableObjectFacets }
    ).facets;
    if (facets === undefined || typeof facets.get !== "function") {
      this.#config(
        "this Workers runtime does not support Durable Object facets. " +
          "Use compatibility date 2026-08-01 or later and a current " +
          "Workers runtime.",
      );
    }
    return facets;
  }

  /**
   * Returns the union class handle, configured with facet props for
   * `kind`. The facet runs the same top-level export as the supervisor;
   * the props select the facet role.
   */
  #facetClass(kind: string): unknown {
    let configured = this.#facetClasses.get(kind);
    if (configured === undefined) {
      const host = this.#hostExport();
      const entry = (
        this.#ctx.exports as unknown as Record<string, unknown>
      )[host] as OwnExportEntry | undefined;
      if (typeof entry !== "function" || typeof entry.get !== "function") {
        this.#config(
          `cannot find the union export '${host}' in the worker's ` +
            `top-level exports. Export the class returned by union() ` +
            `under that name, or pass its export name to union() as ` +
            `{ name: "..." }.`,
        );
      }
      const props: FacetProps = { claydoFacet: true, kind, host };
      configured = entry({ props });
      this.#facetClasses.set(kind, configured);
    }
    return configured;
  }

  /**
   * Returns the facet that owns this instance's kind data. `facets.get()`
   * runs on every call: it resumes or restarts the facet transparently,
   * so a stale stub is never held across a facet restart.
   */
  #facet(kind: string): FacetStub {
    const configured = this.#facetClass(kind);
    return this.#facets().get(kind, () => ({
      class: configured as never,
    })) as unknown as FacetStub;
  }

  #kindFromName(): string | undefined {
    const name = this.#ctx.id.name;
    if (name === undefined) return undefined;
    const separator = name.indexOf(":");
    if (separator === -1) return undefined;
    const prefix = name.slice(0, separator);
    return hasOwn(this.#kinds, prefix) ? prefix : undefined;
  }

  /**
   * Resolves this instance's kind.
   *
   * Named instances carry their kind in the name (`<kind>:<name>`), so
   * the kind is derived on every request and no routing state is ever
   * persisted. Unique-ID instances have no name to parse; their kind is
   * pinned in storage once, at first contact, and is immutable for the
   * instance's lifetime.
   */
  async #resolveKind(
    hint: string | undefined,
    init: boolean,
  ): Promise<string> {
    if (this.#kind === undefined) {
      this.#kindLoading ??= this.#initializeKind(hint, init).catch(
        (error) => {
          this.#kindLoading = undefined;
          throw error;
        },
      );
      this.#kind = await this.#kindLoading;
    }
    if (hint !== undefined && hint !== this.#kind) {
      throw claydoError(
        "CLAYDO_KIND_MISMATCH",
        `instance '${this.#identity()}' is kind '${this.#kind}', but ` +
          `the caller expected kind '${hint}'.`,
        { actualKind: this.#kind, expectedKind: hint },
      );
    }
    return this.#kind;
  }

  async #initializeKind(
    hint: string | undefined,
    init: boolean,
  ): Promise<string> {
    const derived = this.#kindFromName();
    if (derived !== undefined) return derived;
    const pinned = await this.#ctx.storage.get<string>(KIND_KEY);
    if (pinned !== undefined) {
      if (!hasOwn(this.#kinds, pinned)) {
        throw claydoError(
          "CLAYDO_UNKNOWN_KIND",
          `instance '${this.#identity()}' is kind '${pinned}', which is ` +
            `not in the registry. Registered kinds: ` +
            `${Object.keys(this.#kinds).join(", ")}.`,
        );
      }
      return pinned;
    }
    if (hint === undefined || !init) {
      throw this.#noKindError(hint, init);
    }
    if (!hasOwn(this.#kinds, hint)) {
      throw claydoError(
        "CLAYDO_UNKNOWN_KIND",
        `unknown kind '${hint}'. Registered kinds: ` +
          `${Object.keys(this.#kinds).join(", ")}.`,
      );
    }
    await this.#ctx.storage.put(KIND_KEY, hint);
    return hint;
  }

  #noKindError(hint: string | undefined, init: boolean): Error {
    const identity = this.#identity();
    const base = `instance '${identity}' has no kind yet.`;
    const name = this.#ctx.id.name;
    if (name !== undefined) {
      return claydoError(
        "CLAYDO_UNINITIALIZED",
        `${base} Its name has no registered '<kind>:' prefix. Raw ` +
          `namespace access (for example getByName('${name}')) reaches ` +
          `a different instance than kind(ns, '<kind>').get('${name}'). ` +
          `Reach instances through the kind() helper, or use a ` +
          `'<kind>:' prefixed name.`,
      );
    }
    if (hint !== undefined && !init) {
      return claydoError(
        "CLAYDO_UNINITIALIZED",
        `${base} It was accessed as kind '${hint}' through fromId(), ` +
          `which never initializes an instance. Create the instance ` +
          `first with kind(ns, '${hint}').get(name) or .unique(), then ` +
          `reach it by ID.`,
      );
    }
    return claydoError(
      "CLAYDO_UNINITIALIZED",
      `${base} Unique-ID instances initialize on their first call ` +
        `through kind(ns, '<kind>').unique().`,
    );
  }

  async call(
    kind: string,
    method: string,
    args: unknown[],
    init: boolean,
  ): Promise<unknown> {
    const resolved = await this.#resolveKind(kind, init);
    return this.#facet(resolved).__claydoCall(resolved, method, args, init);
  }

  async init(kind: string): Promise<string> {
    return this.#resolveKind(kind, true);
  }

  async #assertKind(kind: string): Promise<void> {
    const resolved = await this.#resolveKind(undefined, false);
    if (kind !== resolved) {
      throw claydoError(
        "CLAYDO_KIND_MISMATCH",
        `kind '${kind}' cannot control the alarm of instance ` +
          `'${this.#identity()}', which is kind '${resolved}'.`,
        { actualKind: resolved, expectedKind: kind },
      );
    }
  }

  /** Re-arms the native alarm to the earliest scheduled kind alarm. */
  async #rearm(txn: DurableObjectTransaction): Promise<void> {
    const entries = await txn.list<number>({ prefix: ALARM_PREFIX });
    let min: number | undefined;
    for (const time of entries.values()) {
      if (min === undefined || time < min) min = time;
    }
    if (min === undefined) {
      await txn.deleteAlarm();
    } else {
      await txn.setAlarm(min);
    }
  }

  async setKindAlarm(kind: string, time: number): Promise<void> {
    await this.#assertKind(kind);
    await this.#ctx.storage.transaction(async (txn) => {
      await txn.put(`${ALARM_PREFIX}${kind}`, time);
      await this.#rearm(txn);
    });
  }

  async getKindAlarm(
    kind: string,
    alarmOptions?: DurableObjectGetAlarmOptions,
  ): Promise<number | null> {
    await this.#assertKind(kind);
    const time = await this.#ctx.storage.get<number>(
      `${ALARM_PREFIX}${kind}`,
      alarmOptions,
    );
    return time ?? null;
  }

  async deleteKindAlarm(kind: string): Promise<void> {
    await this.#assertKind(kind);
    await this.#ctx.storage.transaction(async (txn) => {
      await txn.delete(`${ALARM_PREFIX}${kind}`);
      await this.#rearm(txn);
    });
  }

  /**
   * Dispatches every due kind alarm, then re-arms the native alarm.
   *
   * Alarm delivery is at-least-once relative to the kind's data writes:
   * a kind alarm entry is deleted only after the kind's `alarm()` handler
   * returns, and a handler failure keeps the entry and retries through
   * the platform's native retry. A handler that re-schedules its own
   * alarm keeps the new time: the entry is deleted only when it still
   * holds the time that just fired.
   */
  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const entries = await this.#ctx.storage.list<number>({
      prefix: ALARM_PREFIX,
    });
    const now = Date.now();
    const due = [...entries]
      .filter(([, time]) => time <= now)
      .sort(([, a], [, b]) => a - b);
    for (const [key, time] of due) {
      const kind = key.slice(ALARM_PREFIX.length);
      if (!hasOwn(this.#kinds, kind)) {
        console.warn(
          `claydo: dropping an alarm for kind '${kind}', which is no ` +
            `longer in the registry.`,
        );
        await this.#ctx.storage.delete(key);
        continue;
      }
      const info: AlarmInfo = {
        scheduledTime: time,
        isRetry: alarmInfo?.isRetry ?? false,
        retryCount: alarmInfo?.retryCount ?? 0,
      };
      await this.#facet(kind).__claydoAlarm(info);
      await this.#ctx.storage.transaction(async (txn) => {
        const current = await txn.get<number>(key);
        if (current === time) await txn.delete(key);
      });
    }
    await this.#ctx.storage.transaction(async (txn) => this.#rearm(txn));
  }

  async fetch(request: Request): Promise<Response> {
    let kind: string;
    try {
      kind = await this.#resolveKind(undefined, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: ClaydoErrorCode }).code;
      return new Response(message, {
        status: code === "CLAYDO_UNINITIALIZED" ? 404 : 500,
      });
    }
    return this.#facet(kind).fetch(request);
  }
}
