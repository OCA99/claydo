/**
 * The happy path at fleet scale: seed ~10 old-binding instances, serve them
 * through the `manual` transitional router, migrate the whole fleet with
 * `migrateInstance` in a loop, verify every instance's data exactly, then
 * assert the cutover state (old sealed everywhere, new live everywhere) and
 * fleet-scale idempotency.
 *
 * Tests in this file run in order and share Durable Object storage (the
 * vitest pool isolates per FILE, not per test).
 */
import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kinds } from "../../../src/index";
import {
  migrated,
  migrateInstance,
  SEALED_HEADER,
  type MigrationSummary,
} from "../../../src/migrate";
import type { SessionEvent } from "../worker";

const sessions = () => kinds(env.APP_DO).session;

function old(name: string) {
  return env.OLD_SESSIONS.get(env.OLD_SESSIONS.idFromName(name));
}

function router() {
  return migrated(env.OLD_SESSIONS, sessions(), {
    strategy: "manual",
    oldRouteTtlMs: 0,
  });
}

/**
 * The name registry, simulated as a plain list. A real app would keep this
 * in a driver-side store it already owns (a D1/SQLite table, a KV list, or
 * one claydo "registry" instance), because Cloudflare cannot enumerate the
 * names of a namespace.
 */
const FLEET = Array.from({ length: 10 }, (_, i) => `sess-${String(i).padStart(2, "0")}`);

/** Deterministic per-instance shape so every fleet member differs. */
function shapeOf(index: number) {
  return {
    events: 3 + index, // 3..12 events
    tags: index % 3, // 0..2 tags
    prefs: 1 + (index % 2), // 1..2 prefs
  };
}

// Snapshots taken from the OLD side before migration, compared byte-for-byte
// (deep equality on every column of every row) after migration.
const snapshots = new Map<
  string,
  { history: SessionEvent[]; tags: string[]; prefs: Record<string, string> }
>();

const summaries = new Map<string, MigrationSummary>();

