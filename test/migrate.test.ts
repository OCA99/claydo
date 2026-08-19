import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../src/index";
import { migrateInstance, migrated, wipeTarget } from "../src/migrate";
import type { ImportState } from "../src/migrate-wire";

const tally = () => kind(env.APP_DO, "tally");

function legacy(name: string) {
  return env.LEGACY.get(env.LEGACY.idFromName(name));
}

function rawTarget(name: string) {
  return env.APP_DO.get(env.APP_DO.idFromName(`tally:${name}`));
}

async function seed(name: string): Promise<void> {
  const old = legacy(name);
  await old.bump("apples", 2);
  await old.bump("pears", 3);
  await old.note("color", "blue");
}

/** Asserts a rejection without leaving an unhandled-rejection report. */
async function expectRejects(
  run: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(String(error)).toMatch(pattern);
    return;
  }
  expect.unreachable(`expected rejection matching ${pattern}`);
}

describe("migrateInstance", () => {
  it("moves SQLite and KV data and seals the old instance", async () => {
    await seed("m1");
    const summary = await migrateInstance({
      from: legacy("m1"),
      to: tally(),
      name: "m1",
    });
    expect(summary.skipped).toBe(false);
    expect(summary.rows["counts"]).toBe(2);
    expect(summary.kv).toBe(1);

    const moved = tally().get("m1");
    expect(await moved.total()).toBe(5);
    expect(await moved.getNote("color")).toBe("blue");
    expect(await moved.bump("apples")).toBe(3);

    // The old instance is sealed: RPC fails, fetch answers a marked 410.
    await expectRejects(() => legacy("m1").bump("apples"), /is sealed/);
    const gone = await legacy("m1").fetch("https://do/");
    expect(gone.status).toBe(410);
    expect(gone.headers.get("x-claydo-sealed")).toBe("1");
  });

  it("streams in many chunks and preserves data exactly", async () => {
    const old = legacy("m2");
    for (let i = 0; i < 25; i++) await old.bump(`label-${i}`, i + 1);
    for (let i = 0; i < 10; i++) await old.note(`k${i}`, `v${i}`);
    const summary = await migrateInstance({
      from: old,
      to: tally(),
      name: "m2",
      maxRowsPerChunk: 3,
      maxBytesPerChunk: 512,
    });
    expect(summary.chunks).toBeGreaterThan(5);
    expect(summary.rows["counts"]).toBe(25);
    expect(summary.kv).toBe(10);
    const moved = tally().get("m2");
    expect(await moved.total()).toBe((25 * 26) / 2);
    expect(await moved.getNote("k7")).toBe("v7");
  });

  it("is idempotent: a re-run is skipped", async () => {
    await seed("m3");
    await migrateInstance({ from: legacy("m3"), to: tally(), name: "m3" });
    const again = await migrateInstance({
      from: legacy("m3"),
      to: tally(),
      name: "m3",
    });
    expect(again.skipped).toBe(true);
    expect(again.reason).toBe("already migrated");
  });

  it("adopts and resumes a stale crashed migration", async () => {
    await seed("m4");
    const old = legacy("m4");
    // Simulate a driver crash: seal, reserve, apply one chunk, stop.
    await old.__claydoSeal();
    const raw = rawTarget("m4");
    await raw.__claydoBeginImport("tally", "crashed-driver");
    const first = await old.__claydoExport(undefined, null, { maxRows: 1 });
    await raw.__claydoImport("tally", first, 1, "crashed-driver");

    // A fresh import is owned; a new driver must not steal it.
    await expectRejects(
      () => migrateInstance({ from: old, to: tally(), name: "m4" }),
      /another migration driver owns the import/,
    );

    // Backdate the import so it counts as stale, then adopt.
    await runInDurableObject(raw, async (_instance, state) => {
      const s = (await state.storage.get("__claydo:import")) as ImportState;
      s.updatedAtMs = Date.now() - 60_000;
      await state.storage.put("__claydo:import", s);
    });
    const summary = await migrateInstance({
      from: old,
      to: tally(),
      name: "m4",
      maxRowsPerChunk: 1,
    });
    expect(summary.resumed).toBe(true);
    const movedTally = tally().get("m4");
    expect(await movedTally.total()).toBe(5);
    expect(await movedTally.getNote("color")).toBe("blue");
    // The move marker was recorded on the old side.
    expect((await old.__claydoSealed()).movedTo).toBe(raw.id.toString());
  });

  it("blocks traffic on the target while an import is in progress", async () => {
    await seed("m5");
    const old = legacy("m5");
    await old.__claydoSeal();
    const raw = rawTarget("m5");
    await raw.__claydoBeginImport("tally", "t-m5");
    const first = await old.__claydoExport(undefined, null, { maxRows: 1 });
    await raw.__claydoImport("tally", first, 1, "t-m5");

    await expectRejects(
      () => tally().get("m5").total(),
      /is importing kind 'tally'/,
    );
    const response = await tally().get("m5").fetch("https://do/");
    expect(response.status).toBe(400);

    // The owner can abort; a fresh migration then succeeds.
    expect(await raw.__claydoAbortImport("t-m5")).toBe(true);
    const summary = await migrateInstance({ from: old, to: tally(), name: "m5" });
    expect(summary.skipped).toBe(false);
    expect(await tally().get("m5").total()).toBe(5);
  });

  it("reserves the target before sealing: racing traffic cannot pollute it", async () => {
    await seed("m5b");
    const raw = rawTarget("m5b");
    await raw.__claydoBeginImport("tally", "t-m5b");
    // Traffic during the migration window blocks instead of initializing an
    // empty instance.
    await expectRejects(
      () => tally().get("m5b").bump("intruder"),
      /is importing kind 'tally'/,
    );
    await raw.__claydoAbortImport("t-m5b");
    const summary = await migrateInstance({
      from: legacy("m5b"),
      to: tally(),
      name: "m5b",
    });
    expect(summary.skipped).toBe(false);
    expect(await tally().get("m5b").total()).toBe(5);
  });

  it("rolls back on failure: partial import aborted, old instance unsealed", async () => {
    await seed("m6");
    // 'counter' is not in the importable list, so the reservation fails.
    await expectRejects(
      () =>
        migrateInstance({
          from: legacy("m6"),
          to: kind(env.APP_DO, "counter"),
          name: "m6",
        }),
      /imports are not enabled for kind 'counter'/,
    );
    // Rollback: the old instance serves traffic again.
    expect(await legacy("m6").bump("apples")).toBe(3);
  });

  it("transfers a pending alarm and silences the old instance's alarm", async () => {
    const old = legacy("m7");
    await old.bump("x");
    await old.remindAt(Date.now() + 60_000);
    await migrateInstance({ from: old, to: tally(), name: "m7" });
    // The old side's alarm is gone (deleted when the move was recorded).
    expect(await runDurableObjectAlarm(legacy("m7"))).toBe(false);
    // The new side received it.
    const ran = await runDurableObjectAlarm(rawTarget("m7"));
    expect(ran).toBe(true);
    expect(await tally().get("m7").alarmFiredAt()).toBeDefined();
  });

  it("defers alarms that fire while sealed, so they survive the migration", async () => {
    const old = legacy("m7b");
    await old.bump("x");
    await old.remindAt(Date.now() + 1);
    await old.__claydoSeal();
    // The alarm fires during the sealed window: deferred, not swallowed.
    expect(await runDurableObjectAlarm(legacy("m7b"))).toBe(true);
    const summary = await migrateInstance({
      from: old,
      to: tally(),
      name: "m7b",
    });
    expect(typeof summary.alarm).toBe("number");
    expect(await runDurableObjectAlarm(rawTarget("m7b"))).toBe(true);
    expect(await tally().get("m7b").alarmFiredAt()).toBeDefined();
  });

  it("refuses when both sides are live, and wipeTarget() recovers", async () => {
    await seed("m8");
    await tally().get("m8").bump("pollution");
    await expectRejects(
      () => migrateInstance({ from: legacy("m8"), to: tally(), name: "m8" }),
      /both the old instance .* are live/,
    );
    // Recovery path from the error message: wipe the polluted target.
    await wipeTarget(tally(), "m8");
    const summary = await migrateInstance({
      from: legacy("m8"),
      to: tally(),
      name: "m8",
    });
    expect(summary.skipped).toBe(false);
    expect(await tally().get("m8").total()).toBe(5);
    expect(await tally().get("m8").getNote("color")).toBe("blue");
  });

  it("seal and unseal round-trip, and sync self-calls stay intact", async () => {
    const old = legacy("m9");
    await old.bump("a");
    // bumpAndRead does a SYNC self-call; a value of 102 proves the seal
    // guard did not turn bump() async.
    expect(await old.bumpAndRead("a")).toBe(102);
    await old.__claydoSeal();
    await expectRejects(() => old.bump("a"), /is sealed/);
    await old.__claydoUnseal();
    expect(await old.bump("a")).toBe(3);
  });

  it("skips instances with no data instead of fabricating sealed husks", async () => {
    const summary = await migrateInstance({
      from: legacy("never-existed"),
      to: tally(),
      name: "never-existed",
    });
    expect(summary.skipped).toBe(true);
    expect(summary.reason).toMatch(/no data/);
    // Nothing was sealed or created on either side.
    expect((await legacy("never-existed").__claydoSealed()).sealed).toBe(false);
    const status = await rawTarget("never-existed").__claydoImportStatus();
    expect(status.kind).toBeUndefined();
    expect(status.importing).toBeUndefined();
  });

  it("preserves rowid-alias tables whose primary key is not the first column", async () => {
    const old = legacy("m10");
    await old.bump("x");
    await old.addEvent(1111, "first");
    await old.addEvent(2222, "second");
    await migrateInstance({ from: old, to: tally(), name: "m10" });
    expect(await tally().get("m10").events()).toEqual([
      { ts: 1111, id: 1, note: "first" },
      { ts: 2222, id: 2, note: "second" },
    ]);
  });

  it("migrates user keys that start with __claydo, but not reserved keys", async () => {
    const old = legacy("m11");
    await old.bump("x");
    await old.putRaw("__claydonote", "mine");
    await migrateInstance({ from: old, to: tally(), name: "m11" });
    const moved = tally().get("m11");
    expect(await moved.getRaw("__claydonote")).toBe("mine");
    expect(await moved.getRaw("__claydo:sealed")).toBeUndefined();
  });

  it("restores AUTOINCREMENT sequences so deleted ids are not reused", async () => {
    const old = legacy("m12");
    await old.bump("a");
    await old.bump("b");
    await old.bump("c"); // ids 1..3
    await old.removeLabel("c"); // max(id) drops to 2, sequence stays 3
    await migrateInstance({ from: old, to: tally(), name: "m12" });
    const moved = tally().get("m12");
    await moved.bump("d");
    expect(await moved.maxCountId()).toBe(4); // not 3
  });
});

