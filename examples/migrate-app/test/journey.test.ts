/**
 * The GameCo consolidation journey, end to end:
 *
 *  1. Seed both legacy bindings with realistic data.
 *  2. Migrate a room mid-WebSocket-session and observe the client's fate.
 *  3. Migrate every registry match (newUniqueId -> `migrated:<oldId>`).
 *  4. Alarm continuity for a pending turn timeout.
 *  5. Cutover rehearsal: plain accessors everywhere, facade retired.
 *
 * Storage is isolated per test FILE; the tests in this file share state and
 * run in order (each step builds on the previous one).
 */
import {
  env,
  SELF,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kinds } from "../../../src/index";
import { migrateInstance } from "../../../src/migrate";
import type { MatchState, RoomMessage } from "../worker";

const app = () => kinds(env.APP_DO);
const migratedName = (oldId: string) => `migrated:${oldId}`; // convention duplicated from worker.ts — the library offers no helper

function oldRoom(name: string) {
  return env.OLD_ROOMS.get(env.OLD_ROOMS.idFromName(name));
}

function oldMatch(id: string) {
  return env.OLD_MATCHES.get(env.OLD_MATCHES.idFromString(id));
}

// ---------------------------------------------------------------------------
// WebSocket probe helper (patterns copied from the repo's chat example).
// ---------------------------------------------------------------------------

interface SocketProbe {
  ws: WebSocket;
  /** Next JSON message, FIFO. Rejects after a timeout. */
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Messages received but not yet consumed by next(). */
  buffered(): number;
  closes: { code: number; reason: string; wasClean: boolean }[];
  errors: string[];
}

function attach(response: Response): SocketProbe {
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("101 response without a webSocket");
  const queue: string[] = [];
  const waiters: ((message: string) => void)[] = [];
  const closes: SocketProbe["closes"] = [];
  const errors: string[] = [];
  ws.addEventListener("message", (event) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(event.data as string);
    else queue.push(event.data as string);
  });
  ws.addEventListener("close", (event) => {
    closes.push({
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    });
  });
  ws.addEventListener("error", (event) => {
    errors.push(
      (event as ErrorEvent).message ?? (event as ErrorEvent).error ?? "error",
    );
  });
  ws.accept();
  return {
    ws,
    buffered: () => queue.length,
    closes,
    errors,
    next(timeoutMs = 2_000) {
      const head = queue.shift();
      if (head !== undefined) {
        return Promise.resolve(JSON.parse(head) as Record<string, unknown>);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for a WebSocket message")),
          timeoutMs,
        );
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(JSON.parse(message) as Record<string, unknown>);
        });
      });
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function wsViaWorker(path: string): Promise<Response> {
  return SELF.fetch(`https://gameco.example${path}`, {
    headers: { Upgrade: "websocket" },
  });
}

// Shared journey state (tests in this file run sequentially).
const ROOM = "lobby";
const matches: { oldId: string; players: string[] }[] = [];
let timeoutMatchId = "";
let timeoutDeadline = 0;

