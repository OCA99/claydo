import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import { migrateInstance, type ExportChunk } from "../../../src/migrate";

const gnarly = () => kind(env.APP_DO, "gnarly");
const old = (name: string) =>
  env.OLD_GNARLY.get(env.OLD_GNARLY.idFromName(name));

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
    expect(probe.scheduled).toBe(ts);
    expect(probe.firedAt).toBeNull();

    expect(await runDurableObjectAlarm(source)).toBe(false);

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
    expect(summary.alarm).toBeNull();
    const probe = await gnarly().get("alarm-past").alarmProbe();
    expect(probe.scheduled).toBeNull();
    expect(probe.firedAt).toBe(fired);
  });

  it("an alarm that fires while sealed defers itself and survives the migration", async () => {
    const source = old("alarm-sealed");
    await source.kvPut("marker", "data");
    const armedAt = Date.now();
    await source.armAlarm(armedAt + 1);
    await source.__claydoSeal();

    expect(await runDurableObjectAlarm(source)).toBe(true);

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

    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "alarm-sealed",
    });
    expect(summary.alarm).toBe(deferred);

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

    await expectRejects(
      () => migrateInstance({ from: source, to: gnarly(), name: "worid" }),
      /^Error: claydo: table 'wor_t' is WITHOUT ROWID, which the exporter does not support yet\. Copy this table with custom code, or recreate it with a rowid\.$/,
    );

    expect(await source.__claydoSealed()).toEqual({ sealed: false });
    const afterFailure = await source.fingerprintAll();
    expect(afterFailure).toEqual(before);
    const status = await (
      gnarly().get("worid").stub as unknown as {
        __claydoImportStatus(): Promise<{ kind?: string; importing?: unknown }>;
      }
    ).__claydoImportStatus();
    expect(status).toEqual({});

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

  it("FTS5 virtual table migrates with searchability intact and rebuilt shadow tables", async () => {
    const source = old("virt");
    expect(await source.seedVirtual()).toBe("ok");

    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "virt",
    });
    expect(summary.rows["keep_t"]).toBe(2);
    expect(summary.rows["fts_docs"]).toBe(1);

    const rows = await gnarly()
      .get("virt")
      .runSql(`SELECT v FROM keep_t ORDER BY id`);
    expect(rows.rows.map((r) => r[0])).toEqual(["x", "y"]);
    const hits = await gnarly()
      .get("virt")
      .runSql(`SELECT body FROM fts_docs WHERE fts_docs MATCH 'gnarly'`);
    expect(hits.rows.map((r) => r[0])).toEqual(["hello gnarly world"]);
    const shadows = await gnarly()
      .get("virt")
      .runSql(
        `SELECT name FROM sqlite_master WHERE name LIKE 'fts\\_docs\\_%' ESCAPE '\\' ORDER BY name`,
      );
    expect(shadows.rows.map((r) => r[0])).toEqual([
      "fts_docs_config",
      "fts_docs_content",
      "fts_docs_data",
      "fts_docs_docsize",
      "fts_docs_idx",
    ]);
  });
});
