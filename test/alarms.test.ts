import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kinds } from "../src/index";
import type { ClaydoError } from "../src/index";
import { caught, eventually } from "./helpers";

const app = kinds(env.APP_DO);

function rawStub(kind: "reminder" | "captured", name: string) {
  return env.APP_DO.get(app[kind].idFromName(name));
}

describe("kind alarms", () => {
  it("schedules, reads, and deletes through the storage API", async () => {
    const reminder = app.reminder.get("alarm-crud");
    const at = Date.now() + 60_000;
    await reminder.remindAt(at, "ping");
    expect(await reminder.alarmTime()).toBe(at);
    await reminder.cancel();
    expect(await reminder.alarmTime()).toBeNull();
  });

  it("arms the instance's native alarm", async () => {
    const at = Date.now() + 60_000;
    await app.reminder.get("alarm-native").remindAt(at, "ping");
    const native = await runInDurableObject(
      rawStub("reminder", "alarm-native"),
      (_instance, ctx) => ctx.storage.getAlarm(),
    );
    expect(native).toBe(at);
  });

  it("fires the kind's alarm() with the kind's scheduled time", async () => {
    const reminder = app.reminder.get("alarm-fire");
    const at = Date.now() + 25;
    await reminder.remindAt(at, "hello");
    const fired = (await eventually(
      () => reminder.fired(),
      (value) => value !== undefined,
    )) as {
      payload: string;
      insideAlarm: number | null;
      scheduledTime: number;
      isRetry: boolean;
    };
    expect(fired.payload).toBe("hello");
    expect(fired.scheduledTime).toBe(at);
    expect(fired.isRetry).toBe(false);
    // Inside its own handler, the kind reads no pending alarm, like a
    // native Durable Object.
    expect(fired.insideAlarm).toBeNull();
    expect(await reminder.alarmTime()).toBeNull();
  });

  it("retries a failed handler and reports isRetry", async () => {
    const reminder = app.reminder.get("alarm-retry");
    await reminder.failOnce();
    await reminder.remindAt(Date.now() + 25, "second try");
    const fired = (await eventually(
      () => reminder.fired(),
      (value) => value !== undefined,
      10_000,
    )) as { payload: string; isRetry: boolean };
    expect(fired.payload).toBe("second try");
    expect(fired.isRetry).toBe(true);
    expect(await reminder.alarmTime()).toBeNull();
  });

  it("fireScheduledAlarm forces a future alarm in tests", async () => {
    const { fireScheduledAlarm } = await import("../src/test");
    const reminder = app.reminder.get("alarm-forced");
    await reminder.remindAt(Date.now() + 3_600_000, "forced");
    expect(await fireScheduledAlarm(reminder)).toBe(true);
    const fired = (await reminder.fired()) as { payload: string };
    expect(fired.payload).toBe("forced");
    expect(await reminder.alarmTime()).toBeNull();
    // Nothing scheduled: reports false.
    expect(await fireScheduledAlarm(reminder)).toBe(false);
  });

  it("cancels from inside the handler without a refire", async () => {
    const reminder = app.reminder.get("alarm-cancel-inside");
    await reminder.cancelInsideHandler();
    await reminder.remindAt(Date.now() + 25, "once");
    await eventually(
      () => reminder.fired(),
      (value) => value !== undefined,
    );
    expect(await reminder.alarmTime()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await reminder.attempts()).toBe(1);
  });

  it("keeps a schedule set during a failed delivery's retry window", async () => {
    const reminder = app.reminder.get("alarm-backoff-schedule");
    const later = Date.now() + 120_000;
    await reminder.failOnce();
    await reminder.remindAt(Date.now() + 25, "retried");
    // Wait for the first (failing) attempt, then schedule while the
    // delivery awaits its retry. Whichever side wins the race, the retry
    // must complete AND the new schedule must survive.
    await eventually(
      () => reminder.attempts(),
      (value) => value >= 1,
    );
    await reminder.remindAt(later, "retried");
    await eventually(
      () => reminder.fired(),
      (value) => value !== undefined,
      10_000,
    );
    expect(await reminder.alarmTime()).toBe(later);
  });

  it("drops alarms of kinds without an alarm() handler, loudly", async () => {
    const plain = app.plain.get("alarm-handlerless");
    await plain.setAlarmAt(Date.now() + 25);
    const remaining = await eventually(
      () => plain.alarmTime(),
      (value) => value === null,
    );
    expect(remaining).toBeNull();
  });

  it("keeps a guard-based periodic alarm chain alive", async () => {
    const reminder = app.reminder.get("alarm-chain");
    await reminder.chainEvery(120_000);
    await reminder.remindAt(Date.now() + 25, "tick");
    await eventually(
      () => reminder.fired(),
      (value) => value !== undefined,
    );
    // The handler saw getAlarm() === null and re-scheduled the next tick.
    const next = await reminder.alarmTime();
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(Date.now() + 60_000);
  });

  it("keeps a re-schedule made inside the alarm handler", async () => {
    const reminder = app.reminder.get("alarm-reschedule");
    const later = Date.now() + 120_000;
    await reminder.rescheduleOnFire(later);
    await reminder.remindAt(Date.now() + 25, "first");
    await eventually(
      () => reminder.fired(),
      (value) => value !== undefined,
    );
    expect(await reminder.alarmTime()).toBe(later);
    const native = await runInDurableObject(
      rawStub("reminder", "alarm-reschedule"),
      (_instance, ctx) => ctx.storage.getAlarm(),
    );
    expect(native).toBe(later);
  });

  it("reaches alarms through constructor-captured storage", async () => {
    const captured = app.captured.get("alarm-captured");
    await captured.remindAt(Date.now() + 25);
    const fired = await eventually(
      () => captured.firedThroughCapture(),
      (value) => value,
    );
    expect(fired).toBe(true);
    expect(await captured.capturedName()).toBe("alarm-captured");
  });

  it("rejects alarm calls inside an async transaction", async () => {
    const reminder = app.reminder.get("alarm-txn");
    for (const call of [
      reminder.setAlarmInTransaction(Date.now() + 1000),
      reminder.setAlarmAroundTransaction(Date.now() + 1000),
    ]) {
      const error = (await call.then(
        () => undefined,
        (thrown: unknown) => thrown,
      )) as ClaydoError;
      expect(error.code).toBe("CLAYDO_ALARM_IN_TRANSACTION");
    }
  });

  it("rejects alarm calls inside a sync transaction", async () => {
    const reminder = app.reminder.get("alarm-txn-sync");
    const error = (await reminder
      .setAlarmInTransactionSync(Date.now() + 1000)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      )) as ClaydoError;
    expect(error.code).toBe("CLAYDO_ALARM_IN_TRANSACTION");
  });
});

