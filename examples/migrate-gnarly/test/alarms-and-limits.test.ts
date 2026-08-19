/**
 * Alarm-transfer semantics and the documented WITHOUT ROWID / virtual-table
 * limits, including the state after a failed migration (rollback) and
 * recovery by dropping the offending table.
 *
 * Assertions marked `BUG:` document observed data loss verbatim; see
 * ../DX-REPORT.md.
 */
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import { migrateInstance, type ExportChunk } from "../../../src/migrate";

const gnarly = () => kind(env.APP_DO, "gnarly");
const old = (name: string) =>
  env.OLD_GNARLY.get(env.OLD_GNARLY.idFromName(name));

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
    // fires pre-seal on the old side or is swallowed by the seal (see the
    // next test for the swallowed case).
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

  it("BUG: an alarm that elapses while the instance is sealed is silently lost", async () => {
    const source = old("alarm-sealed");
    await source.kvPut("marker", "data");
    const ts = Date.now() + 700;
    await source.armAlarm(ts);
    await source.__claydoSeal();

    // The alarm elapses during the (simulated slow) migration window. The
    // sealed wrapper turns alarm() into a no-op that RETURNS SUCCESSFULLY,
    // so the runtime deletes the alarm instead of retrying it.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Walk the export to the final chunk: the alarm is exported as null.
    // (Papercut: the ExportChunk return type collapses to `never` over the
    // RPC stub typing, because ExportChunk.kv holds `unknown` values, so
    // the casts below are required.)
    let chunk = (await source.__claydoExport(undefined, null)) as ExportChunk;
    while (chunk.cursor !== null) {
      chunk = (await source.__claydoExport(
        undefined,
        chunk.cursor,
      )) as ExportChunk;
    }
    expect(chunk.alarm).toBeNull(); // BUG: pending work vanished

    // Even after rollback (unseal), the alarm is gone and never fired.
    await source.__claydoUnseal();
    const probe = await source.alarmProbe();
    expect(probe.scheduled).toBeNull();
    expect(probe.firedAt).toBeNull();
  });
});

describe("6. WITHOUT ROWID and virtual tables", () => {
  it("WITHOUT ROWID: fails with a clear error, rolls back cleanly, and migrates after dropping the table", async () => {
    const source = old("worid");
    await source.seedWithoutRowid();
    const before = await source.fingerprintAll();

    await expect(
      migrateInstance({ from: source, to: gnarly(), name: "worid" }),
    ).rejects.toThrow(
      "claydo: migration of 'worid' to kind 'gnarly' failed and was rolled " +
        "back (old instance unsealed): claydo: table 'wor_t' is WITHOUT " +
        "ROWID, which the exporter does not support yet. Copy this table " +
        "with custom code, or recreate it with a rowid.",
    );

    // Rollback state: the old instance is unsealed and untouched...
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

  it("virtual table (fts5 exists in DO SQLite): fails with a clear error and migrates after dropping it", async () => {
    const source = old("virt");
    // fts5 IS available in Durable Object SQLite.
    expect(await source.seedVirtual()).toBe("ok");

    await expect(
      migrateInstance({ from: source, to: gnarly(), name: "virt" }),
    ).rejects.toThrow(
      "claydo: migration of 'virt' to kind 'gnarly' failed and was rolled " +
        "back (old instance unsealed): claydo: table 'fts_docs' is a " +
        "virtual table, which the exporter does not support. Drop it " +
        "before migrating or copy it with custom code.",
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