/**
 * Awaits a promise and returns its rejection message. Used instead of
 * `expect(...).rejects` for calls on the raw OLD stub: seal-guard rejections
 * arrive as native RPC rejections, and `expect().rejects` on those leaves an
 * unhandled rejection behind that fails the whole vitest run (see
 * DX-REPORT.md issue 3; the repo now ships the same pattern as
 * `expectRejects` in test/migrate.test.ts).
 */
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "<resolved without error>";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("fleet migration: OLD_SESSIONS -> kind 'session'", () => {
  it("seeds the fleet on the old binding and snapshots it", async () => {
    for (const [index, name] of FLEET.entries()) {
      const shape = shapeOf(index);
      const stub = old(name);
      for (let e = 0; e < shape.events; e++) {
        await stub.record(e % 2 === 0 ? "click" : "view", `payload-${name}-${e}`);
      }
      for (let t = 0; t < shape.tags; t++) await stub.addTag(`tag-${t}`);
      for (let p = 0; p < shape.prefs; p++) {
        await stub.setPref(`k${p}`, `${name}-v${p}`);
      }
      snapshots.set(name, {
        history: await stub.history(),
        tags: await stub.listTags(),
        prefs: await stub.listPrefs(),
      });
      expect(snapshots.get(name)!.history).toHaveLength(shape.events);
    }
  });

  it("manual router serves the OLD side before any migration", async () => {
    const facade = router();
    const name = FLEET[3]!;
    expect(await facade.get(name).eventCount()).toBe(shapeOf(3).events);
    // Manual routing must not have migrated anything.
    expect((await old(name).__claydoSealed()).sealed).toBe(false);
    // The worker-level route (also manual) hits the old instance: the raw
    // Durable Object name has no kind prefix.
    const response = await SELF.fetch(`https://example.com/session/${name}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`raw=${name} `);
  });

  it("migrates the whole fleet with migrateInstance in a loop", async () => {
    for (const name of FLEET) {
      const summary = await migrateInstance({
        from: old(name),
        to: sessions(),
        name,
      });
      summaries.set(name, summary);
    }
    for (const [index, name] of FLEET.entries()) {
      const shape = shapeOf(index);
      const summary = summaries.get(name)!;
      expect(summary.skipped).toBe(false);
      expect(summary.resumed).toBe(false);
      expect(summary.rows["events"]).toBe(shape.events);
      // Zero-row tables are omitted from summary.rows (see DX-REPORT.md):
      // instances with no tags report no 'tags' key at all.
      expect(summary.rows["tags"] ?? 0).toBe(shape.tags);
      expect(summary.kv).toBe(shape.prefs);
      expect(summary.chunks).toBeGreaterThanOrEqual(1);
    }
  });

  it("preserves every instance's data byte-for-byte", async () => {
    for (const name of FLEET) {
      const snapshot = snapshots.get(name)!;
      const moved = sessions().get(name);
      // Full-fidelity comparison: every row, every column, including the
      // AUTOINCREMENT ids and the original timestamps.
      expect(await moved.history()).toStrictEqual(snapshot.history);
      expect(await moved.listTags()).toStrictEqual(snapshot.tags);
      expect(await moved.listPrefs()).toStrictEqual(snapshot.prefs);
    }
    // Spot checks with independent accessors.
    expect(await sessions().get("sess-04").getPref("k0")).toBe("sess-04-v0");
    expect(await sessions().get("sess-09").eventCount()).toBe(12);
  });

  it("continues the AUTOINCREMENT sequence on the new side", async () => {
    const name = FLEET[5]!;
    const before = snapshots.get(name)!.history;
    const lastId = before[before.length - 1]!.id;
    const newId = await sessions().get(name).record("post-migration", "x");
    expect(newId).toBe(lastId + 1);
  });

  it("cutover: every old instance is sealed, every new instance is live", async () => {
    for (const name of FLEET) {
      // Old RPC fails with the seal error, and names where traffic moved
      // (the move marker is recorded on the old side after success).
      const message = await messageOf(old(name).record("late", "write"));
      expect(message).toMatch(/is sealed/);
      expect(message).toMatch(/moved to Durable Object id/);
      const seal = await old(name).__claydoSealed();
      expect(seal.movedTo).toBe(sessions().get(name).id.toString());
      // Old fetch answers 410 Gone with the machine-readable sealed header
      // and a generic body (bodies no longer leak the instance identity).
      const gone = await old(name).fetch("https://do/");
      expect(gone.status).toBe(410);
      expect(gone.headers.get(SEALED_HEADER)).toBe("1");
      expect(await gone.text()).toBe(
        "claydo: this instance is sealed (migrating or migrated). Reconnect through the current endpoint.",
      );
      // New side serves reads and writes.
      expect(await sessions().get(name).eventCount()).toBeGreaterThan(0);
    }
  });

  it("manual router serves the NEW side after migration", async () => {
    const facade = router();
    const name = FLEET[2]!;
    expect(await facade.get(name).listPrefs()).toStrictEqual(
      snapshots.get(name)!.prefs,
    );
    // The worker-level route now lands on the kind instance (prefixed name).
    const response = await SELF.fetch(`https://example.com/session/${name}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`raw=session:${name} `);
  });

  it("re-running the whole fleet migration skips every instance", async () => {
    for (const name of FLEET) {
      const again = await migrateInstance({
        from: old(name),
        to: sessions(),
        name,
      });
      expect(again).toStrictEqual({
        skipped: true,
        reason: "already migrated",
        resumed: false,
        chunks: 0,
        kv: 0,
        rows: {},
        alarm: undefined,
      });
    }
    // And no data was duplicated by the re-run.
    for (const [index, name] of FLEET.entries()) {
      expect(await sessions().get(name).eventCount()).toBeGreaterThanOrEqual(
        shapeOf(index).events,
      );
      expect(await sessions().get(name).listTags()).toStrictEqual(
        snapshots.get(name)!.tags,
      );
    }
  });
});

describe("summary truthfulness", () => {
  it("reports exact rows per table, kv count, chunk count, and the alarm", async () => {
    const name = "sum-1";
    const stub = old(name);
    for (let e = 0; e < 5; e++) await stub.record("click", `p${e}`);
    for (let t = 0; t < 3; t++) await stub.addTag(`t${t}`);
    for (let p = 0; p < 3; p++) await stub.setPref(`k${p}`, `v${p}`);
    const alarmAt = Date.now() + 60_000;
    await stub.remindAt(alarmAt);

    const summary = await migrateInstance({
      from: stub,
      to: sessions(),
      name,
      maxRowsPerChunk: 2,
    });

    expect(summary.skipped).toBe(false);
    expect(summary.reason).toBeUndefined();
    expect(summary.rows).toStrictEqual({ events: 5, tags: 3 });
    expect(summary.kv).toBe(3);
    expect(summary.alarm).toBe(alarmAt);
    // Chunk arithmetic with maxRows 2: chunk 1 = DDL + the single KV page
    // (3 entries); chunks 2-4 = events pages (2, 2, 1); chunks 5-6 = tags
    // pages (2, 1); chunk 7 = final (post DDL, sequences, alarm, totals).
    expect(summary.chunks).toBe(7);

    // The old instance's alarm was deleted when the move was recorded.
    expect(await runDurableObjectAlarm(old(name))).toBe(false);
    // The alarm was re-armed on the new instance and fires the kind's alarm().
    const ran = await runDurableObjectAlarm(
      env.APP_DO.get(env.APP_DO.idFromName(`session:${name}`)),
    );
    expect(ran).toBe(true);
    expect(await sessions().get(name).alarmFiredAt()).toBeDefined();
  });
});
