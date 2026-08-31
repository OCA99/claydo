import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind, kinds, union } from "../../../src/index";
import { KIND_STORAGE_KEY } from "../../../src/types";
import worker, { Game, type GameState } from "../worker";

const lobby = () => kind(env.APP_DO, "lobby").get("main");
const games = () => kind(env.APP_DO, "game");

function rawStub(id: string) {
  return env.APP_DO.get(env.APP_DO.idFromString(id));
}

describe("lobby -> game flow", () => {
  it("plays a full match created through the lobby", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    expect(id).toMatch(/^[0-9a-f]{64}$/);

    const game = games().fromId(id);
    await game.move("alice", 0);
    await game.move("bob", 4);
    await game.move("alice", 1);
    await game.move("bob", 8);
    const final = await game.move("alice", 2);

    expect(final.status).toBe("finished");
    expect(final.winner).toBe("alice");
    expect(final.endReason).toBe("win");
    const again = await games().fromId(id).state();
    expect(again.board[0]).toBe("alice");
  });

  it("lists matches from lobby SQLite", async () => {
    const a = await lobby().createMatch(["alice", "bob"]);
    const b = await lobby().createMatch(["carol", "dave"]);
    const ids = (await lobby().listMatches()).map((m) => m.id);
    expect(ids.indexOf(a)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(b)).toBe(ids.indexOf(a) + 1);
    const matches = await lobby().listMatches();
    expect(matches.find((m) => m.id === b)!.players).toEqual(["carol", "dave"]);
  });

  it("rejects out-of-turn moves with a clean error", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const game = games().fromId(id);
    await expect(game.move("bob", 4)).rejects.toThrow(
      "not your turn: it is 'alice' to move",
    );
    expect((await game.state()).board.every((c) => c === null)).toBe(true);
  });

  it("rejects moves from strangers and on taken cells", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const game = games().fromId(id);
    await expect(game.move("mallory", 0)).rejects.toThrow(
      "'mallory' is not in this game",
    );
    await game.move("alice", 0);
    await expect(game.move("bob", 0)).rejects.toThrow(
      "cell 0 is already taken",
    );
  });
});

describe("turn-timeout alarm", () => {
  it("forfeits the slow player when the alarm fires", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    await games().fromId(id).move("alice", 0);

    const ran = await runDurableObjectAlarm(rawStub(id));
    expect(ran).toBe(true);

    const state = await games().fromId(id).state();
    expect(state.status).toBe("finished");
    expect(state.winner).toBe("alice"); // bob was on turn and timed out
    expect(state.endReason).toBe("timeout");

    await expect(games().fromId(id).move("alice", 1)).rejects.toThrow(
      "game is finished; no more moves accepted",
    );
  });

  it("clears the alarm when the game finishes normally", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const game = games().fromId(id);
    await game.move("alice", 0);
    await game.move("bob", 4);
    await game.move("alice", 1);
    await game.move("bob", 8);
    await game.move("alice", 2); // alice wins; alarm deleted
    const ran = await runDurableObjectAlarm(rawStub(id));
    expect(ran).toBe(false);
  });
});

describe("websocket spectators", () => {
  it("broadcasts moves to spectators", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const game = games().fromId(id);

    const response = await game.fetch("https://do/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    const messages: any[] = [];
    ws.addEventListener("message", (event) => {
      messages.push(JSON.parse(event.data as string));
    });

    await game.move("alice", 4);
    await game.move("bob", 0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ type: "move", player: "alice", cell: 4 });
    expect(messages[1]).toMatchObject({ type: "move", player: "bob", cell: 0 });
    expect((messages[1].state as GameState).turn).toBe("alice");
    ws.close();
  });

  it("broadcasts the forfeit when the alarm fires", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const game = games().fromId(id);
    const response = await game.fetch("https://do/ws", {
      headers: { Upgrade: "websocket" },
    });
    const ws = response.webSocket!;
    ws.accept();
    const received = new Promise<any>((resolve) =>
      ws.addEventListener("message", (event) =>
        resolve(JSON.parse(event.data as string)),
      ),
    );
    await runDurableObjectAlarm(rawStub(id));
    const event = await received;
    expect(event).toMatchObject({ type: "forfeit", player: "alice" });
    ws.close();
  });
});