describe("migrated() router", () => {
  it("lazy: migrates on first touch, serves new after", async () => {
    await seed("r1");
    const accessor = migrated(env.LEGACY, tally(), { strategy: "lazy" });
    expect(await accessor.get("r1").total()).toBe(5);
    expect((await legacy("r1").__claydoSealed()).sealed).toBe(true);
    expect(await tally().get("r1").total()).toBe(5);
    expect(await accessor.get("r1").bump("apples")).toBe(3);
  });

  it("lazy: names with no old data go straight to the kind", async () => {
    const accessor = migrated(env.LEGACY, tally(), { strategy: "lazy" });
    expect(await accessor.get("r2").bump("fresh")).toBe(1);
    expect(await tally().get("r2").total()).toBe(1);
  });

  it("manual: routes to the old instance until an external driver migrates", async () => {
    await seed("r3");
    const accessor = migrated(env.LEGACY, tally(), {
      strategy: "manual",
      oldRouteTtlMs: 0,
    });
    expect(await accessor.get("r3").total()).toBe(5);
    expect((await legacy("r3").__claydoSealed()).sealed).toBe(false);

    await migrateInstance({ from: legacy("r3"), to: tally(), name: "r3" });
    expect(await accessor.get("r3").bump("apples")).toBe(3);
    expect(await tally().get("r3").total()).toBe(6);
  });

  it("drain: old instances stay old, new names go to the kind", async () => {
    await seed("r4");
    const accessor = migrated(env.LEGACY, tally(), { strategy: "drain" });
    expect(await accessor.get("r4").total()).toBe(5);
    expect((await legacy("r4").__claydoSealed()).sealed).toBe(false);
    expect(await accessor.get("r5").bump("new-world")).toBe(1);
    expect(await tally().get("r5").total()).toBe(1);
  });

  it("RPC retries on the new side when the old instance seals mid-flight", async () => {
    await seed("r6");
    const accessor = migrated(env.LEGACY, tally(), {
      strategy: "manual",
      oldRouteTtlMs: 60_000,
    });
    expect(await accessor.get("r6").total()).toBe(5); // cache "old"
    await migrateInstance({ from: legacy("r6"), to: tally(), name: "r6" });
    expect(await accessor.get("r6").total()).toBe(5); // retried on new
  });

  it("fetch retries on the new side when the old instance seals mid-flight", async () => {
    await seed("r7");
    const accessor = migrated(env.LEGACY, tally(), {
      strategy: "manual",
      oldRouteTtlMs: 60_000,
    });
    const first = await accessor.get("r7").fetch("https://do/");
    expect(await first.text()).toBe("tally:r7"); // old route, unsealed
    await migrateInstance({ from: legacy("r7"), to: tally(), name: "r7" });
    const second = await accessor.get("r7").fetch("https://do/");
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("tally:r7"); // retried on new
  });

  it("lazy: concurrent first touches migrate exactly once", async () => {
    const old = legacy("r8");
    for (let i = 0; i < 20; i++) await old.bump(`l${i}`, i + 1);
    const accessor = migrated(env.LEGACY, tally(), { strategy: "lazy" });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => accessor.get("r8").total()),
    );
    for (const value of results) expect(value).toBe((20 * 21) / 2);
    expect(await tally().get("r8").total()).toBe((20 * 21) / 2);
  });
});
