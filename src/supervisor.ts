import { claydoError, claydoErrorStatus, isClaydoError } from "./errors";
import {
  INIT_HEADER,
  KIND_HEADER,
  LEGACY_KIND_KEY,
  parseKindPrefix,
  type AlarmInfo,
  type FacetIdentity,
  type KindRegistry,
} from "./types";

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
  /**
   * Runs once after a kind instance is constructed, before it serves. By
   * default claydo runs the instance's `__unsafe_ensureInitialized()`
   * hook when one exists, which covers PartyServer and the Agents SDK.
   * Set this option to adapt other frameworks with deferred setup.
   */
  onStart?: (instance: object) => void | Promise<void>;
}

/** The storage key that pins the kind of an instance. */
const KIND_KEY = "kind";

/** The storage key prefix of one kind's scheduled alarm. */
const ALARM_PREFIX = "alarm:";

/**
 * One kind's alarm entry. A plain number is a scheduled alarm. While the
 * kind's `alarm()` handler runs (and between platform retries after a
 * handler failure), the entry is a firing marker.
 */
type AlarmEntry = number | { time: number; firing: true };

function alarmTime(entry: AlarmEntry): number {
  return typeof entry === "number" ? entry : entry.time;
}

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
  #kindLoading?: Promise<string>;
  readonly #facetClasses = new Map<string, unknown>();
  /** Kinds whose alarm handler is running right now, in this isolate. */
  readonly #firing = new Set<string>();

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
      const props: FacetIdentity = { v: 1, kind, host };
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
    const prefix = parseKindPrefix(name);
    return prefix !== undefined && Object.hasOwn(this.#kinds, prefix)
      ? prefix
      : undefined;
  }

  /**
   * Resolves this instance's kind.
   *
   * Named instances carry their kind in the name (`<kind>:<name>`), which
   * stays authoritative on every request; the kind is also pinned once in
   * storage so ID-based access (`fromId()`) still resolves after the
   * instance restarts without its name. Unique-ID instances have no name
   * to parse; their kind is pinned at first contact. A pin is written
   * once and is immutable for the instance's lifetime.
   */
  async #resolveKind(
    hint: string | undefined,
    init: boolean,
  ): Promise<string> {
    this.#kindLoading ??= this.#initializeKind(hint, init).catch((error) => {
      this.#kindLoading = undefined;
      throw error;
    });
    const kind = await this.#kindLoading;
    if (hint !== undefined && hint !== kind) {
      throw claydoError(
        "CLAYDO_KIND_MISMATCH",
        `instance '${this.#identity()}' is kind '${kind}', but the ` +
          `caller expected kind '${hint}'.`,
        { actualKind: kind, expectedKind: hint },
      );
    }
    return kind;
  }

  async #initializeKind(
    hint: string | undefined,
    init: boolean,
  ): Promise<string> {
    const persisted = await this.#ctx.storage.get<unknown>([
      KIND_KEY,
      LEGACY_KIND_KEY,
    ]);
    if (persisted.get(LEGACY_KIND_KEY) !== undefined) {
      this.#config(
        `instance '${this.#identity()}' holds data written by the claydo ` +
          `0.1.x storage layout, which this version cannot serve. ` +
          `Refusing instead of serving an empty instance. Keep the claydo ` +
          `0.1.x dependency for this binding, or move the data before ` +
          `upgrading.`,
      );
    }
    const pinned = persisted.get(KIND_KEY) as string | undefined;
    const derived = this.#kindFromName();
    if (derived !== undefined) {
      // The name stays authoritative; the pin is a write-once cache that
      // lets fromId() resolve this instance after a nameless cold start.
      if (pinned === undefined) {
        await this.#ctx.storage.put(KIND_KEY, derived);
      }
      return derived;
    }
    if (pinned !== undefined) {
      if (!Object.hasOwn(this.#kinds, pinned)) {
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
    if (!Object.hasOwn(this.#kinds, hint)) {
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
    const entries = await txn.list<AlarmEntry>({ prefix: ALARM_PREFIX });
    let min: number | undefined;
    for (const entry of entries.values()) {
      const time = alarmTime(entry);
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
      const key = `${ALARM_PREFIX}${kind}`;
      const current = await txn.get<AlarmEntry>(key);
      // A firing marker outside the running handler is a failed delivery
      // awaiting its platform retry. A new schedule must not erase that
      // due work, so the earlier of the two times wins.
      const value =
        current !== undefined &&
        typeof current !== "number" &&
        !this.#firing.has(kind)
          ? Math.min(current.time, time)
          : time;
      await txn.put(key, value);
      await this.#rearm(txn);
    });
  }

  async getKindAlarm(
    kind: string,
    alarmOptions?: DurableObjectGetAlarmOptions,
  ): Promise<number | null> {
    await this.#assertKind(kind);
    const entry = await this.#ctx.storage.get<AlarmEntry>(
      `${ALARM_PREFIX}${kind}`,
      alarmOptions,
    );
    if (entry === undefined) return null;
    if (typeof entry === "number") return entry;
    // Native semantics: inside its own handler the fired alarm reads as
    // consumed; between platform retries it reads as pending.
    return this.#firing.has(kind) ? null : entry.time;
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
   * a kind alarm entry is consumed only after the kind's `alarm()` handler
   * returns, and a handler failure keeps the entry and retries through
   * the platform's native retry. A handler that re-schedules its own
   * alarm keeps the new time.
   */
  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const entries = await this.#ctx.storage.list<AlarmEntry>({
      prefix: ALARM_PREFIX,
    });
    const now = Date.now();
    const due = [...entries]
      .map(([key, entry]) => [key, alarmTime(entry)] as const)
      .filter(([, time]) => time <= now)
      .sort(([, a], [, b]) => a - b);
    for (const [key, time] of due) {
      const kind = key.slice(ALARM_PREFIX.length);
      if (!Object.hasOwn(this.#kinds, kind)) {
        console.warn(
          `claydo: dropping an alarm for kind '${kind}', which is no ` +
            `longer in the registry.`,
        );
        await this.#ctx.storage.delete(key);
        continue;
      }
      // Mark the entry as firing before dispatch: the kind's own
      // getAlarm() reads null while its handler runs, and the entry
      // itself persists so a handler failure retries.
      await this.#ctx.storage.put(key, { time, firing: true } as AlarmEntry);
      const info: AlarmInfo = {
        scheduledTime: time,
        isRetry: alarmInfo?.isRetry ?? false,
        retryCount: alarmInfo?.retryCount ?? 0,
      };
      this.#firing.add(kind);
      try {
        await this.#facet(kind).__claydoAlarm(info);
      } finally {
        this.#firing.delete(kind);
      }
      // Consume the firing marker only if the handler did not schedule a
      // new alarm (a re-schedule overwrites the entry with a number).
      await this.#ctx.storage.transaction(async (txn) => {
        const current = await txn.get<AlarmEntry>(key);
        if (
          current !== undefined &&
          typeof current !== "number" &&
          current.time === time
        ) {
          await txn.delete(key);
        }
      });
    }
    await this.#ctx.storage.transaction(async (txn) => this.#rearm(txn));
  }

  async fetch(request: Request): Promise<Response> {
    try {
      // The typed stub asserts its expected kind in a header, so a
      // wrong-kind fetch fails exactly like a wrong-kind RPC call. A
      // unique() stub also marks its first contact as init-capable, so
      // pinning costs no extra round trip.
      const hint = request.headers.get(KIND_HEADER) ?? undefined;
      const init =
        hint !== undefined && request.headers.get(INIT_HEADER) !== null;
      const kind = await this.#resolveKind(hint, init);
      // The headers are claydo transport, not part of the kind's request.
      const forwarded = new Request(request);
      forwarded.headers.delete(KIND_HEADER);
      forwarded.headers.delete(INIT_HEADER);
      return await this.#facet(kind).fetch(forwarded);
    } catch (error) {
      // Claydo's own errors become structured HTTP responses; the kind's
      // errors stay native rejections for the caller to handle.
      if (isClaydoError(error)) {
        return new Response(error.message, {
          status: claydoErrorStatus(error.code),
          headers: { "x-claydo-code": error.code },
        });
      }
      throw error;
    }
  }
}
