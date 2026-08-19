/**
 * Alarm-transfer semantics and the documented WITHOUT ROWID / virtual-table
 * limits, including the state after a failed migration and recovery by
 * dropping the offending table.
 *
 * POST-FIX VERSION: the sealed-alarm data-loss finding is fixed (alarms now
 * defer themselves through the sealed window), and unsupported-table errors
 * surface as a pre-flight check before anything is sealed or reserved.
 */
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import { migrateInstance, type ExportChunk } from "../../../src/migrate";

const gnarly = () => kind(env.APP_DO, "gnarly");
const old = (name: string) =>
  env.OLD_GNARLY.get(env.OLD_GNARLY.idFromName(name));

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

describe("5. alarms", () => {
  it("preserves a near-future alarm timestamp exactly, and it fires on the new side", async () => {
    const source = old("alarm-soon");
    await source.kvPut("k", "v");
    const ts = Date.now() + 60_000;
    expect(await source.armAlarm(ts)).toBe(ts);

    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "alarm-soon",
    });
    expect(summary.alarm).toBe(ts);

    const moved = gnarly().get("alarm-soon");
    const probe = await moved.alarmProbe();
    // The timestamp survives to the millisecond (it is > now + 1s, so the
    // importer's clamp does not move it).
    expect(probe.scheduled).toBe(ts);
    expect(probe.firedAt).toBeNull();

    // The old instance's alarm is gone (deleted when the move marker was
    // recorded), so it can never fire there again.
    expect(await runDurableObjectAlarm(source)).toBe(false);

    // Forcing the alarm runs the kind's handler on the new side.
    const ran = await runDurableObjectAlarm(
      env.APP_DO.get(env.APP_DO.idFromName("gnarly:alarm-soon")),
    );
    expect(ran).toBe(true);
    expect((await moved.alarmProbe()).firedAt).not.toBeNull();
  });

  it("an alarm already in the past fires on the OLD side before the copy; the new side gets no alarm", async () => {
    const source = old("alarm-past");
    await source.kvPut("k", "v");
    await source.armAlarm(Date.now() - 60_000);

    // workerd runs an overdue alarm immediately. Wait for it so the test is
    // deterministic — in production this race is real: the alarm either
    // fires pre-seal on the old side (this test) or lands in the sealed
    // window, where it now defers itself (next test).
    let fired: number | null = null;
    for (let i = 0; i < 40 && fired === null; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      fired = (await source.alarmProbe()).firedAt;
    }
    expect(fired).not.toBeNull();

    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "alarm-past",
    });
    // Nothing pending to transfer: the alarm already ran (and its effects,
    // like the KV marker our handler wrote, migrate as ordinary data).
    expect(summary.alarm).toBeNull();
    const probe = await gnarly().get("alarm-past").alarmProbe();
    expect(probe.scheduled).toBeNull();
    expect(probe.firedAt).toBe(fired);
  });

  it("FIXED: an alarm that fires while sealed defers itself and survives the migration", async () => {
    const source = old("alarm-sealed");
    await source.kvPut("marker", "data");
    const armedAt = Date.now();
    await source.armAlarm(armedAt + 1);
    await source.__claydoSeal();

    // The alarm fires during the sealed window. Previously the sealed
    // no-op returned success and the runtime deleted the alarm (silent
    // loss). Now it DEFERS itself: re-arms at now + 60s with a
    // console.warn, so the export still captures it.
    expect(await runDurableObjectAlarm(source)).toBe(true);

    // Walk the export to the final chunk: the deferred alarm is captured.
    let chunk = (await source.__claydoExport(undefined, null)) as ExportChunk;
    while (chunk.cursor !== null) {
      chunk = (await source.__claydoExport(
        undefined,
        chunk.cursor,
      )) as ExportChunk;
    }
    expect(typeof chunk.alarm).toBe("number");
    const deferred = chunk.alarm as number;
    expect(deferred).toBeGreaterThan(armedAt + 50_000);
    expect(deferred).toBeLessThan(armedAt + 70_000);

    // Complete the migration (the instance is already sealed; the driver
    // resumes ownership).
    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "alarm-sealed",
    });
    expect(summary.alarm).toBe(deferred);

    // The new side holds the deferred alarm and its handler fires there.
    const moved = gnarly().get("alarm-sealed");
    const probe = await moved.alarmProbe();
    expect(probe.scheduled).toBe(deferred);
    expect(probe.firedAt).toBeNull();
    expect(
      await runDurableObjectAlarm(
        env.APP_DO.get(env.APP_DO.idFromName("gnarly:alarm-sealed")),
      ),
    ).toBe(true);
    expect((await moved.alarmProbe()).firedAt).not.toBeNull();

    // The old instance's deferred alarm was deleted when the move marker
    // was recorded: nothing left to fire on the old side.
    expect(await runDurableObjectAlarm(source)).toBe(false);
    const seal = await source.__claydoSealed();
    expect(seal.sealed).toBe(true);
    expect(seal.movedTo).toBeDefined();
  });
});

