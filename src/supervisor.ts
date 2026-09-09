import { claydoError, claydoErrorStatus, isClaydoError } from "./errors";
import { reviveThrown, type FacetCallResult } from "./facet";
import {
  FACET_IDENTITY_KEY,
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
 * One kind's alarm entry.
 *
 * The entry is a small state machine with two states:
 *
 * - **scheduled**: a plain number, the pending alarm time.
 * - **firing**: `{ time, firing, attempts, next? }` — a delivery of `time`
 *   is running or has failed and awaits retry. `attempts` counts per-kind
 *   delivery attempts; `next` carries a schedule the kind set while the
 *   delivery was in flight, so a retry can never erase it.
 *
 * Consuming a successful delivery promotes `next` to a scheduled entry or
 * deletes the entry. Every transition re-reads the entry inside a
 * transaction and gives up when another writer got there first.
 */
type AlarmEntry = number | FiringEntry;

interface FiringEntry {
  time: number;
  firing: true;
  attempts: number;
  next?: number;
}

function isFiring(entry: AlarmEntry): entry is FiringEntry {
  return typeof entry !== "number";
}

/**
 * The supervisor's own re-fire pacing for a firing entry, so a failed
 * delivery is retried even after the platform's native retries exhaust,
 * without hot-looping a permanently failing handler.
 */
function retryFloor(attempts: number): number {
  return Math.min(1000 * 2 ** Math.min(attempts, 6), 60_000);
}

/** The time the native alarm must be armed for, for one entry. */
function rearmTime(entry: AlarmEntry): number {
  if (!isFiring(entry)) return entry;
  const retryAt = entry.time + retryFloor(entry.attempts);
  return entry.next === undefined ? retryAt : Math.min(entry.next, retryAt);
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
  ): Promise<FacetCallResult>;
  __claydoAlarm(info: AlarmInfo): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

/** The shape of the union class's own entry in `ctx.exports`. */
interface OwnExportEntry {
  (options: { props?: unknown }): unknown;
  get?(id: DurableObjectId): unknown;
}

/** Releases a per-call facet stub handle once its call settled. */
function disposeStub(stub: unknown): void {
  const disposeSymbol = (Symbol as { dispose?: symbol }).dispose;
  if (disposeSymbol === undefined) return;
  const dispose = (stub as Record<symbol, unknown>)[disposeSymbol];
  if (typeof dispose === "function") {
    try {
      (dispose as (this: unknown) => void).call(stub);
    } catch {
      // Never let handle cleanup mask the call's own outcome.
    }
  }
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

  #legacyLayoutError(): never {
    this.#config(
      `instance '${this.#identity()}' holds data written by the claydo ` +
        `0.1.x storage layout, which this version cannot serve. Refusing ` +
        `instead of serving an empty instance. Keep the claydo 0.1.x ` +
        `dependency for this binding, or move the data before upgrading.`,
    );
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
   * Returns the union class handle, configured for `kind`. The facet runs
   * the same top-level export as the supervisor. Claydo's identity travels
   * under the one reserved props field; the supervisor's own configured
   * props (if any) pass through to the kind.
   */
  #facetClass(kind: string): unknown {
    const host = this.#hostExport();
    const entry = (this.#ctx.exports as unknown as Record<string, unknown>)[
      host
    ] as OwnExportEntry | undefined;
    if (typeof entry !== "function" || typeof entry.get !== "function") {
      this.#config(
        `cannot find the union export '${host}' in the worker's ` +
          `top-level exports. Export the class returned by union() ` +
          `under that name, or pass its export name to union() as ` +
          `{ name: "..." }.`,
      );
    }
    const identity: FacetIdentity = { v: 1, kind, host };
    const ownProps = (this.#ctx as { props?: unknown }).props;
    const passthrough =
      typeof ownProps === "object" && ownProps !== null
        ? (ownProps as Record<string, unknown>)
        : {};
    // A binding-configured reserved field would be silently overwritten
    // here (and a valid-shaped one would already have selected the
    // facet role at construction), so any own reserved key on the
    // binding props fails loudly instead.
    if (Object.hasOwn(passthrough, FACET_IDENTITY_KEY)) {
      this.#config(
        `the binding props of this union class define the reserved ` +
          `'${FACET_IDENTITY_KEY}' field. Claydo owns that field; ` +
          `remove it from the binding configuration.`,
      );
    }
    return entry({ props: { ...passthrough, [FACET_IDENTITY_KEY]: identity } });
  }

  /**
   * Returns the facet that owns this instance's kind data. The class
   * handle and the stub are created per call and the handle is released
   * as soon as `facets.get()` has consumed it: `facets.get()` resumes or
   * restarts the facet transparently, so a stale stub is never held
   * across a facet restart, and no capability handle outlives its use
   * (an undisposed handle draws runtime warnings when collected).
   */
  #facet(kind: string): FacetStub {
    const configured = this.#facetClass(kind);
    const stub = this.#facets().get(kind, () => ({
      class: configured as never,
    })) as unknown as FacetStub;
    disposeStub(configured);
    return stub;
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
      this.#legacyLayoutError();
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
      const prefix = parseKindPrefix(name);
      if (prefix !== undefined) {
        return claydoError(
          "CLAYDO_UNKNOWN_KIND",
          `instance name '${name}' carries the prefix '${prefix}', which ` +
            `is not a registered kind. Registered kinds: ` +
            `${Object.keys(this.#kinds).join(", ")}.`,
        );
      }
      return claydoError(
        "CLAYDO_UNINITIALIZED",
        `${base} Its name has no '<kind>:' prefix. Raw namespace access ` +
          `(for example getByName('${name}')) reaches a different ` +
          `instance than kind(ns, '<kind>').get('${name}'). Reach ` +
          `instances through the kind() helper, or use a '<kind>:' ` +
          `prefixed name.`,
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
    const facet = this.#facet(resolved);
    let result: FacetCallResult;
    try {
      result = await facet.__claydoCall(resolved, method, args, init);
    } finally {
      disposeStub(facet);
    }
    // A thrown kind error crossed the internal hop as a value; rethrow it
    // exactly once, so the caller gets a native error and the runtime
    // logs a single event instead of one per hop.
    if (!result.ok) throw reviveThrown(result.error);
    return result.value;
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

  /** Re-arms the native alarm to the earliest relevant alarm time. */
  async #rearmIn(txn: DurableObjectTransaction): Promise<void> {
    const entries = await txn.list<AlarmEntry>({ prefix: ALARM_PREFIX });
    let min: number | undefined;
    for (const entry of entries.values()) {
      const time = rearmTime(entry);
      if (min === undefined || time < min) min = time;
    }
    if (min === undefined) {
      await txn.deleteAlarm();
    } else {
      await txn.setAlarm(min);
    }
  }

  async #rearm(): Promise<void> {
    await this.#ctx.storage.transaction(async (txn) => this.#rearmIn(txn));
  }

  async setKindAlarm(kind: string, time: number): Promise<void> {
    await this.#assertKind(kind);
    await this.#ctx.storage.transaction(async (txn) => {
      const key = `${ALARM_PREFIX}${kind}`;
      const current = await txn.get<AlarmEntry>(key);
      if (current !== undefined && isFiring(current)) {
        // A delivery of `current.time` is in flight (running, or awaiting
        // retry after a failure). The new schedule rides alongside in
        // `next`; it becomes the scheduled alarm when the delivery
        // consumes, and the due retry is never erased.
        await txn.put(key, { ...current, next: time } satisfies FiringEntry);
      } else {
        await txn.put(key, time);
      }
      await this.#rearmIn(txn);
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
    if (!isFiring(entry)) return entry;
    // Native semantics: inside its own handler the fired alarm reads as
    // consumed (or as the re-schedule the handler already made); between
    // the retries of a failed delivery it reads as pending.
    if (entry.next !== undefined) return entry.next;
    return this.#firing.has(kind) ? null : entry.time;
  }

  async deleteKindAlarm(kind: string): Promise<void> {
    await this.#assertKind(kind);
    await this.#ctx.storage.transaction(async (txn) => {
      await txn.delete(`${ALARM_PREFIX}${kind}`);
      await this.#rearmIn(txn);
    });
  }

  /**
   * Dispatches every due kind alarm, then re-arms the native alarm.
   *
   * Alarm delivery is at-least-once relative to the kind's data writes: a
   * kind alarm entry is consumed only after the kind's `alarm()` handler
   * returns, and a handler failure keeps the entry and retries — through
   * the platform's native retry first, and through the supervisor's own
   * paced re-fire after native retries exhaust. One kind's failure never
   * blocks another kind's delivery, and re-arming always runs.
   */
  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    if (
      (await this.#ctx.storage.get<unknown>(LEGACY_KIND_KEY)) !== undefined
    ) {
      // A 0.1.x instance can hold a pending native alarm and user keys
      // that collide with the alarm prefix. Touch nothing.
      this.#legacyLayoutError();
    }
    const entries = await this.#ctx.storage.list<AlarmEntry>({
      prefix: ALARM_PREFIX,
    });
    const now = Date.now();
    const due = [...entries]
      .map(
        ([key, entry]) =>
          [key, isFiring(entry) ? entry.time : entry] as const,
      )
      .filter(([, time]) => time <= now)
      .sort(([, a], [, b]) => a - b);
    let firstFailure: unknown;
    try {
      for (const [key, snapshotTime] of due) {
        const kind = key.slice(ALARM_PREFIX.length);
        if (!Object.hasOwn(this.#kinds, kind)) {
          console.warn(
            `claydo: dropping an alarm for kind '${kind}', which is no ` +
              `longer in the registry.`,
          );
          await this.#ctx.storage.delete(key);
          continue;
        }
        // Mark the entry as firing with a compare-and-set: a concurrent
        // delete or re-schedule since the snapshot wins, and the kind is
        // skipped this round. The marker persists through a handler
        // failure, so the delivery retries; `attempts` is this kind's own
        // delivery count.
        const marked = await this.#ctx.storage.transaction(
          async (txn): Promise<FiringEntry | undefined> => {
            const current = await txn.get<AlarmEntry>(key);
            if (current === undefined) return undefined;
            const time = isFiring(current) ? current.time : current;
            if (time !== snapshotTime) return undefined;
            const marker: FiringEntry = isFiring(current)
              ? { ...current, attempts: current.attempts + 1 }
              : { time, firing: true, attempts: 1 };
            await txn.put(key, marker);
            return marker;
          },
        );
        if (marked === undefined) continue;
        const info: AlarmInfo = {
          scheduledTime: marked.time,
          isRetry: marked.attempts > 1,
          retryCount: marked.attempts - 1,
        };
        this.#firing.add(kind);
        try {
          const facet = this.#facet(kind);
          try {
            await facet.__claydoAlarm(info);
          } finally {
            disposeStub(facet);
          }
          // Consume with a compare-and-set: promote a schedule the
          // handler (or a concurrent caller) set while the delivery ran,
          // otherwise delete. The in-flight flag clears only after the
          // consume commits, so reads never see a half-consumed state.
          await this.#ctx.storage.transaction(async (txn) => {
            const current = await txn.get<AlarmEntry>(key);
            if (
              current !== undefined &&
              isFiring(current) &&
              current.time === marked.time
            ) {
              if (current.next !== undefined) {
                await txn.put(key, current.next);
              } else {
                await txn.delete(key);
              }
            }
          });
        } catch (error) {
          firstFailure ??= error;
        } finally {
          this.#firing.delete(kind);
        }
      }
    } finally {
      await this.#rearm();
    }
    if (firstFailure !== undefined) throw firstFailure;
  }

  async fetch(request: Request): Promise<Response> {
    let facet: FacetStub;
    let forwarded: Request;
    try {
      // The typed stub asserts its expected kind in a header, so a
      // wrong-kind fetch fails exactly like a wrong-kind RPC call. The
      // init marker allows first-contact pinning in the same round trip.
      const hint = request.headers.get(KIND_HEADER) ?? undefined;
      const init =
        hint !== undefined && request.headers.get(INIT_HEADER) !== null;
      const kind = await this.#resolveKind(hint, init);
      // The headers are claydo transport, not part of the kind's request,
      // and `cf` does not survive Request cloning on its own.
      const cf = (request as { cf?: unknown }).cf;
      forwarded = new Request(
        request,
        cf === undefined ? undefined : ({ cf } as RequestInit),
      );
      forwarded.headers.delete(KIND_HEADER);
      forwarded.headers.delete(INIT_HEADER);
      facet = this.#facet(kind);
    } catch (error) {
      // Only routing and configuration errors reach this catch; they
      // become structured HTTP responses. The kind's own errors — thrown
      // below, outside this try — stay native rejections.
      if (isClaydoError(error)) {
        return new Response(error.message, {
          status: claydoErrorStatus(error.code),
          headers: { "x-claydo-code": error.code },
        });
      }
      throw error;
    }
    try {
      return await facet.fetch(forwarded);
    } finally {
      disposeStub(facet);
    }
  }
}
