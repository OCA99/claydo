/**
 * Adversarial probes against claydo/migrate, run on the GameCo worker:
 *
 *  A. exportable() vs partyserver's synchronous helpers (pre-seal behavior).
 *  B. The seal window: a facade read between seal and first import chunk.
 *  C. Wrong-shape migration: a room's data imported into the match kind.
 *  D. A rowid-alias column that is not the first declared column.
 *  E. Tiny chunks while spamming facade reads.
 *  F. A WebSocket message racing the migration (Promise.all).
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kinds } from "../../../src/index";
import { migrateInstance, migrated } from "../../../src/migrate";

const app = () => kinds(env.APP_DO);

function oldRoom(name: string) {
  return env.OLD_ROOMS.get(env.OLD_ROOMS.idFromName(name));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("A. exportable() wrapper vs partyserver sync helpers", () => {
  it("connectionCount() works as a kind but explodes under exportable() — before any seal", async () => {
    // As a claydo kind: fine.
    expect(await app().room.get("sync-probe").connectionCount()).toBe(0);

    // On the old binding, the same class wrapped with exportable(): the
    // seal guard replaced getConnections() with an async wrapper, so the
    // for..of inside connectionCount() iterates a Promise.
    const old = oldRoom("sync-probe-old");
    await old.post("system", "hello"); // instance is alive and NOT sealed
    await expect(old.connectionCount()).rejects.toThrow(/is not iterable|Symbol\.iterator/);
  });
});

describe("B. the seal window: read-through-facade between seal and first chunk", () => {
  it("a facade read on a sealed-but-not-yet-imported room initializes an empty instance and wedges the migration", async () => {
    const NAME = "race-window";
    const old = oldRoom(NAME);
    await old.post("system", "message one");
    await old.post("system", "message two");

    // The driver crashes right after sealing (or a reader simply wins the
    // race between __claydoSeal() and the first __claydoImport()).
    await old.__claydoSeal();

    const facade = migrated(env.OLD_ROOMS, app().room, { strategy: "manual" });

    // The facade sees "old is sealed" and routes to the new side — which
    // has no data yet. get() initializes it, pinning the kind on an EMPTY
    // instance. The reader is served an empty history.
    expect(await facade.get(NAME).history()).toEqual([]);

    // Observed: the driver now reports SUCCESS. Target-has-kind plus
    // old-is-sealed is indistinguishable from a completed migration, so
    // migrateInstance() returns { skipped: true }. Two messages are
    // silently stranded behind the seal — the worst possible outcome.
    const summary = await migrateInstance({
      from: old,
      to: app().room,
      name: NAME,
    });
    expect(summary).toMatchObject({ skipped: true, chunks: 0, rows: {} });

    // Every caller now sees an empty room; the old data is unreachable
    // (the old instance stays sealed and rejects all traffic).
    expect(await facade.get(NAME).history()).toEqual([]);
    expect(await old.__claydoSealed()).toMatchObject({ sealed: true });
    await expect(old.history()).rejects.toThrow(/is sealed/);

    // Remediation is entirely on the user, with no library API. Wiping the
    // new instance's storage is NOT enough: the host keeps the kind pinned
    // in memory, and the driver still reports "nothing to do".
    await runInDurableObject(
      env.APP_DO.get(env.APP_DO.idFromName(`room:${NAME}`)),
      async (instance) =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.deleteAll(),
    );
    const afterWipe = await migrateInstance({
      from: old,
      to: app().room,
      name: NAME,
    });
    expect(afterWipe.skipped).toBe(true); // still lying

    // Only after the instance is ALSO evicted from memory (ctx.abort())
    // does the migration finally run.
    await runInDurableObject(
      env.APP_DO.get(env.APP_DO.idFromName(`room:${NAME}`)),
      async (instance) =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.abort(),
    ).catch(() => {
      // abort() intentionally kills the call.
    });
    const rerun = await migrateInstance({
      from: old,
      to: app().room,
      name: NAME,
    });
    expect(rerun.skipped).toBe(false);
    expect(rerun.rows["messages"]).toBe(2);
    expect((await app().room.get(NAME).history()).length).toBe(2);
  });
});

describe("C. wrong-shape migration: binding A's instance into binding B's kind", () => {
  it("migrating a partyserver room into the match kind succeeds silently and serves nonsense", async () => {
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
    // (kv is 0 here: partyserver only persists its __ps_name record once a
    // fetch/WebSocket/alarm entry point ran; this room was only seeded over
    // RPC. The journey test's "lobby" DID carry __ps_name across.)
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
    const strandedRows = await runInDurableObject(
      env.APP_DO.get(env.APP_DO.idFromName("match:wrong-shape")),
      async (instance) =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql
          .exec<{ n: number }>(`SELECT count(*) AS n FROM messages`)
          .one().n,
    );
    expect(strandedRows).toBe(2);
  });

  it("the only guard is name-prefix vs declared-kind, which this footgun never trips", async () => {
    // For completeness: importing under a name whose prefix implies another
    // kind IS caught (target name "room:x" vs declared kind "match")...
    const old = oldRoom("oops2");
    await old.post("system", "hi");
    const target = app().room.get("prefix-guard");
    const raw = target.stub as unknown as {
      __claydoImport(kind: string, chunk: unknown, seq: number): Promise<unknown>;
    };
    await old.__claydoSeal();
    const chunk = await old.__claydoExport(undefined, null);
    await expect(raw.__claydoImport("match", chunk, 1)).rejects.toThrow(
      /the target name 'room:prefix-guard' implies kind 'room', but the import declares kind 'match'/,
    );
    await old.__claydoUnseal();
  });
});

describe("D. rowid-alias column that is not the first column", () => {
  it("cannot migrate: the importer misaligns columns and the run rolls back with a bare SQLite error", async () => {
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

    // Observed: the importer builds INSERT columns as
    // ["rowid", ...columns.slice(1)], which assumes the rowid alias is the
    // FIRST column. Here it is not, so the first data column ("at") is
    // dropped from the column list and the insert fails its NOT NULL
    // constraint. The error says nothing about the real cause.
    await expect(
      migrateInstance({ from: old, to: app().match, name: "alias-probe" }),
    ).rejects.toThrow(
      /migration of 'alias-probe' to kind 'match' failed and was rolled back \(old instance unsealed\): NOT NULL constraint failed: turn_log\.at/,
    );

    // The rollback held: the old instance serves its data again.
    expect(await old.turnLog()).toEqual(before);
    expect(await old.__claydoSealed()).toMatchObject({ sealed: false });
  });
});

describe("E. tiny chunks while spamming facade reads", () => {
  it("readers during the copy fail loudly; nobody ever sees partial data", async () => {
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
    // Prime one read on the old side before the driver starts.
    expect((await facade.get(NAME).history()).length).toBe(TOTAL);

    const migration = migrateInstance({
      from: old,
      to: app().room,
      name: NAME,
      maxRowsPerChunk: 1,
      maxBytesPerChunk: 64,
    }).then(
      (summary) => ({ summary, error: undefined }),
      (error: Error) => ({ summary: undefined, error }),
    );

    const outcomes: { len?: number; error?: string }[] = [];
    for (let i = 0; i < 12; i++) {
      try {
        const rows = await facade.get(NAME).history();
        outcomes.push({ len: rows.length });
      } catch (error) {
        outcomes.push({ error: (error as Error).message });
      }
      await sleep(5);
    }
    const result = await migration;

    // Invariant: no reader ever observes a partial copy. Every successful
    // read is the full old data, the full new data, or (the seal-window
    // bug from suite B) a freshly-initialized EMPTY instance.
    for (const outcome of outcomes) {
      if (outcome.len !== undefined) {
        expect([0, TOTAL]).toContain(outcome.len);
      } else {
        expect(outcome.error).toMatch(
          /is importing kind 'room'|is sealed|are live/,
        );
      }
    }

    // Record how the race ended. Both endings have been observed; assert
    // the system settles into a state we can name, and that when the
    // migration did succeed the data is complete.
    if (result.summary !== undefined) {
      expect(result.summary.rows["messages"]).toBe(TOTAL);
      expect((await app().room.get(NAME).history()).length).toBe(TOTAL);
    } else {
      // A reader won the seal window and wedged the migration (suite B).
      expect(result.error!.message).toMatch(
        /is live as kind 'room'|failed and was rolled back/,
      );
    }
  });
});

describe("F. a WebSocket message racing the migration", () => {
  it("the message either lands before the seal (and migrates) or vanishes; the copy stays consistent", async () => {
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
    ws.addEventListener("message", () => {
      echoed += 1;
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
    ws.close(1000, "done");
  });
});
