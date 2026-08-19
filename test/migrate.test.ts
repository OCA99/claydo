import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../src/index";
import { migrateInstance, migrated } from "../src/migrate";

const tally = () => kind(env.APP_DO, "tally");

function legacy(name: string) {
  return env.LEGACY.get(env.LEGACY.idFromName(name));
}

async function seed(name: string): Promise<void> {
  const old = legacy(name);
  await old.bump("apples", 2);
  await old.bump("pears", 3);
  await old.note("color", "blue");
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
    // Writes continue on the new side.
    expect(await moved.bump("apples")).toBe(3);

    // The old instance is sealed: RPC fails, fetch answers 410.
    await expect(legacy("m1").bump("apples")).rejects.toThrow(/is sealed/);
    const gone = await legacy("m1").fetch("https://do/");
    expect(gone.status).toBe(410);
    expect(await gone.text()).toMatch(/moved to Durable Object id/);
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
  });

  it("resumes a crashed migration from the last applied chunk", async () => {
    await seed("m4");
    const old = legacy("m4");
    // Simulate a driver crash: seal, apply one chunk, stop.
    await old.__claydoSeal();
    const first = await old.__claydoExport(undefined, null, { maxRows: 1 });
    const raw = tally().get("m4").stub as any;
    await raw.__claydoImport("tally", first, 1);

    const summary = await migrateInstance({
      from: old,
      to: tally(),
      name: "m4",
      maxRowsPerChunk: 1,
    });
    expect(summary.resumed).toBe(true);
    const moved = tally().get("m4");
    expect(await moved.total()).toBe(5);
    expect(await moved.getNote("color")).toBe("blue");
  });

  it("blocks traffic on the target while an import is in progress", async () => {
    await seed("m5");
    const old = legacy("m5");
    await old.__claydoSeal();
    const first = await old.__claydoExport(undefined, null, { maxRows: 1 });
    const raw = tally().get("m5").stub as any;
    await raw.__claydoImport("tally", first, 1);

    await expect(tally().get("m5").total()).rejects.toThrow(
      /is importing kind 'tally'/,
    );
    const response = await tally().get("m5").fetch("https://do/");
    expect(response.status).toBe(400);

    // Abort clears the partial import; a fresh migration succeeds.
    expect(await raw.__claydoAbortImport()).toBe(true);
    const summary = await migrateInstance({ from: old, to: tally(), name: "m5" });
    expect(summary.skipped).toBe(false);
    expect(await tally().get("m5").total()).toBe(5);
  });

  it("rolls back on failure: partial import aborted, old instance unsealed", async () => {
    await seed("m6");
    // 'counter' is not in the importable list, so the first chunk fails.
    await expect(
      migrateInstance({
        from: legacy("m6"),
        to: kind(env.APP_DO, "counter"),
        name: "m6",
      }),
    ).rejects.toThrow(/imports are not enabled for kind 'counter'/);
    // Rollback: the old instance serves traffic again.
    expect(await legacy("m6").bump("apples")).toBe(3);
  });

  it("transfers a pending alarm", async () => {
    const old = legacy("m7");
    await old.bump("x");
    await old.remindAt(Date.now() + 60_000);
    await migrateInstance({ from: old, to: tally(), name: "m7" });
    const ran = await runDurableObjectAlarm(
      env.APP_DO.get(env.APP_DO.idFromName("tally:m7")),
    );
    expect(ran).toBe(true);
    expect(await tally().get("m7").alarmFiredAt()).toBeDefined();
  });

  it("refuses when both sides are live", async () => {
    await seed("m8");
    await tally().get("m8").bump("already-here");
    await expect(
      migrateInstance({ from: legacy("m8"), to: tally(), name: "m8" }),
    ).rejects.toThrow(/both the old instance .* are live/);
  });

  it("seal and unseal round-trip", async () => {
    const old = legacy("m9");
    await old.bump("a");
    await old.__claydoSeal();
    await expect(old.bump("a")).rejects.toThrow(/is sealed/);
    await old.__claydoUnseal();
    expect(await old.bump("a")).toBe(2);
  });
});

describe("migrated() router", () => {
  it("lazy: migrates on first touch, serves new after", async () => {
    await seed("r1");
    const accessor = migrated(env.LEGACY, tally(), { strategy: "lazy" });
    expect(await accessor.get("r1").total()).toBe(5);
    // The instance moved: old sealed, new live.
    expect(
      (await legacy("r1").__claydoSealed()).sealed,
    ).toBe(true);
    expect(await tally().get("r1").total()).toBe(5);
    // Further calls serve the new instance.
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
    // Old side still live and unsealed under manual routing.
    expect((await legacy("r3").__claydoSealed()).sealed).toBe(false);

    await migrateInstance({ from: legacy("r3"), to: tally(), name: "r3" });
    // The route re-resolves (ttl 0) and serves the new instance.
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

  it("retries on the new side when the old instance seals mid-flight", async () => {
    await seed("r6");
    const accessor = migrated(env.LEGACY, tally(), {
      strategy: "manual",
      oldRouteTtlMs: 60_000,
    });
    // Prime the cache with an "old" route.
    expect(await accessor.get("r6").total()).toBe(5);
    // An external driver migrates while the route is cached.
    await migrateInstance({ from: legacy("r6"), to: tally(), name: "r6" });
    // The cached old route hits the seal, re-resolves, and retries on new.
    expect(await accessor.get("r6").total()).toBe(5);
  });
});
