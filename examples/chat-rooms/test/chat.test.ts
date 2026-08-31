import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import worker, { LIMIT } from "../worker";
import { connect } from "./helpers";

describe("chat rooms (partyserver kind)", () => {
  it("delivers messages and presence between two clients in a room", async () => {
    const alice = await connect("lobby", "alice");
    expect(await alice.next()).toMatchObject({
      type: "welcome",
      room: "chat:lobby",
      users: ["alice"],
    });

    const bob = await connect("lobby", "bob");
    const bobWelcome = await bob.next();
    expect(bobWelcome.type).toBe("welcome");
    expect([...(bobWelcome.users as string[])].sort()).toEqual([
      "alice",
      "bob",
    ]);
    expect(await alice.next()).toMatchObject({ type: "join", user: "bob" });

    alice.ws.send("hello bob");
    expect(await alice.next()).toMatchObject({
      type: "chat",
      user: "alice",
      text: "hello bob",
    });
    expect(await bob.next()).toMatchObject({
      type: "chat",
      user: "alice",
      text: "hello bob",
    });

    bob.close();
    expect(await alice.next()).toMatchObject({ type: "leave", user: "bob" });
    alice.close();
  });

  it("keeps rooms isolated: same user, different room", async () => {
    const a = await connect("room-a", "carol");
    const b = await connect("room-b", "carol");
    await a.next(); // welcome
    await b.next(); // welcome
    a.ws.send("only in a");
    expect(await a.next()).toMatchObject({ type: "chat", text: "only in a" });
    b.ws.send("marker");
    expect(await b.next()).toMatchObject({ type: "chat", text: "marker" });
    a.close();
    b.close();
  });

  it("rate limits a user across messages (cross-kind call from inside the DO)", async () => {
    const eve = await connect("limited", "eve");
    await eve.next(); // welcome
    for (let i = 1; i <= LIMIT; i++) {
      eve.ws.send(`message ${i}`);
      expect(await eve.next()).toMatchObject({
        type: "chat",
        text: `message ${i}`,
        remaining: LIMIT - i,
      });
    }
    eve.ws.send("one too many");
    expect(await eve.next()).toMatchObject({ type: "rate-limited" });

    const limiter = kind(env.APP_DO, "limiter").get("eve");
    expect(await limiter.peek()).toEqual({ used: LIMIT, remaining: 0 });
    eve.close();
  });

  it("supports reconnecting with the same user id (hibernation-style)", async () => {
    const first = await connect("reconnect", "dan");
    await first.next(); // welcome
    first.ws.send("before reconnect");
    expect(await first.next()).toMatchObject({ text: "before reconnect" });
    first.close();

    const second = await connect("reconnect", "dan");
    expect(await second.next()).toMatchObject({
      type: "welcome",
      users: ["dan"],
    });
    second.ws.send("after reconnect");
    expect(await second.next()).toMatchObject({
      type: "chat",
      user: "dan",
      text: "after reconnect",
    });
    second.close();
  });

  it("exposes this.name inside the Server WITH the kind prefix", async () => {
    const client = await connect("prefixed", "nina");
    await client.next(); // welcome
    const info = await kind(env.APP_DO, "chat").get("prefixed").roomInfo();
    expect(info).toEqual({ name: "chat:prefixed", connections: 1 });
    client.close();
  });

  it("answers RPC on a fresh room that never saw a connection", async () => {
    const info = await kind(env.APP_DO, "chat").get("cold-room").roomInfo();
    expect(info).toEqual({ name: "chat:cold-room", connections: 0 });
  });

  it("pushes to connected clients from a stub RPC call (broadcast)", async () => {
    const client = await connect("push", "olga");
    await client.next(); // welcome
    await kind(env.APP_DO, "chat")
      .get("push")
      .broadcast(
        JSON.stringify({ type: "chat", user: "system", text: "maintenance" }),
      );
    expect(await client.next()).toMatchObject({
      user: "system",
      text: "maintenance",
    });
    client.close();
  });
});

describe("limiter (plain DurableObject kind)", () => {
  it("counts down and blocks after the limit", async () => {
    const limiter = kind(env.APP_DO, "limiter").get("solo");
    for (let i = 1; i <= LIMIT; i++) {
      const result = await limiter.consume();
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(LIMIT - i);
    }
    const blocked = await limiter.consume();
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("is reachable end to end through the worker", async () => {
    const ctx = createExecutionContext();
    const request = new Request("https://example.com/limit/worker-user");
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await response.json()).toMatchObject({
      allowed: true,
      remaining: LIMIT - 1,
    });
  });
});
