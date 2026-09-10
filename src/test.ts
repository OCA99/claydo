/**
 * Test helpers for claydo applications. Import from `claydo/test` inside
 * `@cloudflare/vitest-pool-workers` suites only: this module depends on
 * `cloudflare:test`.
 */
import { runInDurableObject } from "cloudflare:test";
import type { KindStub } from "./client";

/** The storage key prefix of one kind's scheduled alarm. */
const ALARM_PREFIX = "alarm:";

type StubLike = DurableObjectStub | { stub: DurableObjectStub };

function rawStub(stub: StubLike): DurableObjectStub {
  return "stub" in stub && typeof stub.stub === "object"
    ? (stub as { stub: DurableObjectStub }).stub
    : (stub as DurableObjectStub);
}

/**
 * Fires an instance's scheduled kind alarm now, without waiting for its
 * scheduled time. Accepts a typed kind stub or a raw Durable Object stub.
 *
 * Returns `true` when an alarm was scheduled and its handler ran, `false`
 * when no alarm was scheduled. A handler failure rejects, like a real
 * delivery; the platform does not retry a forced delivery, so re-run the
 * helper to retry.
 *
 * Test-only: the helper rewrites the pending alarm's scheduled time to
 * now, so the handler observes the forced time, and per-kind retry
 * counters reset. Production alarm semantics are unchanged.
 *
 * @example
 * import { fireScheduledAlarm } from "claydo/test";
 * const reminder = kinds(env.APP_DO).reminder.get("r1");
 * await reminder.remindAt(Date.now() + 60_000, "hello");
 * await fireScheduledAlarm(reminder);
 */
export async function fireScheduledAlarm(
  stub: StubLike | KindStub<unknown>,
): Promise<boolean> {
  return runInDurableObject(
    rawStub(stub as StubLike) as never,
    async (instance: unknown, ctx: DurableObjectState) => {
      const entries = await ctx.storage.list<unknown>({
        prefix: ALARM_PREFIX,
      });
      if (entries.size === 0) return false;
      const now = Date.now();
      for (const key of entries.keys()) {
        await ctx.storage.put(key, now);
      }
      await (instance as { alarm(): Promise<void> }).alarm();
      return true;
    },
  );
}
