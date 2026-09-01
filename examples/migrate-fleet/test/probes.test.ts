import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kinds } from "../../../src/index";
import { migrated, migrateInstance, wipeTarget } from "../../../src/migrate";
import { IMPORT_STATE_KEY, type ImportState } from "../../../src/migrate-wire";

const sessions = () => kinds(env.APP_DO).session;
const secureSessions = () => kinds(env.SECURE_DO).session;

function old(name: string) {
  return env.OLD_SESSIONS.get(env.OLD_SESSIONS.idFromName(name));
}

function oldSecure(name: string) {
  return env.OLD_SECURE.get(env.OLD_SECURE.idFromName(name));
}

function rawHost(fullName: string) {
  return env.APP_DO.get(env.APP_DO.idFromName(fullName));
}

async function seed(name: string, stub = old(name)): Promise<void> {
  await stub.record("click", `${name}-a`);
  await stub.record("view", `${name}-b`);
  await stub.record("click", `${name}-c`);
  await stub.addTag("seeded");
  await stub.setPref("color", "blue");
  await stub.setPref("lang", "de");
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "<resolved without error>";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function backdateImport(fullName: string): Promise<void> {
  await runInDurableObject(rawHost(fullName), async (_instance, state) => {
    const s = (await state.storage.get(IMPORT_STATE_KEY)) as ImportState;
    s.updatedAtMs = Date.now() - 60_000;
    await state.storage.put(IMPORT_STATE_KEY, s);
  });
}

describe("crash and resume (with import ownership)", () => {
  it("a fresh crashed import is owned: a new driver fails fast without touching anything", async () => {
    const name = "p-resume";
    await seed(name);
    const before = await old(name).history();
    await old(name).__claydoSeal();
    const raw = rawHost(`session:${name}`);
    const begin = await raw.__claydoBeginImport(
      "session",
      "crashed-driver",
      undefined,
      { maxRows: 1, maxBytes: 256 * 1024 },
    );
    if (!begin.ok) expect.unreachable("fresh import must be reserved");
    await old(name).__claydoSeal(
      undefined,
      undefined,
      `session:${name}`,
      begin.migrationId,
    );
    const first = await old(name).__claydoExport(undefined, null, { maxRows: 1 });
    await raw.__claydoImport("session", first, 1, "crashed-driver");

    const message = await messageOf(
      migrateInstance({ from: old(name), to: sessions(), name }),
    );
    expect(message).toMatch(
      /another migration driver owns the import on instance 'session:p-resume' \(last progress \d+ms ago\)\. It is not stale yet; retry later\./,
    );
    expect((await old(name).__claydoSealed()).sealed).toBe(true);
    expect((await raw.__claydoImportStatus()).importing).toBeDefined();

    await backdateImport(`session:${name}`);
    const summary = await migrateInstance({
      from: old(name),
      to: sessions(),
      name,
      maxRowsPerChunk: 1,
    });
    expect(summary.resumed).toBe(true);
    expect(summary.skipped).toBe(false);
    expect(await sessions().get(name).history()).toStrictEqual(before);
    expect(await sessions().get(name).listPrefs()).toStrictEqual({
      color: "blue",
      lang: "de",
    });
    expect((await old(name).__claydoSealed()).movedTo).toBe(`session:${name}`);
  });

  it("restarts from scratch when the old instance was unsealed mid-crash (torn snapshot)", async () => {
    const name = "p-torn";
    await seed(name);
    await old(name).__claydoSeal();
    const raw = rawHost(`session:${name}`);
    const begin = await raw.__claydoBeginImport(
      "session",
      "crashed-driver",
      undefined,
      { maxRows: 1, maxBytes: 256 * 1024 },
    );
    if (!begin.ok) expect.unreachable("fresh import must be reserved");
    await old(name).__claydoSeal(
      undefined,
      undefined,
      `session:${name}`,
      begin.migrationId,
    );
    const first = await old(name).__claydoExport(undefined, null, { maxRows: 1 });
    await raw.__claydoImport("session", first, 1, "crashed-driver");

    await old(name).__claydoUnseal();
    await old(name).record("post-crash", "mutation");
    await old(name).setPref("color", "red"); // overwrite a kv already copied

    await backdateImport(`session:${name}`);
    const summary = await migrateInstance({
      from: old(name),
      to: sessions(),
      name,
      maxRowsPerChunk: 1,
    });
    expect(summary.resumed).toBe(false);
    expect(summary.skipped).toBe(false);
    expect(summary.rows["events"]).toBe(4);

    const moved = sessions().get(name);
    const history = await moved.history();
    expect(history).toHaveLength(4);
    expect(history[3]!.type).toBe("post-crash");
    expect(await moved.getPref("color")).toBe("red");
    expect(await moved.listPrefs()).toStrictEqual({ color: "red", lang: "de" });
  });
});

describe("duplicate concurrent drivers for the same instance", () => {
  it("the loser fails fast at reservation; the seal and the completed migration are untouched", async () => {
    const name = "p-race";
    await seed(name);
    const run = () =>
      migrateInstance({
        from: old(name),
        to: sessions(),
        name,
        maxRowsPerChunk: 1,
      });
    const results = await Promise.allSettled([run(), run()]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loser = (rejected[0]!.reason as Error).message;
    expect(loser).toMatch(
      /another migration driver owns the import on instance 'session:p-race' \(last progress \d+ms ago\)\. It is not stale yet; retry later\./,
    );
    expect(loser).not.toMatch(/rolled back/);

    const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value;
    expect(winner.skipped).toBe(false);
    expect(winner.rows["events"]).toBe(3);

    expect(await sessions().get(name).eventCount()).toBe(3);
    expect(await sessions().get(name).listPrefs()).toStrictEqual({
      color: "blue",
      lang: "de",
    });

    const seal = await old(name).__claydoSealed();
    expect(seal.sealed).toBe(true);
    expect(seal.movedTo).toBe(`session:${name}`);

    const rerun = await migrateInstance({ from: old(name), to: sessions(), name });
    expect(rerun.skipped).toBe(true);
    expect(rerun.reason).toBe("already migrated");
  });
});

describe("secrets", () => {
  it("rejects a driver without a secret when both sides require one", async () => {
    const name = "sec-none";
    await seed(name, oldSecure(name));
    const message = await messageOf(
      migrateInstance({ from: oldSecure(name), to: secureSessions(), name }),
    );
    expect(message).toMatch(/invalid migration secret/);
    expect(message).toMatch(/union\(\) options/);
    expect((await oldSecure(name).__claydoSealed("s1")).sealed).toBe(false);
    expect(await oldSecure(name).eventCount()).toBe(3);
  });

  it("rejects a driver with the wrong secret", async () => {
    const name = "sec-wrong";
    await seed(name, oldSecure(name));
    const message = await messageOf(
      migrateInstance({
        from: oldSecure(name),
        to: secureSessions(),
        name,
        secret: "not-s1",
      }),
    );
    expect(message).toMatch(/invalid migration secret/);
    expect((await oldSecure(name).__claydoSealed("s1")).sealed).toBe(false);
  });

  it("migrates with the correct secret", async () => {
    const name = "sec-right";
    await seed(name, oldSecure(name));
    const before = await oldSecure(name).history();
    const summary = await migrateInstance({
      from: oldSecure(name),
      to: secureSessions(),
      name,
      secret: "s1",
    });
    expect(summary.skipped).toBe(false);
    expect(summary.rows["events"]).toBe(3);
    expect(await secureSessions().get(name).history()).toStrictEqual(before);
  });

  it("secret on the OLD side only: the host ignores the extra secret", async () => {
    const name = "sec-old-only";
    await seed(name, oldSecure(name));
    const summary = await migrateInstance({
      from: oldSecure(name),
      to: sessions(),
      name,
      secret: "s1",
    });
    expect(summary.skipped).toBe(false);
    expect(await sessions().get(name).eventCount()).toBe(3);
  });

  it("secret on the OLD side only, driver forgets it: rejected by the old side", async () => {
    const name = "sec-old-only-missing";
    await seed(name, oldSecure(name));
    const message = await messageOf(
      migrateInstance({ from: oldSecure(name), to: sessions(), name }),
    );
    expect(message).toMatch(/invalid migration secret/);
    expect(message).toMatch(/exportable\(\) wrapper/);
    expect(await oldSecure(name).eventCount()).toBe(3);
  });

  it("secret on the HOST side only: rejected without it, accepted with it", async () => {
    const name = "sec-host-only";
    await seed(name);
    const message = await messageOf(
      migrateInstance({ from: old(name), to: secureSessions(), name }),
    );
    expect(message).toMatch(/invalid migration secret/);
    expect(message).toMatch(/union\(\) options/);
    const summary = await migrateInstance({
      from: old(name),
      to: secureSessions(),
      name,
      secret: "s1",
    });
    expect(summary.skipped).toBe(false);
    expect(await secureSessions().get(name).eventCount()).toBe(3);
  });
});

describe("import gating and wrong targets", () => {
  it("refuses at reservation for a non-importable kind, before anything is touched", async () => {
    const name = "p-gate";
    await seed(name);
    const message = await messageOf(
      migrateInstance({
        from: old(name),
        to: kinds(env.APP_DO).audit,
        name,
      }),
    );
    expect(message).toBe(
      `claydo: imports are not enabled for kind 'audit'. Pass { importable: true } or { importable: ["audit"] } to union().`,
    );
    expect(message).not.toMatch(/rolled back/);
    expect((await old(name).__claydoSealed()).sealed).toBe(false);
    expect(await old(name).record("after-refusal", "x")).toBe(4);
    const status = await rawHost(`audit:${name}`).__claydoImportStatus();
    expect(status.kind).toBeUndefined();
    expect(status.importing).toBeUndefined();
  });

  it("refuses a reservation whose declared kind contradicts the target name prefix", async () => {
    const target = rawHost("audit:mismatch");
    const message = await messageOf(
      target.__claydoBeginImport("session", "probe-token"),
    );
    expect(message).toMatch(
      /the target name 'audit:mismatch' implies kind 'audit', but the import declares kind 'session'/,
    );
  });

  it("refuses import chunks that were not preceded by a reservation", async () => {
    const name = "p-name";
    await seed(name);
    await old(name).__claydoSeal();
    const chunk = await old(name).__claydoExport(undefined, null);
    const target = rawHost("session:p-name-unreserved");
    const message = await messageOf(
      target.__claydoImport("session", chunk, 1, "probe-token"),
    );
    expect(message).toMatch(
      /no import is reserved on instance 'session:p-name-unreserved'\. Call __claydoBeginImport first \(migrateInstance does this automatically\)\./,
    );
    await old(name).__claydoUnseal();
  });
});

describe("ghost instances (never existed, no data)", () => {
  it("skips with a reason and touches nothing; allowEmpty opts into schema-only migration", async () => {
    const name = "p-ghost";
    const summary = await migrateInstance({
      from: old(name),
      to: sessions(),
      name,
    });
    expect(summary).toStrictEqual({
      skipped: true,
      reason:
        "old instance has no data (pass allowEmpty to migrate schema-only instances)",
      resumed: false,
      chunks: 0,
      kv: 0,
      rows: {},
      alarm: undefined,
    });
    expect((await old(name).__claydoSealed()).sealed).toBe(false);
    const status = await rawHost(`session:${name}`).__claydoImportStatus();
    expect(status.kind).toBeUndefined();
    expect(status.importing).toBeUndefined();

    const forced = await migrateInstance({
      from: old(name),
      to: sessions(),
      name,
      allowEmpty: true,
    });
    expect(forced.skipped).toBe(false);
    expect(forced.chunks).toBe(1);
    expect(forced.rows).toStrictEqual({ events: 0, tags: 0 });
    const seal = await old(name).__claydoSealed();
    expect(seal.sealed).toBe(true);
    expect(seal.movedTo).toBeDefined();
    expect(await sessions().get(name).eventCount()).toBe(0);
  });
});

describe("router behavior while an import is in progress", () => {
  it("direct traffic blocks; the router waits for the migration and then serves the new side", async () => {
    const name = "p-midimport";
    await seed(name);
    await old(name).__claydoSeal();
    const raw = rawHost(`session:${name}`);
    const begin = await raw.__claydoBeginImport(
      "session",
      "crashed-driver",
      undefined,
      { maxRows: 1, maxBytes: 256 * 1024 },
    );
    if (!begin.ok) expect.unreachable("fresh import must be reserved");
    await old(name).__claydoSeal(
      undefined,
      undefined,
      `session:${name}`,
      begin.migrationId,
    );
    const first = await old(name).__claydoExport(undefined, null, { maxRows: 1 });
    await raw.__claydoImport("session", first, 1, "crashed-driver");

    const direct = await messageOf(sessions().get(name).history());
    expect(direct).toMatch(
      /is importing kind 'session'\. Traffic is blocked until the migration completes or is aborted/,
    );
    const response = await sessions().get(name).fetch("https://do/");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.text()).toMatch(/is importing kind 'session'/);

    await backdateImport(`session:${name}`);
    const facade = migrated(env.OLD_SESSIONS, sessions(), {
      strategy: "manual",
      oldRouteTtlMs: 0,
    });
    const [viaRouter, summary] = await Promise.all([
      facade.get(name).history(),
      migrateInstance({
        from: old(name),
        to: sessions(),
        name,
        maxRowsPerChunk: 1,
      }),
    ]);
    expect(summary.resumed).toBe(true);
    expect(viaRouter).toHaveLength(3);
    expect(await facade.get(name).eventCount()).toBe(3);
  });
});

describe("router fetch() with a stale cached old-route", () => {
  it("fetch() retries on the new side after the marked 410 (without stale 410s)", async () => {
    const name = "p-router-fetch";
    await seed(name);
    const facade = migrated(env.OLD_SESSIONS, sessions(), {
      strategy: "manual",
      oldRouteTtlMs: 60_000,
    });
    const primed = await facade.get(name).fetch("https://do/");
    expect(primed.status).toBe(200);
    expect(await primed.text()).toContain(`raw=${name} `);
    await migrateInstance({ from: old(name), to: sessions(), name });

    const response = await facade.get(name).fetch("https://do/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`raw=session:${name} `);

    expect(await facade.get(name).eventCount()).toBe(3);
  });
});

describe("traffic racing a migration of the same name", () => {
  it("a pre-reservation read can still pollute the target, but the driver refuses recoverably and wipeTarget() unbricks it", async () => {
    const name = "p-traffic";
    await seed(name);
    const [migration, traffic] = await Promise.allSettled([
      migrateInstance({
        from: old(name),
        to: sessions(),
        name,
        maxRowsPerChunk: 1,
      }),
      sessions().get(name).history(),
    ]);

    expect(traffic.status).toBe("fulfilled");
    expect((traffic as PromiseFulfilledResult<unknown>).value).toStrictEqual([]);

    expect(migration.status).toBe("rejected");
    const reason = (migration as PromiseRejectedResult).reason as Error;
    expect(reason.message).toMatch(
      /is live as kind 'session'\. Imports only target untouched instances/,
    );
    expect(reason.message).not.toMatch(/rolled back/);
    expect((await old(name).__claydoSealed()).sealed).toBe(false);
    expect(await old(name).eventCount()).toBe(3);

    const rerun = await messageOf(
      migrateInstance({ from: old(name), to: sessions(), name }),
    );
    expect(rerun).toBe(
      "claydo: both the old instance 'p-traffic' and the new instance " +
        "'session:p-traffic' are live. Refusing to migrate. If racing " +
        "traffic polluted the new instance (it has no real data), wipe it " +
        "with wipeTarget() from claydo/migrate and re-run. If the new " +
        "instance is the source of truth, seal the old one with " +
        "__claydoSeal() — its data will NOT be copied.",
    );

    await wipeTarget(sessions(), name);
    const summary = await migrateInstance({
      from: old(name),
      to: sessions(),
      name,
    });
    expect(summary.skipped).toBe(false);
    expect(summary.rows["events"]).toBe(3);
    expect(await sessions().get(name).history()).toHaveLength(3);
    expect(await sessions().get(name).listPrefs()).toStrictEqual({
      color: "blue",
      lang: "de",
    });
    const seal = await old(name).__claydoSealed();
    expect(seal.sealed).toBe(true);
    expect(seal.movedTo).toBe(`session:${name}`);
  });
});
