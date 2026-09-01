import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kinds } from "../../../src/index";
import worker, { type InsertDelta, type MessageRow } from "../worker";

const app = kinds(env.APP_DO);

/** Opens a WebSocket subscription to a room shard and buffers deltas. */
async function subscribe(room: string) {
  const shard = app.shard.get(room);
  const response = await shard.fetch("https://do/subscribe", {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const received: InsertDelta[] = [];
  const waiters: ((delta: InsertDelta) => void)[] = [];
  ws.accept();
  ws.addEventListener("message", (event) => {
    const delta = JSON.parse(event.data as string) as InsertDelta;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(delta);
    else received.push(delta);
  });
  return {
    ws,
    received,
    next(): Promise<InsertDelta> {
      const ready = received.shift();
      if (ready !== undefined) return Promise.resolve(ready);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => ws.close(),
  };
}

describe("shard kind: insert and list", () => {
  it("inserts and lists messages through RPC", async () => {
    const shard = app.shard.get("room-basic");
    expect(await shard.insert("room-basic", "hello")).toEqual({ seq: 1 });
    expect(await shard.insert("room-basic", "world")).toEqual({ seq: 2 });
    const rows = await shard.list("room-basic");
    expect(rows.map((r: MessageRow) => r.body)).toEqual(["hello", "world"]);
    expect(rows.map((r: MessageRow) => r.seq)).toEqual([1, 2]);
  });

  it("knows its own room name via instanceName()", async () => {
    const shard = app.shard.get("room-named");
    await shard.insert("room-named", "x");
    expect(await shard.roomName()).toBe("room-named");
  });

  it("keeps two rooms in independent instances", async () => {
    const a = app.shard.get("room-a");
    const b = app.shard.get("room-b");
    expect(a.id.toString()).not.toBe(b.id.toString());
    await a.insert("room-a", "only-in-a");
    await b.insert("room-b", "only-in-b");
    // Sequences restart per instance: proof the SQLite databases are separate.
    expect(await a.list("room-a")).toEqual([
      { room: "room-a", body: "only-in-a", seq: 1 },
    ]);
    expect(await b.list("room-b")).toEqual([
      { room: "room-b", body: "only-in-b", seq: 1 },
    ]);
  });
});

describe("shard kind: live subscriptions", () => {
  it("pushes a delta to two subscribers on every insert", async () => {
    const room = "room-live";
    const subA = await subscribe(room);
    const subB = await subscribe(room);

    const shard = app.shard.get(room);
    await shard.insert(room, "first");
    const [deltaA, deltaB] = await Promise.all([subA.next(), subB.next()]);
    expect(deltaA).toEqual({ type: "insert", room, body: "first", seq: 1 });
    expect(deltaB).toEqual(deltaA);

    await shard.insert(room, "second");
    expect((await subA.next()).seq).toBe(2);
    expect((await subB.next()).seq).toBe(2);

    subA.close();
    subB.close();
  });

  it("does not leak deltas across rooms", async () => {
    const subOther = await subscribe("room-quiet");
    const shard = app.shard.get("room-noisy");
    await shard.insert("room-noisy", "noise");
    // Give any (wrong) delivery a chance to arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(subOther.received).toEqual([]);
    subOther.close();
  });
});

describe("session kind", () => {
  it("tracks per-user recency across rooms", async () => {
    const session = app.session.get("user-1");
    await session.touch("alpha");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await session.touch("beta");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await session.touch("alpha"); // alpha becomes most recent again
    const recent = await session.recent();
    expect(recent.map((r: { room: string }) => r.room)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("keeps users independent", async () => {
    await app.session.get("user-a").touch("shared-room");
    const other = app.session.get("user-b");
    expect(await other.recent()).toEqual([]);
  });

  it("is a different instance from a shard with the same logical name", async () => {
    const asShard = app.shard.idFromName("same-name");
    const asSession = app.session.idFromName("same-name");
    expect(asShard.toString()).not.toBe(asSession.toString());
  });
});

describe("worker routes end to end", () => {
  async function call(input: string, init?: RequestInit) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://example.com${input}`, init),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("POST + GET /rooms/:room/messages", async () => {
    const post = await call("/rooms/e2e/messages", {
      method: "POST",
      body: JSON.stringify({ body: "via-http" }),
    });
    expect(post.status).toBe(201);
    expect(await post.json()).toEqual({ seq: 1 });

    const get = await call("/rooms/e2e/messages");
    expect(await get.json()).toEqual([
      { room: "e2e", body: "via-http", seq: 1 },
    ]);
  });

  it("GET /rooms/:room/subscribe upgrades and receives deltas", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://example.com/rooms/e2e-ws/subscribe", {
        headers: { Upgrade: "websocket" },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    const delta = new Promise<InsertDelta>((resolve) =>
      ws.addEventListener("message", (event) =>
        resolve(JSON.parse(event.data as string)),
      ),
    );
    await call("/rooms/e2e-ws/messages", {
      method: "POST",
      body: JSON.stringify({ body: "pushed" }),
    });
    expect(await delta).toEqual({
      type: "insert",
      room: "e2e-ws",
      body: "pushed",
      seq: 1,
    });
    ws.close();
    await waitOnExecutionContext(ctx);
  });

  it("POST /me/:user/touch/:room and GET /me/:user/recent", async () => {
    await call("/me/carol/touch/alpha", { method: "POST" });
    const recent = await call("/me/carol/recent");
    const rows = (await recent.json()) as { room: string; at: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.room).toBe("alpha");
  });
});