describe("worker routes end to end", () => {
  it("creates, plays and lists matches over HTTP", async () => {
    const created = await worker.fetch(
      new Request("https://x/matches", {
        method: "POST",
        body: JSON.stringify({ players: ["alice", "bob"] }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const moved = await worker.fetch(
      new Request(`https://x/matches/${id}/move`, {
        method: "POST",
        body: JSON.stringify({ player: "alice", cell: 0 }),
      }),
      env,
    );
    expect(((await moved.json()) as GameState).board[0]).toBe("alice");

    const badMove = await worker.fetch(
      new Request(`https://x/matches/${id}/move`, {
        method: "POST",
        body: JSON.stringify({ player: "alice", cell: 1 }),
      }),
      env,
    );
    expect(badMove.status).toBe(409);
    expect(await badMove.json()).toEqual({
      error: "not your turn: it is 'bob' to move",
    });

    const listed = await worker.fetch(new Request("https://x/matches"), env);
    expect(((await listed.json()) as { id: string }[]).map((m) => m.id)).toContain(id);
  });
});

describe("edge cases", () => {
  it("kind mismatch — game id opened through the lobby accessor", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const wrong = kind(env.APP_DO, "lobby").fromId(id);
    await expect(wrong.listMatches()).rejects.toThrow(
      `claydo: instance '${id}' is kind 'game', but the caller expected kind 'lobby'.`,
    );
  });

  it("fromId() never initializes an instance", async () => {
    const freshId = env.APP_DO.newUniqueId().toString();
    const ghost = kind(env.APP_DO, "game").fromId(freshId);
    const expected =
      `claydo: instance '${freshId}' has no kind yet. ` +
      `It was accessed as kind 'game' through fromId(), which never ` +
      `initializes an instance. Create the instance first with ` +
      `kind(ns, 'game').get(name) or .unique(), then reach it by id.`;
    await expect(ghost.state()).rejects.toThrow(expected);
    const response = await ghost.fetch("https://do/");
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(expected);
    const raw = env.APP_DO.get(env.APP_DO.idFromString(freshId));
    expect(await raw.__claydoKind()).toBeUndefined();
  });

  it("unique() id round-trip through lobby SQLite", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const stored = (await lobby().listMatches()).find((m) => m.id === id)!;
    const game = games().fromId(stored.id);
    expect((await game.state()).players).toEqual(["alice", "bob"]);
    expect(game.name).toBeUndefined();
  });

  it("renamed kind in the registry orphans existing instances", async () => {
    const raw = env.APP_DO.get(env.APP_DO.newUniqueId());
    await runInDurableObject(raw, async (_instance, state) => {
      await state.storage.put(KIND_STORAGE_KEY, "match");
    });
    const viaGame = kind(env.APP_DO, "game").fromId(raw.id.toString());
    await expect(viaGame.state()).rejects.toThrow(
      `claydo: unknown kind 'match' on instance '${raw.id.toString()}'. Registered kinds: lobby, game.`,
    );
  });

  it("registering a kind name with a colon throws at union() time", () => {
    expect(() =>
      union({ "bad:kind": Game }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: claydo: invalid kind name 'bad:kind'. Kind names must be non-empty, must not contain ':', and must not start with '__'.]`,
    );
  });

  it("two union() classes coexist in one worker", async () => {
    const metrics = kind(env.METRICS_DO, "metrics").get("global");
    expect(await metrics.bump("games")).toBe(1);
    expect(await metrics.bump("games")).toBe(2);
    const confused = kind(env.METRICS_DO as any, "game").get("x");
    await expect((confused as any).state()).rejects.toThrow(
      "claydo: unknown kind 'game' on instance 'game:x'. Registered kinds: metrics.",
    );
  });

  it("calling a plain property through the stub explains itself", async () => {
    const metrics = kind(env.METRICS_DO, "metrics").get("props");
    await expect((metrics as any).version()).rejects.toThrow(
      "claydo: 'version' on kind 'metrics' is a property, not a method (type: number). The stub only proxies methods; add a getter method to read it.",
    );
  });

  it("union() rejects kind classes with reserved method names at class-creation time", () => {
    class BadKind {
      constructor(_ctx: DurableObjectState, _env: unknown) {}
      name(): string {
        return "shadowed";
      }
    }
    expect(() => union({ bad: BadKind })).toThrow(
      "claydo: kind 'bad' (class BadKind) defines a method " +
        "named 'name'. The stub reserves 'id', 'name', 'kind', 'stub' for " +
        "metadata, so this method would not be callable. Rename the method.",
    );
  });

  it("the kinds() accessor works end to end", async () => {
    const app = kinds(env.APP_DO);
    const id = await app.lobby.get("main").createMatch(["erin", "frank"]);
    const state = await app.game.fromId(id).state();
    expect(state.players).toEqual(["erin", "frank"]);
    expect(state.status).toBe("active");
  });

  it("typo'd method name via `as any`", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const game = games().fromId(id);
    await expect((game as any).moev("alice", 0)).rejects.toThrow(
      "claydo: kind 'game' has no method 'moev'.",
    );
  });

  it("raw access to an uninitialized unique instance", async () => {
    const raw = env.APP_DO.get(env.APP_DO.newUniqueId());
    const response = await raw.fetch("https://do/");
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      `claydo: instance '${raw.id.toString()}' has no kind yet. ` +
        `Unique-ID instances initialize on their first call through kind(ns, '<kind>').unique().`,
    );
  });
});
