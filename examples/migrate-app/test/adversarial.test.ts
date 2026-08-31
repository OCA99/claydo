/**
 * Adversarial probes against claydo/migrate, run on the GameCo worker —
 * updated for the hardened module. Each suite notes what changed since the
 * original audit (see DX-REPORT.md sections 3 and 6):
 *
 *  A. exportable() vs partyserver's synchronous helpers  → FIXED (sync guards)
 *  B. The seal window / polluted targets                  → FIXED (reserve-first
 *     + wipeTarget), with one residual manual-seal corner probed explicitly.
 *  C. Wrong-shape migration                               → unchanged by design
 *  D. Rowid-alias column not in first position            → FIXED (byte-exact)
 *  E. Tiny chunks while spamming facade reads             → FIXED (reads wait)
 *  F. A WebSocket message racing the migration            → improved (1012 close)
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kinds } from "../../../src/index";
import { migrateInstance, migrated, wipeTarget } from "../../../src/migrate";

const app = () => kinds(env.APP_DO);

function oldRoom(name: string) {
  return env.OLD_ROOMS.get(env.OLD_ROOMS.idFromName(name));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe("A. exportable() wrapper vs partyserver sync helpers (fixed: sync guards)", () => {
  it("getConnections() iteration works under the mixin while unsealed; sealed guards still throw", async () => {
    // As a claydo kind: fine (was already fine).
    expect(await app().room.get("sync-probe").connectionCount()).toBe(0);

    // On the old binding under exportable(): POST-FIX the guards are
    // synchronous, so partyserver's sync helpers work unchanged.
    // (Pre-fix this threw "TypeError: this.getConnections is not a function
    // or its return value is not iterable".)
    const old = oldRoom("sync-probe-old");
    await old.post("system", "hello");
    expect(await old.connectionCount()).toBe(0);

    // With a live hibernating WebSocket the count is real — the mixin does
    // not disturb partyserver's HibernatingConnectionIterator.
    const response = await old.fetch(
      "https://old.gameco/rooms/sync-probe-old?_pk=pat",
      { headers: { Upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    const closes: { code: number; reason: string }[] = [];
    ws.addEventListener("close", (event) => {
      closes.push({ code: event.code, reason: event.reason });
    });
    ws.accept();
    expect(await old.connectionCount()).toBe(1);

    // Sealing closes the live socket with 1012. The finished class's own
    // RPC entry points are sealed before execution, including
    // memory-only helpers and methods with constructor-captured storage.
    await old.__claydoSeal();
    await expectRejects(() => old.post("system", "frozen?"), /is sealed/);
    await expectRejects(() => old.connectionCount(), /is sealed/);
    const deadline = Date.now() + 2_000;
    while (closes.length === 0 && Date.now() < deadline) await sleep(50);
    expect(closes).toEqual([
      { code: 1012, reason: "claydo: instance migrating; reconnect" },
    ]);

    // Unseal: sync helpers work again; the seal-closed socket is gone.
    await old.__claydoUnseal();
    expect(await old.connectionCount()).toBe(0);
  });
});

describe("B. the seal window and polluted targets (fixed: reserve-first + wipeTarget)", () => {
  it("a reserved target blocks reads instead of initializing an empty instance", async () => {
    const NAME = "race-window";
    const old = oldRoom(NAME);
    await old.post("system", "message one");
    await old.post("system", "message two");

    // The driver reserves the target BEFORE touching the old instance.
    // Simulate exactly that moment with the raw host API:
    const raw = app().room.get(NAME).stub as unknown as {
      __claydoBeginImport(kind: string, token: string): Promise<unknown>;
      __claydoAbortImport(token: string): Promise<boolean>;
    };
    await raw.__claydoBeginImport("room", "audit-token");

    // POST-FIX: a read in this window can no longer pin an empty instance —
    // it blocks loudly. (Pre-fix: get() initialized an empty room and the
    // driver later reported { skipped: true } — silent data loss.)
    await expectRejects(
      () => app().room.get(NAME).history(),
      /is importing kind 'room'\. Traffic is blocked until the migration completes or is aborted/,
    );
    const blocked = await app().room.get(NAME).fetch("https://do/");
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("2");

    // The owner releases the reservation; a normal migration then succeeds
    // with every row intact.
    expect(await raw.__claydoAbortImport("audit-token")).toBe(true);
    const summary = await migrateInstance({
      from: old,
      to: app().room,
      name: NAME,
    });
    expect(summary.skipped).toBe(false);
    expect(summary.rows["messages"]).toBe(2);
    expect((await app().room.get(NAME).history()).length).toBe(2);
  });

  it("a target polluted BEFORE the migration makes the driver refuse loudly, and wipeTarget() recovers", async () => {
    const NAME = "polluted";
    const old = oldRoom(NAME);
    await old.post("system", "real data one");
    await old.post("system", "real data two");
    // Racing traffic touched the target name before any migration started.
    await app().room.get(NAME).post("intruder", "i live here now");

    // POST-FIX: no { skipped: true } lie — the driver refuses with a loud
    // error that names the recovery tool.
    await expectRejects(
      () => migrateInstance({ from: old, to: app().room, name: NAME }),
      /both the old instance 'polluted' and the new instance 'room:polluted' are live.*wipe it with wipeTarget\(\)/s,
    );
    // Nothing was sealed: the old instance still serves traffic.
    expect((await old.__claydoSealed()).sealed).toBe(false);

    // The advertised recovery path actually works (no ctx.abort() surgery:
    // wipeTarget clears storage, alarm, import state, AND the in-memory pin).
    await wipeTarget(app().room, NAME);
    const summary = await migrateInstance({
      from: old,
      to: app().room,
      name: NAME,
    });
    expect(summary.skipped).toBe(false);
    expect(summary.rows["messages"]).toBe(2);
    const history = await app().room.get(NAME).history();
    expect(history.map((m) => m.body)).toEqual([
      "real data one",
      "real data two",
    ]);
  });

  it("RESIDUAL: a manually sealed (never-reserved) old instance can still be shadowed by a reader", async () => {
    // The reserve-first driver closes ITS window, but __claydoSeal() is a
    // public API: if an operator seals by hand without reserving the
    // target, a facade read still initializes an empty instance and the
    // driver still reports success. Narrower than the original bug (the
    // driver can no longer create this state), but the corner exists.
    const NAME = "manual-seal-hole";
    const old = oldRoom(NAME);
    await old.post("system", "stranded one");
    await old.post("system", "stranded two");
    await old.__claydoSeal(); // by hand, no reservation

    const facade = migrated(env.OLD_ROOMS, app().room, { strategy: "manual" });
    expect(await facade.get(NAME).history()).toEqual([]); // empty pin

    const summary = await migrateInstance({
      from: old,
      to: app().room,
      name: NAME,
    });
    expect(summary).toMatchObject({ skipped: true, reason: "already migrated" });

    // Recovery at least exists now: wipe the shadow and re-run.
    await wipeTarget(app().room, NAME);
    const rerun = await migrateInstance({
      from: old,
      to: app().room,
      name: NAME,
    });
    expect(rerun.skipped).toBe(false);
    expect(rerun.rows["messages"]).toBe(2);
    expect(
      (await facade.get(NAME).history()).map((m) => m.body),
    ).toEqual(["stranded one", "stranded two"]);
  });
});

describe("C. wrong-shape migration: binding A's instance into binding B's kind (unchanged by design)", () => {
  it("migrating a partyserver room into the match kind still succeeds silently and serves nonsense", async () => {
    const old = oldRoom("oops");
    await old.post("system", "this is a chat room");
    await old.post("alice", "definitely not a match");

    // Nothing validates that the exported schema fits the target kind.
    const summary = await migrateInstance({
      from: old,
      to: app().match,
      name: "wrong-shape",
    });
    expect(summary.skipped).toBe(false);
    expect(summary.rows["messages"]).toBe(2); // chat rows, "successfully" imported
    expect(summary.kv).toBe(0);

    // The match kind now runs on top of chat-room data: no error, just
    // defaults. A production dashboard would show a ghost match.
    expect(await app().match.get("wrong-shape").state()).toEqual({
      players: [],
      status: "unknown",
      moves: 0,
      turnDeadline: null,
      timeoutFiredAt: null,
    });

    // The chat rows really are inside the match instance's database.
    expect(await app().match.get("wrong-shape").messageRows()).toBe(2);
  });

  it("the only guard is name-prefix vs declared-kind, now enforced at reservation time", async () => {
    const raw = app().room.get("prefix-guard").stub as unknown as {
      __claydoBeginImport(kind: string, token: string): Promise<unknown>;
    };
    await expectRejects(
      () => raw.__claydoBeginImport("match", "audit-token"),
      /the target name 'room:prefix-guard' implies kind 'room', but the import declares kind 'match'/,
    );
  });
});

describe("D. rowid-alias column that is not the first column (fixed)", () => {
  it("migrates byte-exact: the explicit rowid field carries the alias position", async () => {
    const id = env.OLD_MATCHES.newUniqueId();
    const old = env.OLD_MATCHES.get(id);
    await old.setup(["gina", "hank"]);
    await old.logTurn(1_000, "opening");
    await old.logTurn(2_000, "midgame");
    // turn_log columns: (at INTEGER, seq INTEGER PRIMARY KEY, note TEXT).
    const before = await old.turnLog();
    expect(before).toEqual([
      { at: 1_000, seq: 1, note: "opening" },
      { at: 2_000, seq: 2, note: "midgame" },
    ]);

    // Pre-fix this rolled back with a bare
    // "NOT NULL constraint failed: turn_log.at". POST-FIX the chunk carries
    // the rowid alias name, so the importer aligns columns correctly.
    const summary = await migrateInstance({
      from: old,
      to: app().match,
      name: "alias-probe",
    });
    expect(summary.skipped).toBe(false);
    expect(summary.rows["turn_log"]).toBe(2);
    // Empty tables ship no row chunks but are reported with a zero count.
    expect(summary.rows["moves"]).toBe(0);

    const moved = app().match.get("alias-probe");
    expect(await moved.turnLog()).toEqual(before);
    expect((await moved.state()).players).toEqual(["gina", "hank"]);
  });
});

describe("E. tiny chunks while spamming facade reads (fixed: readers wait, never see partial or empty)", () => {
  it("every read during the copy returns the complete data set; the migration always completes", async () => {
    const NAME = "busy";
    const TOTAL = 30;
    const old = oldRoom(NAME);
    for (let i = 0; i < TOTAL; i++) {
      await old.post("bot", `message-${i}`);
    }

    const facade = migrated(env.OLD_ROOMS, app().room, {
      strategy: "manual",
      oldRouteTtlMs: 0, // re-resolve on every read: worst case for the race
    });
    expect((await facade.get(NAME).history()).length).toBe(TOTAL);

    const migration = migrateInstance({
      from: old,
      to: app().room,
      name: NAME,
      maxRowsPerChunk: 1,
      maxBytesPerChunk: 64,
    });

    // Pre-fix: readers here could pin an empty instance (wedging the
    // migration) or fail with "is importing". POST-FIX: the facade waits
    // out an in-progress import and every read sees the full data set.
    const lengths: number[] = [];
    for (let i = 0; i < 12; i++) {
      const rows = await facade.get(NAME).history();
      lengths.push(rows.length);
      await sleep(5);
    }
    const summary = await migration;

    expect(lengths).toEqual(Array.from({ length: 12 }, () => TOTAL));
    expect(summary.skipped).toBe(false);
    expect(summary.rows["messages"]).toBe(TOTAL);
    expect((await app().room.get(NAME).history()).length).toBe(TOTAL);
    // The old side carries the move marker and is fully retired.
    expect(await old.__claydoSealed()).toEqual({
      sealed: true,
      movedTo: `room:${NAME}`,
    });
  });
});

describe("F. a WebSocket message racing the migration", () => {
  it("the message lands before the seal or vanishes; either way the socket gets a 1012 close and the copy is consistent", async () => {
    const NAME = "race-room";
    const old = oldRoom(NAME);
    await old.post("system", "round start");

    const response = await old.fetch(
      `https://old.gameco/rooms/${NAME}?_pk=ivy`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    let echoed = 0;
    const closes: { code: number; reason: string }[] = [];
    ws.addEventListener("message", () => {
      echoed += 1;
    });
    ws.addEventListener("close", (event) => {
      closes.push({ code: event.code, reason: event.reason });
    });
    ws.accept();

    const send = (async () => {
      ws.send("mid-flight message");
      await sleep(300); // give the broadcast a chance to come back
    })();
    const migration = migrateInstance({
      from: old,
      to: app().room,
      name: NAME,
    });
    const [, summary] = await Promise.all([send, migration]);

    expect(summary.skipped).toBe(false);
    const rows = summary.rows["messages"]!;
    expect([1, 2]).toContain(rows); // seed row, plus the racer iff it beat the seal

    // Whatever the exporter counted is exactly what the new side serves —
    // and the echo count matches whether the message made it.
    const history = await app().room.get(NAME).history();
    expect(history.length).toBe(rows);
    expect(echoed).toBe(rows - 1);

    // POST-FIX: the racer's socket is not silently dead — the seal closed
    // it with a reconnect signal.
    const deadline = Date.now() + 2_000;
    while (closes.length === 0 && Date.now() < deadline) await sleep(50);
    expect(closes).toEqual([
      { code: 1012, reason: "claydo: instance migrating; reconnect" },
    ]);
  });
});
