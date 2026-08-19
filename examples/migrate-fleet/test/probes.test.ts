/**
 * Adversarial probes against claydo/migrate: crash-resume, torn snapshots,
 * duplicate concurrent drivers, secrets, import gating, wrong-kind targets,
 * ghost instances, and traffic racing a migration.
 *
 * Each probe asserts the OBSERVED behavior so the suite stays green; the
 * judgments live in DX-REPORT.md.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kinds } from "../../../src/index";
import { migrated, migrateInstance } from "../../../src/migrate";

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

describe("crash and resume", () => {
  it("resumes from the last applied chunk after a driver crash", async () => {
    const name = "p-resume";
    await seed(name);
    const before = await old(name).history();
    // Simulate a crashed driver: seal, transfer exactly one chunk, stop.
    await old(name).__claydoSeal();
    const first = await old(name).__claydoExport(undefined, null, { maxRows: 1 });
    const raw = sessions().get(name).stub as any;
    await raw.__claydoImport("session", first, 1);

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
  });

  it("restarts from scratch when the old instance was unsealed mid-crash (torn snapshot)", async () => {
    const name = "p-torn";
    await seed(name);
    await old(name).__claydoSeal();
    const first = await old(name).__claydoExport(undefined, null, { maxRows: 1 });
    const raw = sessions().get(name).stub as any;
    await raw.__claydoImport("session", first, 1);

    // An operator unseals the old instance and traffic mutates it. The
    // partial import on the target is now a torn snapshot.
    await old(name).__claydoUnseal();
    await old(name).record("post-crash", "mutation");
    await old(name).setPref("color", "red"); // overwrite a kv already copied

    const summary = await migrateInstance({
      from: old(name),
      to: sessions(),
      name,
      maxRowsPerChunk: 1,
    });
    // The driver must NOT resume the torn snapshot.
    expect(summary.resumed).toBe(false);
    expect(summary.skipped).toBe(false);
    expect(summary.rows["events"]).toBe(4);

    const moved = sessions().get(name);
    const history = await moved.history();
    expect(history).toHaveLength(4);
    expect(history[3]!.type).toBe("post-crash");
    // The stale copied value from the torn chunk must not survive.
    expect(await moved.getPref("color")).toBe("red");
    expect(await moved.listPrefs()).toStrictEqual({ color: "red", lang: "de" });
  });
});

describe("duplicate concurrent drivers for the same instance", () => {
  it("one driver wins with correct data, but the loser's rollback unseals the old instance (split-brain)", async () => {
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

    // Exactly one driver wins; per-chunk seq dedup keeps the data correct.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as Error).message).toMatch(
      /failed and was rolled back \(old instance unsealed\)/,
    );
    expect((rejected[0]!.reason as Error).message).toMatch(
      /is already live as kind 'session'\. Imports only target untouched instances/,
    );

    // The new instance holds correct, non-duplicated data.
    expect(await sessions().get(name).eventCount()).toBe(3);
    expect(await sessions().get(name).listPrefs()).toStrictEqual({
      color: "blue",
      lang: "de",
    });

    // THE BUG (see DX-REPORT.md): the losing driver's rollback unsealed the
    // old instance even though the migration actually completed. Both sides
    // are now live, and a re-run refuses instead of skipping.
    expect((await old(name).__claydoSealed()).sealed).toBe(false);
    const rerun = await messageOf(
      migrateInstance({ from: old(name), to: sessions(), name }),
    );
    expect(rerun).toMatch(
      /both the old instance 'p-race' and the new instance 'session:p-race' are live\. Refusing to migrate/,
    );

    // Manual remediation (safe here because old data equals new data):
    // re-seal the old instance by hand, after which re-runs skip again.
    await old(name).__claydoSeal();
    const fixed = await migrateInstance({ from: old(name), to: sessions(), name });
    expect(fixed.skipped).toBe(true);
  });
});

describe("secrets", () => {
  it("rejects a driver without a secret when both sides require one", async () => {
    const name = "sec-none";
    await seed(name, oldSecure(name));
    const message = await messageOf(
      migrateInstance({ from: oldSecure(name), to: secureSessions(), name }),
    );
    expect(message).toBe("claydo: invalid migration secret.");
    // Nothing happened: the old instance is untouched and unsealed.
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
    expect(message).toBe("claydo: invalid migration secret.");
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
    // OLD_SECURE requires "s1"; APP_DO has no secret configured.
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
    expect(message).toBe("claydo: invalid migration secret.");
    // The old instance still serves traffic.
    expect(await oldSecure(name).eventCount()).toBe(3);
  });

  it("secret on the HOST side only: rejected without it, accepted with it", async () => {
    const name = "sec-host-only";
    await seed(name);
    const message = await messageOf(
      migrateInstance({ from: old(name), to: secureSessions(), name }),
    );
    expect(message).toBe("claydo: invalid migration secret.");
    // The old side has no secret configured, so it accepts any value.
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
  it("refuses to import into a kind that is not importable, and rolls back", async () => {
    const name = "p-gate";
    await seed(name);
    const message = await messageOf(
      migrateInstance({
        from: old(name),
        to: kinds(env.APP_DO).audit,
        name,
      }),
    );
    expect(message).toMatch(/imports are not enabled for kind 'audit'/);
    expect(message).toMatch(/Pass \{ importable: true \} or \{ importable: \["audit"\] \} to union\(\)/);
    expect(message).toMatch(/rolled back \(old instance unsealed\)/);
    // Rollback proof: the old instance is unsealed and serves writes again.
    expect((await old(name).__claydoSealed()).sealed).toBe(false);
    expect(await old(name).record("after-rollback", "x")).toBe(4);
  });

  it("refuses an import whose declared kind contradicts the target name prefix", async () => {
    const name = "p-name";
    await seed(name);
    await old(name).__claydoSeal();
    const chunk = await old(name).__claydoExport(undefined, null);
    // Hand-deliver a 'session' import into an instance named 'audit:mismatch'.
    const target = rawHost("audit:mismatch");
    const message = await messageOf(
      target.__claydoImport("session", chunk, 1),
    );
    expect(message).toMatch(
      /the target name 'audit:mismatch' implies kind 'audit', but the import declares kind 'session'/,
    );
    await old(name).__claydoUnseal();
  });
});

describe("ghost instances (never existed, no data)", () => {
  it("fabricates an empty instance instead of skipping (see DX-REPORT.md)", async () => {
    const name = "p-ghost";
    const summary = await migrateInstance({
      from: old(name),
      to: sessions(),
      name,
    });
    // Observed behavior: the migration "succeeds" with skipped:false. It
    // materializes the never-existing old instance (the constructor's
    // CREATE TABLEs run), seals it forever, copies the empty schema, and
    // pins the kind on an empty new instance.
    expect(summary).toStrictEqual({
      skipped: false,
      resumed: false,
      chunks: 1,
      kv: 0,
      // Zero-row tables are omitted, so `rows` is indistinguishable from
      // "nothing was copied".
      rows: {},
      alarm: null,
    });
    const seal = await old(name).__claydoSealed();
    expect(seal.sealed).toBe(true);
    expect(seal.movedTo).toBeDefined();
    expect(await sessions().get(name).eventCount()).toBe(0);
  });
});

describe("router behavior while an import is in progress", () => {
  it("routes to the new side and surfaces the import-blocked error", async () => {
    const name = "p-midimport";
    await seed(name);
    await old(name).__claydoSeal();
    const first = await old(name).__claydoExport(undefined, null, { maxRows: 1 });
    const raw = sessions().get(name).stub as any;
    await raw.__claydoImport("session", first, 1);

    // The router sees the old side sealed and routes "new", but the new
    // side blocks traffic mid-import. Callers get an error, not a wait.
    const facade = migrated(env.OLD_SESSIONS, sessions(), {
      strategy: "manual",
      oldRouteTtlMs: 0,
    });
    const viaRouter = await messageOf(facade.get(name).history());
    expect(viaRouter).toMatch(
      /is importing kind 'session'\. Traffic is blocked until the migration completes or is aborted/,
    );
    // Direct kind access fails the same way; fetch() answers 400.
    const direct = await messageOf(sessions().get(name).history());
    expect(direct).toMatch(/is importing kind 'session'/);
    const response = await sessions().get(name).fetch("https://do/");
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/is importing kind 'session'/);

    // Finish the migration; the router then serves the new side.
    const summary = await migrateInstance({
      from: old(name),
      to: sessions(),
      name,
      maxRowsPerChunk: 1,
    });
    expect(summary.resumed).toBe(true);
    expect(await facade.get(name).eventCount()).toBe(3);
  });
});

describe("router fetch() with a stale cached old-route", () => {
  it("RPC retries on the new side, but fetch() returns the old 410 to the caller", async () => {
    const name = "p-router-fetch";
    await seed(name);
    const facade = migrated(env.OLD_SESSIONS, sessions(), {
      strategy: "manual",
      oldRouteTtlMs: 60_000,
    });
    // Prime the cache with an "old" route.
    expect(await facade.get(name).eventCount()).toBe(3);
    // An external driver migrates while the route is cached.
    await migrateInstance({ from: old(name), to: sessions(), name });

    // fetch() through the router: no seal-retry, the caller gets a 410 whose
    // body tells them to "route traffic through the claydo binding" — which
    // is exactly what they are doing.
    const response = await facade.get(name).fetch("https://do/");
    expect(response.status).toBe(410);
    expect(await response.text()).toMatch(
      /is sealed\. It moved to Durable Object id .*; route traffic through the claydo binding\./,
    );

    // The RPC path on the same facade heals the route (seal-retry), after
    // which fetch() works again.
    expect(await facade.get(name).eventCount()).toBe(3);
    const healed = await facade.get(name).fetch("https://do/");
    expect(healed.status).toBe(200);
    expect(await healed.text()).toContain(`raw=session:${name} `);
  });
});

describe("traffic racing a migration of the same name", () => {
  it("traffic pins an EMPTY instance, the migration bricks, and there is no recovery path", async () => {
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

    // The plain-accessor read wins the race: it initializes the target and
    // answers with an EMPTY history — a silently wrong answer for a session
    // that has 3 events on the old side.
    expect(traffic.status).toBe("fulfilled");
    expect((traffic as PromiseFulfilledResult<unknown>).value).toStrictEqual([]);

    // The migration loses and rolls back (old side stays usable — good).
    expect(migration.status).toBe("rejected");
    const reason = (migration as PromiseRejectedResult).reason as Error;
    expect(reason.message).toMatch(
      /is live as kind 'session'\. Imports only target untouched instances/,
    );
    expect((await old(name).__claydoSealed()).sealed).toBe(false);
    expect(await old(name).eventCount()).toBe(3);

    // But now the instance is BRICKED: the new side is pinned and empty, so
    // every re-run refuses. The message's first suggestion ("seal the old
    // one") would silently destroy all 3 events here.
    const rerun = await messageOf(
      migrateInstance({ from: old(name), to: sessions(), name }),
    );
    expect(rerun).toMatch(
      /both the old instance 'p-traffic' and the new instance 'session:p-traffic' are live\. Refusing to migrate\. If the new instance is the source of truth, seal the old one; otherwise wipe the new instance before migrating\./,
    );

    // "Wipe the new instance": there is no public API for that. Even the
    // test-only escape hatch (deleteAll inside the DO) does not help,
    // because the host caches the kind and the live impl in memory — only
    // eviction or ctx.abort() would clear it.
    const rawStub = env.APP_DO.get(env.APP_DO.idFromName(`session:${name}`));
    await runInDurableObject(rawStub, async (_instance, state) => {
      await state.storage.deleteAll();
    });
    const afterWipe = await messageOf(
      migrateInstance({ from: old(name), to: sessions(), name }),
    );
    expect(afterWipe).toMatch(/both the old instance .* are live/);
  });
});
