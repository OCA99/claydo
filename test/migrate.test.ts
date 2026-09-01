import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../src/index";
import {
  migrateInstance,
  migrated,
  previewInstance,
  wipeTarget,
  type ExportChunk,
  type MigrationProgress,
} from "../src/migrate";
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
    const begin = await raw.__claydoBeginImport(
      "tally",
      "crashed-driver",
      undefined,
      {
      maxRows: 1,
      maxBytes: 256 * 1024,
      },
    );
    if (!begin.ok) expect.unreachable("fresh import must be reserved");
    await old.__claydoSeal(
      undefined,
      undefined,
      "tally:m4",
      begin.migrationId,
    );
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
    // The move marker was recorded on the old side, as an operator-usable
    // <kind>:<name> reference.
    expect((await old.__claydoSealed()).movedTo).toBe("tally:m4");
  });

  it("replays a chunk idempotently after facet commit before supervisor checkpoint", async () => {
    await seed("m4-checkpoint");
    const old = legacy("m4-checkpoint");
    const raw = rawTarget("m4-checkpoint");
    const token = "checkpoint-crash";
    await old.__claydoSeal();
    const begin = await raw.__claydoBeginImport("tally", token, undefined, {
      maxRows: 1,
      maxBytes: 256 * 1024,
    });
    if (!begin.ok) expect.unreachable("fresh import must be reserved");
    await old.__claydoSeal(
      undefined,
      undefined,
      "tally:m4-checkpoint",
      begin.migrationId,
    );
    const first = (await old.__claydoExport(undefined, null, {
      maxRows: 1,
    })) as ExportChunk;
    await raw.__claydoImport("tally", first, 1, token);
    const rowChunk = (await old.__claydoExport(
      undefined,
      first.cursor,
      { maxRows: 1 },
    )) as ExportChunk;
    expect(rowChunk.rows?.values.length).toBe(1);

    // Simulate the exact crash window: the staging facet atomically applied
    // seq 2 and its local checkpoint, but the supervisor never updated
    // IMPORT_STATE_KEY. Replaying through the public import method must not
    // insert the row twice.
    await runInDurableObject(raw, async (_instance, state) => {
      const host = (
        state.exports as unknown as Record<
          string,
          (options: { props: unknown }) => DurableObjectClass
        >
      ).AppDO!;
      const configured = host({
        props: {
          __claydoFacet: true,
          kind: "tally",
          hostExport: "AppDO",
        },
      });
      const stage = state.facets.get("import:tally", () => ({
        class: configured,
      })) as unknown as {
        __claydoApplyImport(
          chunk: ExportChunk,
          seq: number,
          migrationId: string,
        ): Promise<boolean>;
      };
      expect(
        await stage.__claydoApplyImport(
          rowChunk,
          2,
          begin.migrationId,
        ),
      ).toBe(true);
    });
    const replay = await raw.__claydoImport(
      "tally",
      rowChunk,
      2,
      token,
    );
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.applied.rows["counts"]).toBe(1);

    await runInDurableObject(raw, async (_instance, state) => {
      const s = (await state.storage.get("__claydo:import")) as ImportState;
      s.updatedAtMs = Date.now() - 60_000;
      await state.storage.put("__claydo:import", s);
    });
    const summary = await migrateInstance({
      from: old,
      to: tally(),
      name: "m4-checkpoint",
    });
    expect(summary.resumed).toBe(true);
    expect(await tally().get("m4-checkpoint").total()).toBe(5);
  });

  it("restarts when staging is ahead of supervisor seq zero", async () => {
    const old = legacy("m4-seq-zero");
    await old.bump("value", 1);
    const raw = rawTarget("m4-seq-zero");
    const token = "seq-zero";
    await old.__claydoSeal(undefined, undefined, "tally:m4-seq-zero");
    const begin = await raw.__claydoBeginImport("tally", token, undefined, {
      maxRows: 1,
      maxBytes: 256 * 1024,
    });
    if (!begin.ok) expect.unreachable("fresh import must be reserved");
    await old.__claydoSeal(
      undefined,
      undefined,
      "tally:m4-seq-zero",
      begin.migrationId,
    );
    const first = (await old.__claydoExport(undefined, null, {
      maxRows: 1,
    })) as ExportChunk;
    expect(first.rows?.values.length).toBe(1);
    await runInDurableObject(raw, async (_instance, state) => {
      const host = (
        state.exports as unknown as Record<
          string,
          (options: { props: unknown }) => DurableObjectClass
        >
      ).AppDO!;
      const stage = state.facets.get("import:tally", () => ({
        class: host({
          props: {
            __claydoFacet: true,
            kind: "tally",
            hostExport: "AppDO",
          },
        }),
      })) as unknown as {
        __claydoApplyImport(
          chunk: ExportChunk,
          seq: number,
          migrationId: string,
        ): Promise<boolean>;
      };
      expect(
        await stage.__claydoApplyImport(first, 1, begin.migrationId),
      ).toBe(true);
      const importState = (await state.storage.get(
        "__claydo:import",
      )) as ImportState;
      importState.updatedAtMs = Date.now() - 60_000;
      await state.storage.put("__claydo:import", importState);
    });
    await old.__claydoUnseal();
    await old.bump("value", 1);

    const summary = await migrateInstance({
      from: old,
      to: tally(),
      name: "m4-seq-zero",
    });
    expect(summary.resumed).toBe(false);
    expect(await tally().get("m4-seq-zero").total()).toBe(2);
  });

  it("re-verifies a failed final chunk on every retry", async () => {
    await seed("m4-verify-retry");
    const old = legacy("m4-verify-retry");
    const raw = rawTarget("m4-verify-retry");
    const token = "verify-retry";
    await old.__claydoSeal(undefined, undefined, "tally:m4-verify-retry");
    await raw.__claydoBeginImport("tally", token);
    let cursor: ExportChunk["cursor"] = null;
    let seq = 0;
    for (;;) {
      const chunk = (await old.__claydoExport(
        undefined,
        cursor,
        { maxRows: 1 },
      )) as ExportChunk;
      seq += 1;
      if (chunk.cursor === null) {
        chunk.totals!.rows.counts =
          (chunk.totals!.rows.counts ?? 0) + 1;
        await expectRejects(
          () => raw.__claydoImport("tally", chunk, seq, token),
          /import verification failed/,
        );
        // The staging checkpoint already contains this seq. A duplicate
        // final chunk must still run verification and fail again, rather
        // than cloning/publishing unverified data.
        await expectRejects(
          () => raw.__claydoImport("tally", chunk, seq, token),
          /import verification failed/,
        );
        break;
      }
      await raw.__claydoImport("tally", chunk, seq, token);
      cursor = chunk.cursor;
    }
    const status = await raw.__claydoImportStatus();
    expect(status.kind).toBeUndefined();
    expect(status.importing).toBeDefined();
    await runInDurableObject(raw, async (_instance, state) => {
      const importState = (await state.storage.get(
        "__claydo:import",
      )) as ImportState;
      importState.updatedAtMs = Date.now() - 60_000;
      await state.storage.put("__claydo:import", importState);
    });
    const restarted = await migrateInstance({
      from: old,
      to: tally(),
      name: "m4-verify-retry",
    });
    expect(restarted.skipped).toBe(false);
    expect(await tally().get("m4-verify-retry").total()).toBe(5);
  });

  it("serializes concurrent duplicate final chunks without deleting live data", async () => {
    await seed("m4-final-race");
    const old = legacy("m4-final-race");
    const raw = rawTarget("m4-final-race");
    const token = "final-race";
    await old.__claydoSeal(undefined, undefined, "tally:m4-final-race");
    await raw.__claydoBeginImport("tally", token);
    let cursor: ExportChunk["cursor"] = null;
    let seq = 0;
    let finalChunk: ExportChunk | undefined;
    for (;;) {
      const chunk = (await old.__claydoExport(
        undefined,
        cursor,
        { maxRows: 1 },
      )) as ExportChunk;
      seq += 1;
      if (chunk.cursor === null) {
        finalChunk = chunk;
        const [first, duplicate] = await Promise.all([
          raw.__claydoImport("tally", chunk, seq, token),
          raw.__claydoImport("tally", chunk, seq, token),
        ]);
        expect([first.alreadyApplied, duplicate.alreadyApplied].sort()).toEqual([
          false,
          true,
        ]);
        expect(first.done).toBe(true);
        expect(duplicate.done).toBe(true);
        break;
      }
      await raw.__claydoImport("tally", chunk, seq, token);
      cursor = chunk.cursor;
    }
    expect(await tally().get("m4-final-race").total()).toBe(5);
    await raw.__claydoReset("tally:m4-final-race");
    await tally().get("m4-final-race").bump("racing-traffic", 1);
    await expectRejects(
      () =>
        raw.__claydoImport(
          "tally",
          finalChunk!,
          seq,
          token,
        ),
      /no import is reserved/,
    );
    expect(await tally().get("m4-final-race").total()).toBe(1);
    await old.__claydoUnseal();
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
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");

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
    await old.remindAt(Date.now() + 60_000);
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
    await tally().get("m8").remindAt(Date.now() + 60_000);
    await expectRejects(
      () => migrateInstance({ from: legacy("m8"), to: tally(), name: "m8" }),
      /both the old instance .* are live/,
    );
    // Recovery path from the error message: wipe the polluted target.
    await wipeTarget(tally(), "m8");
    expect(await runDurableObjectAlarm(rawTarget("m8"))).toBe(false);
    const summary = await migrateInstance({
      from: legacy("m8"),
      to: tally(),
      name: "m8",
    });
    expect(summary.skipped).toBe(false);
    expect(await tally().get("m8").total()).toBe(5);
    expect(await tally().get("m8").getNote("color")).toBe("blue");
  });

  it("recovers an interrupted target reset before kind or alarm access", async () => {
    const target = tally().get("m8-reset-recovery");
    await target.bump("data", 3);
    await target.remindAt(Date.now() + 60_000);
    const raw = rawTarget("m8-reset-recovery");
    await runInDurableObject(raw, async (_instance, state) => {
      await state.storage.put("__claydo:reset", { kinds: ["tally"] });
      await state.storage.deleteAlarm();
    });

    expect(await raw.__claydoKind()).toBeUndefined();
    expect(await runDurableObjectAlarm(raw)).toBe(false);
    expect(await target.total()).toBe(0);
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

  it("blocks RPC methods that use constructor-captured storage", async () => {
    const old = legacy("m9-captured");
    await old.bump("x");
    await old.__claydoSeal();
    await expectRejects(
      () => old.putThroughCapturedStorage("late", "write"),
      /is sealed/,
    );
    await old.__claydoUnseal();
    expect(await old.getRaw("late")).toBeUndefined();
  });

  it("blocks synchronous KV writes that race a seal", async () => {
    const old = legacy("m9-sync-kv");
    await old.bump("x");
    const write = old.delayedSyncKvPut("late", "write", 50);
    await scheduler.wait(10);
    await old.__claydoSeal();
    await expectRejects(() => write, /is sealed/);
    await old.__claydoUnseal();
    expect(await old.getRaw("late")).toBeUndefined();
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
    await old.putRaw("__claydo:kind", "user-owned-value");
    await migrateInstance({ from: old, to: tally(), name: "m11" });
    const moved = tally().get("m11");
    expect(await moved.getRaw("__claydonote")).toBe("mine");
    expect(await moved.getRaw("__claydo:kind")).toBe("user-owned-value");
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

  it("refuses to copy one old instance to a second target", async () => {
    await seed("one-source");
    const old = legacy("one-source");
    await migrateInstance({
      from: old,
      to: tally(),
      name: "one-target",
    });
    await expectRejects(
      () =>
        migrateInstance({
          from: old,
          to: tally(),
          name: "second-target",
        }),
      /already claimed by target 'tally:one-target'/,
    );
    expect(await tally().get("one-target").total()).toBe(5);
    expect((await rawTarget("second-target").__claydoImportStatus()).kind)
      .toBeUndefined();
  });

  it("does not stamp a manual seal as migrated when the target is live", async () => {
    const old = legacy("manual-seal");
    await old.bump("source", 5);
    const alarm = Date.now() + 60_000;
    await old.remindAt(alarm);
    await old.__claydoSeal();
    await tally().get("manual-seal").bump("unrelated", 1);

    await expectRejects(
      () =>
        migrateInstance({
          from: old,
          to: tally(),
          name: "manual-seal",
        }),
      /sealed without a migration claim.*uncopied data/s,
    );
    expect(await old.__claydoSealed()).toEqual({ sealed: true });
    expect(await old.__claydoStats()).toMatchObject({ alarm });
    expect(await tally().get("manual-seal").total()).toBe(1);
  });

  it("repairs a missing move stamp when the target has a verified receipt", async () => {
    const old = legacy("manual-seal-verified");
    await old.bump("source", 5);
    await old.__claydoSeal();
    const raw = rawTarget("manual-seal-verified");
    const token = "manual-seal-verified";
    const begin = await raw.__claydoBeginImport("tally", token);
    if (!begin.ok) expect.unreachable("fresh import must be reserved");
    await old.__claydoSeal(
      undefined,
      undefined,
      "tally:manual-seal-verified",
      begin.migrationId,
    );
    let cursor: ExportChunk["cursor"] = null;
    let seq = 0;
    for (;;) {
      const chunk = (await old.__claydoExport(
        undefined,
        cursor,
      )) as ExportChunk;
      seq += 1;
      await raw.__claydoImport("tally", chunk, seq, token);
      if (chunk.cursor === null) break;
      cursor = chunk.cursor;
    }
    expect((await old.__claydoSealed()).movedTo).toBeUndefined();
    expect((await raw.__claydoImportStatus()).completed).toEqual({
      kind: "tally",
      seq,
      migrationId: begin.migrationId,
    });

    const repaired = await migrateInstance({
      from: old,
      to: tally(),
      name: "manual-seal-verified",
    });
    expect(repaired).toMatchObject({
      skipped: true,
      reason: "already migrated",
    });
    expect((await old.__claydoSealed()).movedTo).toBe(
      "tally:manual-seal-verified",
    );
    expect(await tally().get("manual-seal-verified").total()).toBe(5);
  });

  it("lets only one concurrent target claim a source", async () => {
    await seed("claim-race");
    const old = legacy("claim-race");
    const names = ["claim-a", "claim-b"] as const;
    const results = await Promise.allSettled(
      names.map((name) =>
        migrateInstance({ from: old, to: tally(), name }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    expect(String(failed?.reason)).toMatch(/already claimed by target/);
    const winner = names[results.findIndex((result) => result.status === "fulfilled")]!;
    const loser = names.find((name) => name !== winner)!;
    expect(await tally().get(winner).total()).toBe(5);
    const loserStatus = await rawTarget(loser).__claydoImportStatus();
    expect(loserStatus.kind).toBeUndefined();
    expect(loserStatus.importing).toBeUndefined();
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

  it("resolve() reports which side serves a name", async () => {
    await seed("r9");
    const accessor = migrated(env.LEGACY, tally(), {
      strategy: "manual",
      oldRouteTtlMs: 0,
    });
    expect(await accessor.resolve("r9")).toBe("old");
    await migrateInstance({ from: legacy("r9"), to: tally(), name: "r9" });
    expect(await accessor.resolve("r9")).toBe("new");
  });

  it("resolve() reports conflict and stalled states", async () => {
    await seed("r9-conflict");
    await tally().get("r9-conflict").bump("target", 1);
    const manual = migrated(env.LEGACY, tally(), { strategy: "manual" });
    expect(await manual.resolve("r9-conflict")).toBe("conflict");

    await seed("r9-stalled");
    const old = legacy("r9-stalled");
    await old.__claydoSeal(undefined, undefined, "tally:r9-stalled");
    const raw = rawTarget("r9-stalled");
    await raw.__claydoBeginImport("tally", "stalled");
    await runInDurableObject(raw, async (_instance, state) => {
      const importState = (await state.storage.get(
        "__claydo:import",
      )) as ImportState;
      importState.updatedAtMs = Date.now() - 60_000;
      await state.storage.put("__claydo:import", importState);
    });
    expect(await manual.resolve("r9-stalled")).toBe("stalled");
    await raw.__claydoAbortImport("stalled");
    await expectRejects(
      () => manual.get("r9-stalled").total(),
      /is sealed, but target 'tally:r9-stalled' is not live/,
    );
    expect((await raw.__claydoImportStatus()).kind).toBeUndefined();
    await old.__claydoUnseal();
  });

  it("resolve() is read-only even under the lazy strategy", async () => {
    await seed("r10");
    const accessor = migrated(env.LEGACY, tally(), { strategy: "lazy" });
    // A progress sweep over untouched names must not migrate them.
    expect(await accessor.resolve("r10")).toBe("old");
    expect(await accessor.resolve("r10")).toBe("old");
    expect((await legacy("r10").__claydoSealed()).sealed).toBe(false);
    const status = await rawTarget("r10").__claydoImportStatus();
    expect(status.kind).toBeUndefined();
    // A real touch still migrates, and resolve() notices.
    expect(await accessor.get("r10").total()).toBe(5);
    expect(await accessor.resolve("r10")).toBe("new");
  });

  it("lazy routing adopts a stale crashed import instead of caching new", async () => {
    await seed("r11");
    const old = legacy("r11");
    const raw = rawTarget("r11");
    await old.__claydoSeal(undefined, undefined, "tally:r11");
    const begin = await raw.__claydoBeginImport(
      "tally",
      "dead-router-driver",
      undefined,
      { maxRows: 1, maxBytes: 256 * 1024 },
    );
    if (!begin.ok) expect.unreachable("fresh import must be reserved");
    await old.__claydoSeal(
      undefined,
      undefined,
      "tally:r11",
      begin.migrationId,
    );
    const first = await old.__claydoExport(undefined, null, { maxRows: 1 });
    await raw.__claydoImport(
      "tally",
      first,
      1,
      "dead-router-driver",
    );
    await runInDurableObject(raw, async (_instance, state) => {
      const importState = (await state.storage.get(
        "__claydo:import",
      )) as ImportState;
      importState.updatedAtMs = Date.now() - 60_000;
      await state.storage.put("__claydo:import", importState);
    });

    const accessor = migrated(env.LEGACY, tally(), { strategy: "lazy" });
    expect(await accessor.get("r11").total()).toBe(5);
    expect(await accessor.resolve("r11")).toBe("new");
  });
});

describe("data fidelity extensions", () => {
  it("excludes generated columns and recomputes them on the target", async () => {
    const old = legacy("g1");
    await old.bump("x");
    await old.addPriced("widget", 250);
    await old.addPriced("gadget", 999);
    await migrateInstance({ from: old, to: tally(), name: "g1" });
    expect(await tally().get("g1").pricedRows()).toEqual([
      { name: "widget", cents: 250, dollars: 2.5, upper_name: "WIDGET" },
      { name: "gadget", cents: 999, dollars: 9.99, upper_name: "GADGET" },
    ]);
  });

  it("migrates a self-contained FTS5 table with searchability intact", async () => {
    const old = legacy("g2");
    await old.bump("x");
    await old.addDoc("the quick brown fox");
    await old.addDoc("jumped over the lazy dog");
    await migrateInstance({ from: old, to: tally(), name: "g2" });
    const moved = tally().get("g2");
    expect(await moved.searchDocs("fox")).toEqual(["the quick brown fox"]);
    expect(await moved.searchDocs("lazy")).toEqual([
      "jumped over the lazy dog",
    ]);
    // The index keeps working for rows added after the migration.
    await moved.addDoc("a newly added document");
    expect(await moved.searchDocs("newly")).toEqual(["a newly added document"]);
  });

  it("migrates an external-content FTS5 index by rebuilding it", async () => {
    const old = legacy("g3");
    await old.bump("x");
    await runInDurableObject(old, async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS articles (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`,
      );
      state.storage.sql.exec(
        `INSERT INTO articles (body) VALUES ('claydo migrates namespaces'), ('roses are red')`,
      );
      state.storage.sql.exec(
        `CREATE VIRTUAL TABLE articles_fts USING fts5(body, content='articles', content_rowid='id')`,
      );
      state.storage.sql.exec(
        `INSERT INTO articles_fts(articles_fts) VALUES('rebuild')`,
      );
    });
    await migrateInstance({ from: old, to: tally(), name: "g3" });
    expect(await tally().get("g3").searchArticles("namespaces")).toEqual([
      "claydo migrates namespaces",
    ]);
  });

  it("migrates child tables that sort before their foreign-key parents", async () => {
    const old = legacy("g3-foreign-keys");
    await old.bump("x");
    await runInDurableObject(old, async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
      );
      state.storage.sql.exec(
        `CREATE TABLE orders (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id)
        )`,
      );
      state.storage.sql.exec(`INSERT INTO users VALUES (1, 'Ada')`);
      state.storage.sql.exec(`INSERT INTO orders VALUES (1, 1)`);
    });
    await migrateInstance({
      from: old,
      to: tally(),
      name: "g3-foreign-keys",
      maxRowsPerChunk: 1,
    });
    expect(await tally().get("g3-foreign-keys").relationalRows()).toEqual({
      users: 1,
      orders: 1,
    });
  });

  it("refuses contentless FTS5 pre-flight, before sealing anything", async () => {
    const old = legacy("g4");
    await old.bump("x");
    await runInDurableObject(old, async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE VIRTUAL TABLE ghost USING fts5(body, content='')`,
      );
    });
    await expectRejects(
      () => migrateInstance({ from: old, to: tally(), name: "g4" }),
      /contentless FTS5/,
    );
    expect((await old.__claydoSealed()).sealed).toBe(false);
  });

  it("refuses tables with a column that shadows the rowid", async () => {
    const old = legacy("g5");
    await old.bump("x");
    await runInDurableObject(old, async (_instance, state) => {
      state.storage.sql.exec(`CREATE TABLE weird (rowid TEXT, data TEXT)`);
      state.storage.sql.exec(`INSERT INTO weird VALUES ('a', 'b')`);
    });
    await expectRejects(
      () => migrateInstance({ from: old, to: tally(), name: "g5" }),
      /shadows the rowid/,
    );
    expect((await old.__claydoSealed()).sealed).toBe(false);
  });

  it("refuses rowids outside JavaScript's safe integer range", async () => {
    const old = legacy("g6");
    await old.bump("x");
    await runInDurableObject(old, async (_instance, state) => {
      state.storage.sql.exec(`CREATE TABLE huge_rowid (value TEXT)`);
      state.storage.sql.exec(
        `INSERT INTO huge_rowid(rowid, value)
         VALUES (9223372036854775807, 'too large')`,
      );
    });
    const preview = await previewInstance({ from: old });
    expect(preview.blockers.join(" ")).toMatch(/safe integer range/);
    await expectRejects(
      () => migrateInstance({ from: old, to: tally(), name: "g6" }),
      /unsafe 64-bit rowids cannot be copied exactly/,
    );
    expect((await old.__claydoSealed()).sealed).toBe(false);
  });

  it("checks unsafe rowids when INTEGER PRIMARY KEY is named rowid", async () => {
    const old = legacy("g7");
    await old.bump("x");
    await runInDurableObject(old, async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TABLE alias_huge (rowid INTEGER PRIMARY KEY, value TEXT)`,
      );
      state.storage.sql.exec(
        `INSERT INTO alias_huge(rowid, value)
         VALUES (9223372036854775807, 'too large')`,
      );
    });
    const preview = await previewInstance({ from: old });
    expect(preview.blockers.join(" ")).toMatch(
      /table 'alias_huge'.*safe integer range/,
    );
    expect((await old.__claydoSealed()).sealed).toBe(false);
  });

  it("rejects the exclusive lower pagination boundary", async () => {
    const old = legacy("g8");
    await old.bump("x");
    await runInDurableObject(old, async (_instance, state) => {
      state.storage.sql.exec(`CREATE TABLE floor_rowid (value TEXT)`);
      state.storage.sql.exec(
        `INSERT INTO floor_rowid(rowid, value)
         VALUES (-9007199254740991, 'at floor')`,
      );
    });
    const preview = await previewInstance({ from: old });
    expect(preview.blockers.join(" ")).toMatch(
      /table 'floor_rowid'.*exportable safe integer range/,
    );
    expect((await old.__claydoSealed()).sealed).toBe(false);
  });

  it("rejects unsafe integers in ordinary columns", async () => {
    const old = legacy("g9");
    await old.bump("x");
    await runInDurableObject(old, async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TABLE snowflakes (
          id INTEGER PRIMARY KEY,
          external_id INTEGER NOT NULL
        )`,
      );
      state.storage.sql.exec(
        `INSERT INTO snowflakes VALUES (1, 1152921504606846977)`,
      );
    });
    const preview = await previewInstance({ from: old });
    expect(preview.blockers.join(" ")).toMatch(
      /column 'external_id'.*outside JavaScript's safe range/,
    );
    expect((await old.__claydoSealed()).sealed).toBe(false);
  });

  it("does not treat INTEGER PRIMARY KEY DESC as a rowid alias", async () => {
    const old = legacy("g10");
    await old.bump("x");
    await runInDurableObject(old, async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TABLE descending_ids (
          id INTEGER PRIMARY KEY DESC,
          value TEXT NOT NULL
        )`,
      );
      state.storage.sql.exec(
        `INSERT INTO descending_ids VALUES
          (100, 'a'), (200, 'b'), (300, 'c')`,
      );
    });
    await migrateInstance({
      from: old,
      to: tally(),
      name: "g10",
      maxRowsPerChunk: 1,
    });
    expect(await tally().get("g10").descendingPrimaryKeys()).toEqual([
      100,
      200,
      300,
    ]);
  });
});

describe("previewInstance and progress", () => {
  it("previews sizes and blockers without sealing", async () => {
    await seed("p1");
    const preview = await previewInstance({ from: legacy("p1") });
    expect(preview.sealed).toBe(false);
    expect(preview.hasData).toBe(true);
    expect(preview.rows["counts"]).toBe(2);
    expect(preview.kv).toBe(1);
    expect(preview.blockers).toEqual([]);
    // Preview changed nothing.
    expect((await legacy("p1").__claydoSealed()).sealed).toBe(false);
    expect(await legacy("p1").bump("apples")).toBe(3);
  });

  it("preview reports blockers instead of throwing", async () => {
    const old = legacy("p2");
    await old.bump("x");
    await runInDurableObject(old, async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TABLE norow (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`,
      );
    });
    const preview = await previewInstance({ from: old });
    expect(preview.blockers.length).toBe(1);
    expect(preview.blockers[0]).toMatch(/WITHOUT ROWID/);
  });

  it("rejects the exact staging checkpoint key before sealing", async () => {
    const old = legacy("p-checkpoint-key");
    await old.bump("x");
    await old.putRaw("__claydo:import-checkpoint", "user value");
    const preview = await previewInstance({ from: old });
    expect(preview.blockers.join(" ")).toMatch(/reserved for target staging/);
    await expectRejects(
      () =>
        migrateInstance({
          from: old,
          to: tally(),
          name: "p-checkpoint-key",
        }),
      /reserved for target staging/,
    );
    expect((await old.__claydoSealed()).sealed).toBe(false);
  });

  it("reports progress per chunk", async () => {
    const old = legacy("p3");
    for (let i = 0; i < 9; i++) await old.bump(`l${i}`);
    const progress: MigrationProgress[] = [];
    const summary = await migrateInstance({
      from: old,
      to: tally(),
      name: "p3",
      maxRowsPerChunk: 2,
      onProgress: (update) => progress.push(update),
    });
    expect(progress.length).toBe(summary.chunks);
    expect(progress.at(-1)!.done).toBe(true);
    expect(progress.at(-1)!.phase).toBe("final");
    expect(progress.at(-1)!.applied.rows["counts"]).toBe(9);
    expect(progress.slice(0, -1).every((update) => !update.done)).toBe(true);
    expect(progress.some((update) => update.phase === "rows")).toBe(true);
  });
});

describe("blocker tables and routing", () => {
  it("routes and resolves blocker instances instead of failing", async () => {
    const old = legacy("b1");
    await old.bump("x");
    await runInDurableObject(old, async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TABLE pins (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`,
      );
      state.storage.sql.exec(`INSERT INTO pins VALUES ('a', 'b')`);
    });
    const accessor = migrated(env.LEGACY, tally(), { strategy: "drain" });
    // The facade must keep serving an instance the exporter cannot move:
    // blockers are enforced by export/migrate, never by routing.
    expect(await accessor.resolve("b1")).toBe("old");
    expect(await accessor.get("b1").bump("x")).toBe(2);
    // The bulk driver still refuses pre-flight, without sealing anything.
    await expectRejects(
      () => migrateInstance({ from: old, to: tally(), name: "b1" }),
      /WITHOUT ROWID/,
    );
    expect((await old.__claydoSealed()).sealed).toBe(false);
    expect(await accessor.get("b1").total()).toBe(2);
  });

  it("counts rows in blocker-only tables as data", async () => {
    const old = legacy("b2");
    // The ONLY data lives in a table the exporter cannot move. Routing
    // must still treat the old side as authoritative.
    await runInDurableObject(old, async (_instance, state) => {
      state.storage.sql.exec(
        `CREATE TABLE pins (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`,
      );
      state.storage.sql.exec(`INSERT INTO pins VALUES ('a', 'b')`);
    });
    expect(await old.__claydoHasData()).toBe(true);
    const preview = await previewInstance({ from: old });
    expect(preview.hasData).toBe(true);
    expect(preview.blockers.length).toBe(1);
    const accessor = migrated(env.LEGACY, tally(), { strategy: "lazy" });
    expect(await accessor.resolve("b2")).toBe("old");
  });
});

describe("framework-shaped classes", () => {
  const fw = () => kind(env.APP_DO, "fw");

  function legacyFw(name: string) {
    return env.LEGACY_FW.get(env.LEGACY_FW.idFromName(name));
  }

  it("exportable() preserves construction and prototype shape", async () => {
    // FrameworkImpl's constructor calls a prototype method during super()
    // and then verifies no prototype level owns both deprecated hooks.
    // Construction succeeding at all is the assertion.
    const old = legacyFw("f1");
    await old.setEntry("greeting", "hello");
    expect(await old.getEntry("greeting")).toBe("hello");
  });

  it("seals framework instances and migrates them", async () => {
    const old = legacyFw("f2");
    await old.setEntry("a", "1");
    await old.setEntry("b", "2");
    const summary = await migrateInstance({
      from: old as never,
      to: fw(),
      name: "f2",
    });
    expect(summary.skipped).toBe(false);
    expect(summary.rows["fw"]).toBe(2);
    expect(await fw().get("f2").getEntry("a")).toBe("1");
    // The old side is frozen: storage access fails with the seal message.
    await expectRejects(() => old.getEntry("a"), /is sealed/);
    const gone = await old.fetch("https://do/");
    expect(gone.status).toBe(410);
  });
});