describe("GameCo consolidation journey", () => {
  // -------------------------------------------------------------------------
  // 1. Seeding
  // -------------------------------------------------------------------------

  it("1a. seeds the legacy room binding with history over RPC and WebSocket", async () => {
    const old = oldRoom(ROOM);
    expect(await old.post("system", "welcome to the lobby")).toBe(1);

    // A real client session against the OLD binding directly (pre-claydo).
    const alice = attach(
      await old.fetch(`https://old.gameco/rooms/${ROOM}?_pk=alice`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    alice.ws.send("gg wp");
    expect(await alice.next()).toEqual({
      room: ROOM, // partyserver this.name === the raw DO name on the old binding
      sender: "alice",
      body: "gg wp",
    });
    alice.ws.close(1000, "done seeding");

    const history = await old.history();
    expect(history.map((m) => m.body)).toEqual(["welcome to the lobby", "gg wp"]);
    expect(history.every((m) => m.room === ROOM)).toBe(true);
  });

  it("1b. seeds unique-id matches through the worker and plays some moves", async () => {
    for (const players of [
      ["alice", "bob"],
      ["carol", "dave"],
      ["erin", "frank"],
    ]) {
      const response = await SELF.fetch("https://gameco.example/admin/matches", {
        method: "POST",
        body: JSON.stringify({ players }),
      });
      expect(response.status).toBe(200);
      const { oldId } = await response.json<{ oldId: string }>();
      matches.push({ oldId, players });
    }

    // Play a move on each match through the /matches route (registry lookup
    // routes to the OLD binding, nothing is migrated yet).
    for (const match of matches) {
      const move = await SELF.fetch(
        `https://gameco.example/matches/${match.oldId}/move`,
        {
          method: "POST",
          body: JSON.stringify({ player: match.players[0], move: "e4" }),
        },
      );
      expect(await move.json()).toEqual({ moves: 1 });
    }

    const state = await SELF.fetch(
      `https://gameco.example/matches/${matches[0]!.oldId}/state`,
    );
    expect(await state.json<MatchState>()).toMatchObject({
      players: ["alice", "bob"],
      status: "active",
      moves: 1,
    });
  });

  it("1c. schedules a pending turn-timeout alarm on one old match", async () => {
    timeoutMatchId = matches[1]!.oldId;
    const response = await SELF.fetch(
      `https://gameco.example/matches/${timeoutMatchId}/schedule-timeout`,
      { method: "POST", body: JSON.stringify({ delayMs: 60_000 }) },
    );
    ({ deadline: timeoutDeadline } = await response.json<{
      deadline: number;
    }>());
    expect(timeoutDeadline).toBeGreaterThan(Date.now());
  });

  // -------------------------------------------------------------------------
  // 2. The live WebSocket disconnection story
  // -------------------------------------------------------------------------

  let liveSocket: SocketProbe;

  it("2a. a live session connects through the facade and lands on the old room", async () => {
    const alice = attach(await wsViaWorker(`/rooms/${ROOM}/ws?_pk=alice`));
    alice.ws.send("anyone up for a match?");
    expect(await alice.next()).toEqual({
      room: ROOM,
      sender: "alice",
      body: "anyone up for a match?",
    });
    // Keep the socket open across the migration in the next test.
    liveSocket = alice;
  });

  it("2b. migrating the room mid-session: the old socket goes silently dead", async () => {
    const summary = await migrateInstance({
      from: oldRoom(ROOM),
      to: app().room,
      name: ROOM,
    });
    expect(summary.skipped).toBe(false);
    expect(summary.rows["messages"]).toBe(3);

    // The client-side socket is still OPEN — nobody told the client anything.
    expect(liveSocket.ws.readyState).toBe(WebSocket.READY_STATE_OPEN);

    // A message sent on the old socket reaches the sealed instance, where
    // the seal guard throws inside webSocketMessage. Observe the client.
    liveSocket.ws.send("hello? is this thing on?");
    await sleep(1_000);
    expect(liveSocket.buffered()).toBe(0); // no broadcast, no error reply
    // Fate observed on first run: no close frame, no error event — the
    // socket looks healthy from the client and is silently dead.
    expect(liveSocket.closes).toEqual([]);
    expect(liveSocket.errors).toEqual([]);
    expect(liveSocket.ws.readyState).toBe(WebSocket.READY_STATE_OPEN);

    // The lost message is NOT in the migrated history.
    expect((await app().room.get(ROOM).history()).length).toBe(3);
  });

  it("2c. reconnecting through the facade immediately after migration is a 410, not a new session", async () => {
    // The worker's facade cached the "old" route for this room (ttl 60 s).
    // WebSocket reconnects go through the facade's fetch() path, which has
    // no seal-retry — the client gets a 410 with a claydo-internal message.
    const retry = await wsViaWorker(`/rooms/${ROOM}/ws?_pk=alice`);
    expect(retry.status).toBe(410);
    const text = await retry.text();
    expect(text).toMatch(/instance 'lobby' is sealed/);
    expect(text).toMatch(/moved to Durable Object id/);
  });

  it("2d. an RPC call through the facade heals the route; then reconnect works and history survived", async () => {
    // RPC calls DO have seal-retry: this call re-resolves to the new side
    // and pins the facade route to "new".
    const history = await SELF.fetch(
      `https://gameco.example/rooms/${ROOM}/history`,
    );
    expect(history.status).toBe(200);
    const rows = await history.json<RoomMessage[]>();
    expect(rows.map((m) => m.body)).toEqual([
      "welcome to the lobby",
      "gg wp",
      "anyone up for a match?",
    ]);

    // Now the same reconnect succeeds (the RPC healed the cached route).
    const alice = attach(await wsViaWorker(`/rooms/${ROOM}/ws?_pk=alice`));
    alice.ws.send("back online");
    // Note the client-visible change: the broadcast payload's room field is
    // now the prefixed host name.
    expect(await alice.next()).toEqual({
      room: "room:lobby",
      sender: "alice",
      body: "back online",
    });
    alice.ws.close(1000, "bye");

    const after = await app().room.get(ROOM).history();
    expect(after.length).toBe(4);
  });

  // -------------------------------------------------------------------------
  // 3. The partyserver `this.name` data-compat probe
  // -------------------------------------------------------------------------

  it("3a. history rows written before and after migration disagree on the room name", async () => {
    const rows = await app().room.get(ROOM).history();
    expect(rows.map((m) => m.room)).toEqual([
      "lobby",
      "lobby",
      "lobby",
      "room:lobby",
    ]);
    // The natural `WHERE room = this.name` query silently loses the entire
    // pre-migration history:
    const filtered = await app().room.get(ROOM).historyForThisRoom();
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.body).toBe("back online");
  });

  it("3b. identity probes: this.name changed, instanceName() gives the logical name, __ps_name was overwritten", async () => {
    const label = await app().room.get(ROOM).label();
    expect(label.doName).toBe("room:lobby");
    expect(label.logical).toBe("lobby");

    // partyserver persisted __ps_name: "lobby" on the OLD instance; the
    // migration copied it, and partyserver's init overwrote it with the
    // prefixed name on first contact.
    const psName = await runInDurableObject(
      env.APP_DO.get(env.APP_DO.idFromName("room:lobby")),
      async (instance) =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.get<string>(
          "__ps_name",
        ),
    );
    expect(psName).toBe("room:lobby");
  });

  // -------------------------------------------------------------------------
  // 4. Unique-id matches migrate to migrated:<oldId> names
  // -------------------------------------------------------------------------

  it("4a. migrates every registry match through the admin driver", async () => {
    for (const match of matches) {
      const response = await SELF.fetch(
        `https://gameco.example/admin/migrate-match/${match.oldId}`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      const summary = await response.json<{
        skipped: boolean;
        rows: Record<string, number>;
        kv: number;
      }>();
      expect(summary.skipped).toBe(false);
      expect(summary.rows["moves"]).toBe(1);
    }

    // Idempotency: the driver re-run is a no-op.
    const again = await SELF.fetch(
      `https://gameco.example/admin/migrate-match/${matches[0]!.oldId}`,
      { method: "POST" },
    );
    expect(await again.json<{ skipped: boolean }>()).toMatchObject({
      skipped: true,
    });

    const registry = await SELF.fetch("https://gameco.example/admin/registry");
    const listed = await registry.json<{ oldId: string; migrated: boolean }[]>();
    expect(listed.length).toBe(3);
    expect(listed.every((m) => m.migrated)).toBe(true);
  });

  it("4b. old id -> new name lookups work through the worker and directly", async () => {
    for (const match of matches) {
      // Through the worker's registry route:
      const viaWorker = await SELF.fetch(
        `https://gameco.example/matches/${match.oldId}/state`,
      );
      const state = await viaWorker.json<MatchState>();
      expect(state.players).toEqual(match.players);
      expect(state.moves).toBe(1);
      // Directly through the plain accessor with the documented name:
      const direct = await app()
        .match.get(migratedName(match.oldId))
        .state();
      expect(direct).toEqual(state);
    }
  });

  it("4c. the old unique-id string is useless against the new namespace", async () => {
    // The 'obvious' shortcut — fromId(oldId) on the new accessor — cannot
    // work: DO ids embed their namespace. Capture the actual failure.
    expect(() => app().match.fromId(matches[0]!.oldId)).toThrowError(
      /Durable Object ID is not valid for this namespace/,
    );
  });

  it("4d. the old sealed match rejects RPC; the documented 410 story needs a fetch() the class never had", async () => {
    const old = oldMatch(matches[0]!.oldId);
    await expect(old.state()).rejects.toThrow(/is sealed/);
    // MatchImpl never defined fetch(), and exportable() only wraps methods
    // that exist — so there is no sealed-410 response here, just a runtime
    // type error. (Rooms DO get the 410, see journey step 2c.)
    let message = "";
    try {
      await old.fetch("https://old.gameco/");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/does not define a `fetch\(\)` method/);
  });

  // -------------------------------------------------------------------------
  // 5. Alarm continuity
  // -------------------------------------------------------------------------

  it("5a. the pending turn-timeout alarm fires on the migrated instance", async () => {
    const raw = env.APP_DO.get(
      env.APP_DO.idFromName(`match:${migratedName(timeoutMatchId)}`),
    );
    expect(await runDurableObjectAlarm(raw)).toBe(true);
    const state = await app()
      .match.get(migratedName(timeoutMatchId))
      .state();
    expect(state.status).toBe("timed-out");
    expect(state.timeoutFiredAt).toBeGreaterThan(0);
    expect(state.turnDeadline).toBe(timeoutDeadline);
  });

  it("5b. the OLD instance still has its alarm scheduled; it fires as a warning no-op", async () => {
    const old = oldMatch(timeoutMatchId);
    // The seal does not delete the old alarm — it is still pending and will
    // wake the sealed instance once, for nothing.
    expect(await runDurableObjectAlarm(old)).toBe(true);
    const oldFired = await runInDurableObject(old, async (instance) =>
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.get<number>(
        "timeout-fired-at",
      ),
    );
    expect(oldFired).toBeUndefined(); // the no-op guard held
  });

  // -------------------------------------------------------------------------
  // 6. Cutover rehearsal
  // -------------------------------------------------------------------------

  it("6a. a second room migrates through the worker's admin driver (bulk pattern)", async () => {
    await oldRoom("arcade").post("system", "insert coin");
    const response = await SELF.fetch(
      "https://gameco.example/admin/migrate-room/arcade",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const summary = await response.json<{ rows: Record<string, number> }>();
    expect(summary.rows["messages"]).toBe(1);
  });

  it("6b. the post-cutover code path (plain accessors, no facade) serves everything", async () => {
    // Rooms: history and a live WebSocket session, via the plain accessor.
    const history = await SELF.fetch(
      `https://gameco.example/rooms/${ROOM}/history?phase=cutover`,
    );
    expect(history.status).toBe(200);
    expect((await history.json<RoomMessage[]>()).length).toBe(4);

    const zoe = attach(
      await wsViaWorker(`/rooms/${ROOM}/ws?phase=cutover&_pk=zoe`),
    );
    zoe.ws.send("cutover complete");
    expect(await zoe.next()).toMatchObject({ sender: "zoe", body: "cutover complete" });
    zoe.ws.close(1000, "done");

    const arcade = await SELF.fetch(
      "https://gameco.example/rooms/arcade/history?phase=cutover",
    );
    expect((await arcade.json<RoomMessage[]>()).map((m) => m.body)).toEqual([
      "insert coin",
    ]);

    // Matches already run on plain accessors after markMigrated.
    for (const match of matches) {
      const state = await app().match.get(migratedName(match.oldId)).state();
      expect(state.players).toEqual(match.players);
    }
  });
});
