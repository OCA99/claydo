import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isClaydoError, kinds } from "../../../src/index";

const app = kinds(env.APP_DO);

/** The raw Durable Object stub for a named scheduler instance. */
function rawStub(name: string) {
  return env.APP_DO.get(app.scheduler.idFromName(name));
}

/** Polls until `ok` accepts the read value, or the deadline passes. */
async function eventually<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("scheduling basics", () => {
  it("schedules jobs and lists them earliest-first", async () => {
    const s = app.scheduler.get("basics");
    const now = Date.now();
    await s.schedule("later", now + 30_000);
    await s.schedule("sooner", { delayMs: 10_000 });
    const jobs = await s.list();
    expect(jobs.map((j) => j.name)).toEqual(["sooner", "later"]);
    // The alarm is armed for the earliest job.
    expect(await s.alarmTime()).toBe(jobs[0]!.at);
  });

  it("rescheduling the same name updates its time", async () => {
    const s = app.scheduler.get("resched");
    await s.schedule("job", Date.now() + 60_000);
    const updated = await s.schedule("job", Date.now() + 5_000);
    const jobs = await s.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.at).toBe(updated.at);
    expect(await s.alarmTime()).toBe(updated.at);
  });

  it("cancel removes a job and reports whether it existed", async () => {
    const s = app.scheduler.get("cancel");
    const now = Date.now();
    await s.schedule("keep", now + 20_000);
    await s.schedule("drop", now + 10_000);
    expect(await s.cancel("drop")).toBe(true);
    expect(await s.cancel("never-existed")).toBe(false);
    expect((await s.list()).map((j) => j.name)).toEqual(["keep"]);
    // The alarm re-armed for the remaining job.
    expect(await s.alarmTime()).toBe(now + 20_000);
  });

  it("cancelling the last job clears the alarm", async () => {
    const s = app.scheduler.get("cancel-last");
    await s.schedule("only", Date.now() + 10_000);
    await s.cancel("only");
    expect(await s.alarmTime()).toBeNull();
  });

  it("jobs survive stub recreation", async () => {
    const now = Date.now();
    await app.scheduler.get("survive").schedule("a", now + 9_000);
    // A brand new accessor + stub sees the same SQLite state.
    const again = app.scheduler.get("survive");
    expect((await again.list()).map((j) => j.name)).toEqual(["a"]);
  });

  it("exposes the logical name via instanceName()", async () => {
    const s = app.scheduler.get("who");
    expect(await s.whoAmI()).toBe("who");
    expect(s.name).toBe("who");
    expect(s.kind).toBe("scheduler");
  });
});

describe("alarm delivery", () => {
  it("fires jobs in order, re-arming after each one", async () => {
    const s = app.scheduler.get("order");
    const now = Date.now();
    await s.schedule("third", now + 90);
    await s.schedule("first", { delayMs: 30 });
    await s.schedule("second", now + 60);
    expect((await s.list()).map((j) => j.name)).toEqual([
      "first",
      "second",
      "third",
    ]);

    const fired = await eventually(
      () => s.fired(),
      (rows) => rows.length === 3,
    );
    expect(fired.map((f) => f.name)).toEqual(["first", "second", "third"]);
    expect(await s.list()).toEqual([]);
    expect(await s.alarmTime()).toBeNull();
  });

  it("delivers at-least-once: a throwing handler retries", async () => {
    const s = app.scheduler.get("retry");
    // The first alarm invocation throws, keeping the job pending; the
    // platform's native retry runs the handler again and the job fires.
    await s.failNextRun();
    await s.schedule("resilient", { delayMs: 25 });
    const fired = await eventually(
      () => s.fired(),
      (rows) => rows.length === 1,
    );
    expect(fired[0]!.name).toBe("resilient");
    expect(fired[0]!.wasRetry).toBe(1);
    expect(await s.list()).toEqual([]);
    expect(await s.alarmTime()).toBeNull();
  });
});

describe("alarm bookkeeping", () => {
  it("arms the instance's native alarm for the earliest job", async () => {
    const s = app.scheduler.get("native");
    const at = Date.now() + 60_000;
    await s.schedule("job", at);
    // The kind's alarm state lives with the instance, in supervisor
    // storage, outside the kind's own database.
    const [native, keys] = await runInDurableObject(
      rawStub("native"),
      async (_instance, ctx) => [
        await ctx.storage.getAlarm(),
        [...(await ctx.storage.list()).keys()],
      ],
    );
    expect(native).toBe(at);
    expect(keys.sort()).toEqual(["alarm:scheduler", "kind"]);
  });
});

describe("storage lifecycle", () => {
  it("deleteAll clears the jobs but keeps a pending alarm", async () => {
    const s = app.scheduler.get("wipe");
    const at = Date.now() + 60_000;
    await s.schedule("gone", at);
    await s.wipe();
    expect(await s.list()).toEqual([]);
    expect(await s.fired()).toEqual([]);
    // Same as native Durable Objects: deleteAll() does not cancel the
    // alarm. It must be deleted explicitly.
    expect(await s.alarmTime()).toBe(at);
    await s.disarm();
    expect(await s.alarmTime()).toBeNull();
  });

  it("fromId reaches an existing unique instance, never a new one", async () => {
    const created = app.scheduler.unique();
    expect(created.name).toBeUndefined();
    await created.schedule("job", Date.now() + 60_000);
    const again = app.scheduler.fromId(created.id.toString());
    expect((await again.list()).map((j) => j.name)).toEqual(["job"]);
    await again.cancel("job");

    // fromId() never initializes: an id that was never contacted fails.
    const untouched = app.scheduler.unique();
    const error = await app.scheduler
      .fromId(untouched.id.toString())
      .list()
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(isClaydoError(error)).toBe(true);
    expect(isClaydoError(error) && error.code).toBe("CLAYDO_UNINITIALIZED");
  });
});

describe("stub errors", () => {
  it("calling an undefined method fails with CLAYDO_NO_METHOD", async () => {
    const s = app.scheduler.get("typo");
    const error = await (s as any).schedul("x", 1).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(isClaydoError(error)).toBe(true);
    expect(isClaydoError(error) && error.code).toBe("CLAYDO_NO_METHOD");
  });
});
