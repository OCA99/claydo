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

interface SocketProbe {
  ws: WebSocket;

  next(timeoutMs?: number): Promise<Record<string, unknown>>;

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

async function waitForClose(
  probe: SocketProbe,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (probe.closes.length === 0 && Date.now() < deadline) {
    await sleep(50);
  }
}

async function wsViaWorker(path: string): Promise<Response> {
  return SELF.fetch(`https://gameco.example${path}`, {
    headers: { Upgrade: "websocket" },
  });
}

const ROOM = "lobby";
const matches: { oldId: string; players: string[] }[] = [];
let timeoutMatchId = "";
let timeoutDeadline = 0;

describe("GameCo consolidation journey", () => {

  it("1a. seeds the legacy room binding with history over RPC and WebSocket", async () => {
    const old = oldRoom(ROOM);
    expect(await old.post("system", "welcome to the lobby")).toBe(1);

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

  let liveSocket: SocketProbe;

  it("2a. a live session connects through the facade and lands on the old room", async () => {
    const alice = attach(await wsViaWorker(`/rooms/${ROOM}/ws?_pk=alice`));
    alice.ws.send("anyone up for a match?");
    expect(await alice.next()).toEqual({
      room: ROOM,
      sender: "alice",
      body: "anyone up for a match?",
    });
    liveSocket = alice;
  });

  it("2b. migrating the room mid-session: sealing closes the socket with 1012", async () => {
    const summary = await migrateInstance({
      from: oldRoom(ROOM),
      to: app().room,
      name: ROOM,
    });
    expect(summary.skipped).toBe(false);
    expect(summary.rows["messages"]).toBe(3);

    await waitForClose(liveSocket);
    expect(liveSocket.closes).toEqual([
      {
        code: 1012,
        reason: "claydo: instance migrating; reconnect",
        wasClean: true,
      },
    ]);
    expect(liveSocket.ws.readyState).toBe(WebSocket.READY_STATE_CLOSED);
    expect(liveSocket.buffered()).toBe(0);

    expect((await app().room.get(ROOM).history()).length).toBe(3);
  });

  it("2c. reconnecting through the facade immediately after migration succeeds (410 retried internally)", async () => {
    const alice = attach(await wsViaWorker(`/rooms/${ROOM}/ws?_pk=alice`));
    alice.ws.send("back online");
    expect(await alice.next()).toEqual({
      room: "room:lobby",
      sender: "alice",
      body: "back online",
    });
    alice.ws.close(1000, "bye");

    const after = await app().room.get(ROOM).history();
    expect(after.length).toBe(4);
  });

  it("2d. history flows through the facade; the sealed 410 is generic and marked, with no DO-id leak", async () => {
    const history = await SELF.fetch(
      `https://gameco.example/rooms/${ROOM}/history`,
    );
    expect(history.status).toBe(200);
    const rows = await history.json<RoomMessage[]>();
    expect(rows.map((m) => m.body)).toEqual([
      "welcome to the lobby",
      "gg wp",
      "anyone up for a match?",
      "back online",
    ]);

    const gone = await oldRoom(ROOM).fetch("https://old.gameco/rooms/lobby");
    expect(gone.status).toBe(410);
    expect(gone.headers.get("x-claydo-sealed")).toBe("1");
    const text = await gone.text();
    expect(text).toBe(
      "claydo: this instance is sealed (migrating or migrated). Reconnect through the current endpoint.",
    );
    expect(text).not.toMatch(/Durable Object id/);
  });

  it("3a. history rows written before and after migration disagree on the room name", async () => {
    const rows = await app().room.get(ROOM).history();
    expect(rows.map((m) => m.room)).toEqual([
      "lobby",
      "lobby",
      "lobby",
      "room:lobby",
    ]);
    const filtered = await app().room.get(ROOM).historyForThisRoom();
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.body).toBe("back online");
  });

  it("3b. identity: this.name changed, instanceName() gives the logical name, __ps_name was overwritten", async () => {
    const label = await app().room.get(ROOM).label();
    expect(label.doName).toBe("room:lobby");
    expect(label.logical).toBe("lobby");

    expect(await app().room.get(ROOM).storedPartyName()).toBe("room:lobby");
  });

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

    const again = await SELF.fetch(
      `https://gameco.example/admin/migrate-match/${matches[0]!.oldId}`,
      { method: "POST" },
    );
    expect(
      await again.json<{ skipped: boolean; reason?: string }>(),
    ).toMatchObject({ skipped: true, reason: "already migrated" });

    const registry = await SELF.fetch("https://gameco.example/admin/registry");
    const listed = await registry.json<{ oldId: string; migrated: boolean }[]>();
    expect(listed.length).toBe(3);
    expect(listed.every((m) => m.migrated)).toBe(true);
  });

  it("4b. old id -> new name lookups work through the worker and directly", async () => {
    for (const match of matches) {
      const viaWorker = await SELF.fetch(
        `https://gameco.example/matches/${match.oldId}/state`,
      );
      const state = await viaWorker.json<MatchState>();
      expect(state.players).toEqual(match.players);
      expect(state.moves).toBe(1);
      const direct = await app()
        .match.get(migratedName(match.oldId))
        .state();
      expect(direct).toEqual(state);
    }
  });

  it("4c. the old unique-id string is useless against the new namespace", async () => {
    expect(() => app().match.fromId(matches[0]!.oldId)).toThrowError(
      /Durable Object ID is not valid for this namespace/,
    );
  });

  it("4d. the old sealed match rejects RPC; fetch() answers 410 even without a fetch() on the class", async () => {
    const old = oldMatch(matches[0]!.oldId);
    await expectRejects(() => old.state(), /is sealed/);
    const gone = await old.fetch("https://old.gameco/");
    expect(gone.status).toBe(410);
    expect(gone.headers.get("x-claydo-sealed")).toBe("1");
  });

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

  it("5b. the OLD instance's alarm was deleted when the move was recorded", async () => {
    const old = oldMatch(timeoutMatchId);
    expect(await runDurableObjectAlarm(old)).toBe(false);
    const oldFired = await runInDurableObject(old, async (_instance, state) =>
      state.storage.get<number>("timeout-fired-at"),
    );
    expect(oldFired).toBeUndefined();
  });

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

    for (const match of matches) {
      const state = await app().match.get(migratedName(match.oldId)).state();
      expect(state.players).toEqual(match.players);
    }
  });
});