describe("6. WITHOUT ROWID and virtual tables", () => {
  it("WITHOUT ROWID: fails pre-flight with a clear error, leaves both sides untouched, and migrates after dropping the table", async () => {
    const source = old("worid");
    await source.seedWithoutRowid();
    const before = await source.fingerprintAll();

    // The unsupported table is now detected by the driver's pre-flight
    // hasData probe, BEFORE anything is sealed or reserved — so the raw
    // exporter error surfaces (no rollback wrapper, because there is
    // nothing to roll back).
    await expectRejects(
      () => migrateInstance({ from: source, to: gnarly(), name: "worid" }),
      /^Error: claydo: table 'wor_t' is WITHOUT ROWID, which the exporter does not support yet\. Copy this table with custom code, or recreate it with a rowid\.$/,
    );

    // Nothing was touched: the old instance was never sealed and is
    // bit-identical...
    expect(await source.__claydoSealed()).toEqual({ sealed: false });
    const afterFailure = await source.fingerprintAll();
    expect(afterFailure).toEqual(before);
    // ...and the target is clean (no kind pinned, no partial import).
    const status = await (
      gnarly().get("worid").stub as unknown as {
        __claydoImportStatus(): Promise<{ kind?: string; importing?: unknown }>;
      }
    ).__claydoImportStatus();
    expect(status).toEqual({});

    // Drop the offending table; the rest of the instance migrates fine.
    await source.dropTableByName("wor_t");
    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "worid",
    });
    expect(summary.rows["keep_t"]).toBe(3);
    const after = await gnarly().get("worid").fingerprintAll();
    expect(after.tables["keep_t"]).toEqual(before.tables["keep_t"]);
  });

  it("virtual table (fts5 exists in DO SQLite): fails pre-flight with a clear error and migrates after dropping it", async () => {
    const source = old("virt");
    // fts5 IS available in Durable Object SQLite.
    expect(await source.seedVirtual()).toBe("ok");

    await expectRejects(
      () => migrateInstance({ from: source, to: gnarly(), name: "virt" }),
      /^Error: claydo: table 'fts_docs' is a virtual table, which the exporter does not support\. Drop it before migrating or copy it with custom code\.$/,
    );
    expect(await source.__claydoSealed()).toEqual({ sealed: false });

    // fts5 leaves five shadow tables behind; DROP TABLE removes them all,
    // after which the migration succeeds.
    const shadows = await source.runSql(
      `SELECT name FROM sqlite_master WHERE name LIKE 'fts\\_docs%' ESCAPE '\\' ORDER BY name`,
    );
    expect(shadows.rows.map((r) => r[0])).toEqual([
      "fts_docs",
      "fts_docs_config",
      "fts_docs_content",
      "fts_docs_data",
      "fts_docs_docsize",
      "fts_docs_idx",
    ]);
    await source.dropTableByName("fts_docs");
    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "virt",
    });
    expect(summary.rows["keep_t"]).toBe(2);
    const rows = await gnarly()
      .get("virt")
      .runSql(`SELECT v FROM keep_t ORDER BY id`);
    expect(rows.rows.map((r) => r[0])).toEqual(["x", "y"]);
  });
});
