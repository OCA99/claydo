import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { kind } from "../../../src/index";

// GUARD: the repository's root vitest config has no `include` filter, so a
// bare `npx vitest run` from the repo root sweeps up this file and runs it
// against the WRONG worker (test/fixtures/worker.ts, which has no
// `scheduler` kind). Detect that and skip. Run this suite with:
//   npx vitest run --config examples/alarm-scheduler/vitest.config.ts
const hostedHere =
  (await env.APP_DO.get(
    env.APP_DO.idFromName("scheduler:__config-probe"),
  ).__gdoKind()) === "scheduler";
const describeHosted = describe.skipIf(!hostedHere);

/** Convenience: the raw stub for a named scheduler instance. */
function rawSchedulerStub(name: string) {
  return env.APP_DO.get(env.APP_DO.idFromName(`scheduler:${name}`));
}

describeHosted("scheduling basics", () => {
  it("schedules jobs and lists them earliest-first", async () => {
    const s = kind(env.APP_DO, "scheduler").get("basics");
    const now = Date.now();
    await s.schedule("later", now + 30_000);
    await s.schedule("sooner", { delayMs: 10_000 });
    const jobs = await s.list();
    expect(jobs.map((j) => j.name)).toEqual(["sooner", "later"]);
    // The single DO alarm is armed for the earliest job.
    const alarmAt = await s.alarmTime();
    expect(alarmAt).toBe(jobs[0]!.at);
  });

  it("rescheduling the same name updates its time", async () => {
    const s = kind(env.APP_DO, "scheduler").get("resched");
    await s.schedule("job", Date.now() + 60_000);
    const updated = await s.schedule("job", Date.now() + 5_000);
    const jobs = await s.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.at).toBe(updated.at);
    expect(await s.alarmTime()).toBe(updated.at);
  });

  it("cancel removes a job and reports whether it existed", async () => {
    const s = kind(env.APP_DO, "scheduler").get("cancel");
    const now = Date.now();
    await s.schedule("keep", now + 20_000);
    await s.schedule("drop", now + 10_000);
    expect(await s.cancel("drop")).toBe(true);
    expect(await s.cancel("never-existed")).toBe(false);
    expect((await s.list()).map((j) => j.name)).toEqual(["keep"]);
    // The alarm re-armed for the remaining job.
    expect(await s.alarmTime()).toBe(now + 20_000);
  });

  it("cancelling the last job clears the DO alarm", async () => {
    const s = kind(env.APP_DO, "scheduler").get("cancel-last");
    await s.schedule("only", Date.now() + 10_000);
    await s.cancel("only");
    expect(await s.alarmTime()).toBeNull();
    expect(await runDurableObjectAlarm(rawSchedulerStub("cancel-last"))).toBe(
      false,
    );
  });

  it("jobs survive stub recreation", async () => {
    const now = Date.now();
    await kind(env.APP_DO, "scheduler").get("survive").schedule("a", now + 9_000);
    // A brand new accessor + stub sees the same SQLite state.
    const again = kind(env.APP_DO, "scheduler").get("survive");
    expect((await again.list()).map((j) => j.name)).toEqual(["a"]);
  });

  it("exposes the logical name via instanceName()", async () => {
    const s = kind(env.APP_DO, "scheduler").get("who");
    expect(await s.whoAmI()).toBe("who");
    expect(s.name).toBe("who");
    expect(s.kind).toBe("scheduler");
  });
});

