import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { kind } from "../../../src/index";

const hostedHere =
  (await env.APP_DO.get(
    env.APP_DO.idFromName("scheduler:__config-probe"),
  ).__claydoKind()) === "scheduler";
const describeHosted = describe.skipIf(!hostedHere);

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
    expect(await runDurableObjectAlarm(rawSchedulerStub("order"))).toBe(false);
  });

  it("an early alarm (no due job) fires nothing and stays armed", async () => {
    const s = kind(env.APP_DO, "scheduler").get("early");
    const at = Date.now() + 60_000;
    await s.schedule("future", at);
    expect(await runDurableObjectAlarm(rawSchedulerStub("early"))).toBe(true);
    expect(await s.fired()).toEqual([]);
    expect((await s.list()).map((j) => j.name)).toEqual(["future"]);
    expect(await s.alarmTime()).toBe(at);
  });

  it("fires on a cold instance: kind resolves from storage, no caller hint", async () => {
    const s = kind(env.APP_DO, "scheduler").get("cold");
    await s.schedule("wake-up", { delayMs: 150 });

    await expect(s.crash()).rejects.toThrow("scheduler crashed on purpose");

    expect((await s.list()).map((job) => job.name)).toEqual(["wake-up"]);

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

describeHosted("edge cases (adversarial)", () => {
  it("a throwing kind alarm() surfaces through runDurableObjectAlarm", async () => {
    const s = kind(env.APP_DO, "scheduler").get("poison");
    await s.schedule("poison", Date.now() + 60_000);
    const errorSpy = vi.spyOn(console, "error");
    await expect(
      runDurableObjectAlarm(rawSchedulerStub("poison")),
    ).rejects.toThrow("poison job exploded");
    expect(errorSpy).toHaveBeenCalledWith(
      "claydo: alarm() failed on kind 'scheduler' " +
        "instance 'scheduler:poison':",
      expect.objectContaining({ message: "poison job exploded" }),
    );
    errorSpy.mockRestore();
    expect((await s.list()).map((j) => j.name)).toEqual(["poison"]);
    await s.cancel("poison");
  });

  it("typo'd method through the stub (as any) fails at runtime", async () => {
    const s = kind(env.APP_DO, "scheduler").get("typo");
    await expect((s as any).schedul("x", 1)).rejects.toThrow(
      "claydo: kind 'scheduler' has no method 'schedul'.",
    );
  });

  it("runDurableObjectAlarm rejects the library's proxy stub", async () => {
    const s = kind(env.APP_DO, "scheduler").get("wrong-stub");
    await s.schedule("j", Date.now() + 60_000);
    await expect(
      runDurableObjectAlarm(s as unknown as DurableObjectStub),
    ).rejects.toThrow(
      "Failed to execute 'runDurableObjectAlarm': parameter 1 is not of type 'DurableObjectStub'.",
    );
    expect(await runDurableObjectAlarm(s.stub)).toBe(true);
  });

  it("deleteAll() on a NAMED instance loses data but not identity", async () => {
    const s = kind(env.APP_DO, "scheduler").get("wipe-named");
    await s.schedule("gone", Date.now() + 60_000);
    await s.wipeStorage();

    expect(await s.list()).toEqual([]);
    const fresh = kind(env.APP_DO, "scheduler").get("wipe-named");
    expect(await fresh.list()).toEqual([]);
    expect(await fresh.fired()).toEqual([]);
    expect(await fresh.alarmTime()).toBeNull();
    expect(await runDurableObjectAlarm(rawSchedulerStub("wipe-named"))).toBe(
      false,
    );
    expect(await rawSchedulerStub("wipe-named").__claydoKind()).toBe("scheduler");
  });

  it("deleteAll() on a UNIQUE facet cannot erase kind identity", async () => {
    const s = kind(env.APP_DO, "scheduler").unique();
    expect(s.name).toBeUndefined(); // unique stubs have no logical name
    const id = s.id.toString();
    await s.schedule("orphan", Date.now() + 60_000);
    await s.wipeStorage();
    await expect(s.crash()).rejects.toThrow("scheduler crashed on purpose");

    const raw = env.APP_DO.get(env.APP_DO.idFromString(id));
    expect(await raw.__claydoKind()).toBe("scheduler");
    expect(await runDurableObjectAlarm(raw)).toBe(false);

    const again = kind(env.APP_DO, "scheduler").fromId(id);
    expect(await again.list()).toEqual([]);
    expect(await raw.__claydoKind()).toBe("scheduler");
  });

  it("unique() alarm on a never-hinted instance cannot happen via the API", async () => {
    const raw = env.APP_DO.get(env.APP_DO.newUniqueId());
    const response = await raw.fetch("https://do/");
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      `claydo: instance '${raw.id.toString()}' has no kind yet. ` +
        "Unique-ID instances initialize on their first call through " +
        "kind(ns, '<kind>').unique().",
    );
  });
});