describe("deleteAll semantics", () => {
  it("clears the kind's tables and key-value data", async () => {
    const counter = app.counter.get("wipe-1");
    await counter.increment(3);
    await counter.putKv("note", "keep?");
    await counter.wipe();
    expect(await counter.getKv("note")).toBeUndefined();
    // wipe() re-creates the schema after deleteAll(), so only the empty
    // counters table remains.
    expect(await counter.listTables()).toEqual(["counters"]);
    expect(await counter.value()).toBe(0);
  });

  it("keeps the instance's identity and kind", async () => {
    const created = app.counter.unique();
    await created.increment();
    await created.wipe();
    const again = app.counter.fromId(created.id.toString());
    expect(await again.value()).toBe(0);
  });

  it("keeps a pending alarm, like native deleteAll()", async () => {
    const reminder = app.reminder.get("wipe-alarm");
    const at = Date.now() + 60_000;
    await reminder.remindAt(at, "survives");
    await reminder.wipe();
    expect(await reminder.alarmTime()).toBe(at);
  });

  it("keeps only the reserved identity key in the kind's key-value store", async () => {
    const counter = app.counter.get("wipe-reserved");
    await counter.putKv("note", "gone after wipe");
    expect((await counter.listKvKeys()).sort()).toEqual([
      "__claydo",
      "note",
    ]);
    await counter.wipe();
    // deleteAll() preserves the identity marker; everything else is gone.
    expect(await counter.listKvKeys()).toEqual(["__claydo"]);
  });

  it("rejects direct writes to the reserved identity key", async () => {
    const counter = app.counter.get("wipe-guarded");
    for (const attempt of [
      counter.deleteKv("__claydo"),
      counter.putKv("__claydo", "overwritten"),
    ]) {
      const error = await caught(attempt);
      expect((error as ClaydoError).code).toBe("CLAYDO_CONFIG");
      expect(error.message).toContain("reserved");
    }
    expect(await counter.listKvKeys()).toEqual(["__claydo"]);
  });

  it("does not leak claydo state into kind storage", async () => {
    const reminder = app.reminder.get("wipe-clean");
    await reminder.remindAt(Date.now() + 60_000, "x");
    const keys = await runInDurableObject(
      rawStub("reminder", "wipe-clean"),
      async (_instance, ctx) => [...(await ctx.storage.list()).keys()],
    );
    // Supervisor storage holds only the alarm entry and the kind pin; the
    // payload lives in the kind's facet.
    expect(keys.sort()).toEqual(["alarm:reminder", "kind"]);
  });
});