describeHosted("alarm multiplexing", () => {
  it("fires jobs in order, re-arming after each one", async () => {
    // NOTE: in the workers vitest pool, alarms whose time has arrived fire
    // for real. Past-dated jobs race any manual runDurableObjectAlarm call,
    // so this test schedules short real delays and waits for natural firing.
    const s = kind(env.APP_DO, "scheduler").get("order");
    const now = Date.now();
    await s.schedule("third", now + 90);
    await s.schedule("first", { delayMs: 30 });
    await s.schedule("second", now + 60);
    expect((await s.list()).map((j) => j.name)).toEqual([
      "first",
      "second",
      "third",
    ]);

    await vi.waitFor(
      async () => {
        expect(await s.fired()).toHaveLength(3);
      },
      { timeout: 5_000, interval: 25 },
    );
    expect((await s.fired()).map((f) => f.name)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(await s.list()).toEqual([]);
    expect(await s.alarmTime()).toBeNull();
    // No alarm remains; the runner reports nothing to do.
    expect(await runDurableObjectAlarm(rawSchedulerStub("order"))).toBe(false);
  });

  it("an early alarm (no due job) fires nothing and stays armed", async () => {
    const s = kind(env.APP_DO, "scheduler").get("early");
    const at = Date.now() + 60_000;
    await s.schedule("future", at);
    // runDurableObjectAlarm forces the alarm to run even though the alarm
    // time is in the future; the scheduler must tolerate a spurious wake.
    expect(await runDurableObjectAlarm(rawSchedulerStub("early"))).toBe(true);
    expect(await s.fired()).toEqual([]);
    expect((await s.list()).map((j) => j.name)).toEqual(["future"]);
    expect(await s.alarmTime()).toBe(at);
  });

  it("fires on a cold instance: kind resolves from storage, no caller hint", async () => {
    const s = kind(env.APP_DO, "scheduler").get("cold");
    await s.schedule("wake-up", { delayMs: 150 });

    // Force the instance out of memory. The in-flight RPC dies with the
    // abort, so the client stub call rejects with the abort reason.
    await expect(s.crash()).rejects.toThrow("scheduler crashed on purpose");

    // GOTCHA: after abort, the OLD stub `s` is permanently broken. Every
    // further call through it rejects with the abort reason too.
    await expect(s.list()).rejects.toThrow("scheduler crashed on purpose");

    // The alarm now arrives at a cold instance, with no client hint on the
    // alarm path: the host must resolve `scheduler` from storage. Use a
    // FRESH stub to observe the result.
    const fresh = kind(env.APP_DO, "scheduler").get("cold");
    await vi.waitFor(
      async () => {
        expect((await fresh.fired()).map((f) => f.name)).toEqual(["wake-up"]);
      },
      { timeout: 5_000, interval: 25 },
    );
    expect(await fresh.list()).toEqual([]);
  });
});

describeHosted("DX probes (adversarial)", () => {
  it("PROBE: a throwing kind alarm() surfaces through runDurableObjectAlarm", async () => {
    const s = kind(env.APP_DO, "scheduler").get("poison");
    // The scheduler treats a job named "poison" as a deliberate crash.
    // Schedule it far in the future so it cannot fire naturally, then force
    // it: this is the only deterministic way to observe the alarm error.
    await s.schedule("poison", Date.now() + 60_000);
    // POST-FIX: forwarded-handler errors are logged with kind + instance
    // context before rethrowing, so natural firings (whose errors never
    // reach a caller) leave an attributable trace.
    const errorSpy = vi.spyOn(console, "error");
    await expect(
      runDurableObjectAlarm(rawSchedulerStub("poison")),
    ).rejects.toThrow("poison job exploded");
    expect(errorSpy).toHaveBeenCalledWith(
      "generic-durable-objects: alarm() failed on kind 'scheduler' " +
        "instance 'scheduler:poison':",
      expect.objectContaining({ message: "poison job exploded" }),
    );
    errorSpy.mockRestore();
    // The job was not consumed, so production would retry with backoff.
    // Cancel to leave the instance clean.
    expect((await s.list()).map((j) => j.name)).toEqual(["poison"]);
    await s.cancel("poison");
  });

  it("PROBE: typo'd method through the stub (as any) fails at runtime", async () => {
    const s = kind(env.APP_DO, "scheduler").get("typo");
    await expect((s as any).schedul("x", 1)).rejects.toThrow(
      "generic-durable-objects: kind 'scheduler' has no method 'schedul'.",
    );
  });

  it("PROBE: runDurableObjectAlarm rejects the library's proxy stub", async () => {
    const s = kind(env.APP_DO, "scheduler").get("wrong-stub");
    await s.schedule("j", Date.now() + 60_000);
    // A real user's first instinct: pass the typed stub. It is a Proxy, not
    // a DurableObjectStub, so the test helper rejects it.
    await expect(
      runDurableObjectAlarm(s as unknown as DurableObjectStub),
    ).rejects.toThrow(
      "Failed to execute 'runDurableObjectAlarm': parameter 1 is not of type 'DurableObjectStub'.",
    );
    // The escape hatch works.
    expect(await runDurableObjectAlarm(s.stub)).toBe(true);
  });

  it("PROBE: deleteAll() on a NAMED instance loses data but not identity", async () => {
    const s = kind(env.APP_DO, "scheduler").get("wipe-named");
    await s.schedule("gone", Date.now() + 60_000);
    await s.wipeStorage();

    // Same in-memory instance: the library's cached kind still answers, but
    // deleteAll() dropped the SQL tables while the constructor does not run
    // again, so the kind is now in a state it can never reach on a fresh
    // start. Every SQL-backed method fails with a raw SQLite error.
    // POST-FIX: the error now carries the REMOTE stack (the real frame in
    // the kind) plus a marker line, instead of pointing at src/client.ts.
    let caught: Error | undefined;
    try {
      await s.list();
    } catch (error) {
      caught = error as Error;
    }
    expect(caught!.message).toBe("no such table: jobs: SQLITE_ERROR");
    expect(caught!.stack).toContain("at Scheduler.list");
    expect(caught!.stack).toContain(
      "at [remote call scheduler.list() via generic-durable-objects]",
    );

    // Restart the instance. deleteAll() does NOT delete the pending alarm,
    // and storage no longer has `__gdo:kind`, but the name prefix
    // `scheduler:` re-resolves and re-pins the kind, and the constructor
    // recreates the tables. The instance heals; only the data is gone.
    await expect(s.crash()).rejects.toThrow("scheduler crashed on purpose");
    const fresh = kind(env.APP_DO, "scheduler").get("wipe-named");
    expect(await fresh.list()).toEqual([]);
    expect(await fresh.fired()).toEqual([]);
    // OBSERVED: in SQLite-backed DOs, deleteAll() also removed the pending
    // alarm (alarms live in the same SQLite database), so no orphaned alarm
    // remains after the wipe.
    expect(await fresh.alarmTime()).toBeNull();
    expect(await runDurableObjectAlarm(rawSchedulerStub("wipe-named"))).toBe(
      false,
    );
    expect(await rawSchedulerStub("wipe-named").__gdoKind()).toBe("scheduler");
  });

  it("PROBE: raw deleteAll() on a UNIQUE instance now strands it permanently", async () => {
    const s = kind(env.APP_DO, "scheduler").unique();
    expect(s.name).toBeUndefined(); // unique stubs have no logical name
    const id = s.id.toString();
    await s.schedule("orphan", Date.now() + 60_000);
    await s.wipeStorage(); // RAW deleteAll — the footgun, on purpose
    await expect(s.crash()).rejects.toThrow("scheduler crashed on purpose");

    // After the restart the instance has NO stored kind and NO name prefix.
    // OBSERVED: deleteAll() also removed the pending alarm (SQLite-backed
    // DO), so the feared "alarm fires on a kind-less instance" state cannot
    // be reached through deleteAll().
    const raw = env.APP_DO.get(env.APP_DO.idFromString(id));
    expect(await raw.__gdoKind()).toBeUndefined();
    expect(await runDurableObjectAlarm(raw)).toBe(false);

    // Raw access without a hint is rejected outright...
    const response = await raw.fetch("https://do/");
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      `generic-durable-objects: instance '${id}' has no kind yet. ` +
        "Unique-ID instances initialize on their first call through " +
        "kind(ns, '<kind>').unique().",
    );

    // POST-FIX: the client helper no longer resuscitates it either.
    // fromId() never initializes, so the instance is unreachable forever —
    // amnesia is now explicit instead of a silent re-pin (verbatim):
    const again = kind(env.APP_DO, "scheduler").fromId(id);
    await expect(again.list()).rejects.toThrow(
      `generic-durable-objects: instance '${id}' has no kind yet. ` +
        "It was accessed as kind 'scheduler' through fromId(), which never " +
        "initializes an instance. Create the instance first with " +
        "kind(ns, 'scheduler').get(name) or .unique(), then reach it by id.",
    );
    expect(await raw.__gdoKind()).toBeUndefined(); // still unpinned
    // Moral: inside a kind, use the library's resetStorage(ctx) instead of
    // ctx.storage.deleteAll() (proven in the counter-fleet example).
  });

  it("PROBE: unique() alarm on a never-hinted instance cannot happen via the API", async () => {
    // Could a unique() instance set an alarm BEFORE its kind is persisted?
    // Not through this library: the host persists the kind before it even
    // constructs the kind class, and raw fetch() without a hint is rejected
    // before any user code runs. Demonstrate the rejection (the 400 now
    // names the instance and explains the unique-ID initialization path):
    const raw = env.APP_DO.get(env.APP_DO.newUniqueId());
    const response = await raw.fetch("https://do/");
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      `generic-durable-objects: instance '${raw.id.toString()}' has no kind yet. ` +
        "Unique-ID instances initialize on their first call through " +
        "kind(ns, '<kind>').unique().",
    );
  });
});
