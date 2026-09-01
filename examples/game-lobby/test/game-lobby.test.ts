import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isClaydoError, kinds } from "../../../src/index";
import type { GameState } from "../worker";

const app = kinds(env.APP_DO);
const lobby = () => app.lobby.get("main");

/** Awaits a promise that must reject, and returns the thrown error. */
async function caught(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

/** Polls until `ok` accepts the read value, or the deadline passes. */
async function eventually<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("lobby -> game flow", () => {
  it("plays a full match created through the lobby", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    expect(id).toMatch(/^[0-9a-f]{64}$/);

    const game = app.game.fromId(id);
    // alice: 0, 1, 2 wins the top row.
    await game.move("alice", 0);
    await game.move("bob", 4);
    await game.move("alice", 1);
    await game.move("bob", 8);
    const final = await game.move("alice", 2);

    expect(final.status).toBe("finished");
    expect(final.winner).toBe("alice");
    expect(final.endReason).toBe("win");
    // The board is readable through state() from a second stub.
    const again = await app.game.fromId(id).state();
    expect(again.board[0]).toBe("alice");
  });

  it("lists matches from lobby SQLite", async () => {
    const a = await lobby().createMatch(["alice", "bob"]);
    const b = await lobby().createMatch(["carol", "dave"]);
    const matches = await lobby().listMatches();
    const ids = matches.map((m) => m.id);
    expect(ids.indexOf(a)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(b)).toBe(ids.indexOf(a) + 1);
    expect(matches.find((m) => m.id === b)!.players).toEqual(["carol", "dave"]);
  });

  it("rejects out-of-turn moves with a clean error", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const game = app.game.fromId(id);
    const error = await caught(game.move("bob", 4));
    expect(error.message).toBe("not your turn: it is 'alice' to move");
    // Rejected moves do not change state.
    expect((await game.state()).board.every((c) => c === null)).toBe(true);
  });

  it("rejects moves from strangers and on taken cells", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const game = app.game.fromId(id);
    const stranger = await caught(game.move("mallory", 0));
    expect(stranger.message).toBe("'mallory' is not in this game");
    await game.move("alice", 0);
    const taken = await caught(game.move("bob", 0));
    expect(taken.message).toBe("cell 0 is already taken");
  });
});

describe("turn-timeout alarm", () => {
  it("forfeits the player who fails to move", async () => {
    // A short clock; alice is on turn and never moves.
    const id = await lobby().createMatch(["alice", "bob"], 25);

    const state = await eventually(
      () => app.game.fromId(id).state(),
      (s) => s.status === "finished",
    );
    expect(state.winner).toBe("bob");
    expect(state.endReason).toBe("timeout");

    // The game refuses further moves.
    const error = await caught(app.game.fromId(id).move("bob", 1));
    expect(error.message).toBe("game is finished; no more moves accepted");
  });

  it("clears the turn clock when the game finishes normally", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const game = app.game.fromId(id);
    await game.move("alice", 0);
    expect(await game.deadline()).toBeGreaterThan(Date.now());
    await game.move("bob", 4);
    await game.move("alice", 1);
    await game.move("bob", 8);
    await game.move("alice", 2); // alice wins; the clock stops
    expect(await game.deadline()).toBeNull();
  });
});

describe("websocket spectators", () => {
  it("broadcasts moves to spectators", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const game = app.game.fromId(id);

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
    await eventually(async () => messages.length, (n) => n >= 2);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: "move",
      player: "alice",
      cell: 4,
    });
    expect(messages[1]).toMatchObject({ type: "move", player: "bob", cell: 0 });
    expect((messages[1].state as GameState).turn).toBe("alice");
    ws.close();
  });

  it("broadcasts the forfeit when the turn times out", async () => {
    const id = await lobby().createMatch(["alice", "bob"], 250);
    const game = app.game.fromId(id);
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
    const event = await received;
    expect(event).toMatchObject({ type: "forfeit", player: "alice" });
    expect((event.state as GameState).winner).toBe("bob");
    ws.close();
  });
});

describe("worker routes end to end", () => {
  it("creates, plays and lists matches over HTTP", async () => {
    const created = await SELF.fetch("https://example.com/matches", {
      method: "POST",
      body: JSON.stringify({ players: ["alice", "bob"] }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const moved = await SELF.fetch(`https://example.com/matches/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ player: "alice", cell: 0 }),
    });
    expect(((await moved.json()) as GameState).board[0]).toBe("alice");

    const badMove = await SELF.fetch(
      `https://example.com/matches/${id}/move`,
      {
        method: "POST",
        body: JSON.stringify({ player: "alice", cell: 1 }),
      },
    );
    expect(badMove.status).toBe(409);
    expect(await badMove.json()).toEqual({
      error: "not your turn: it is 'bob' to move",
    });

    const listed = await SELF.fetch("https://example.com/matches");
    const ids = ((await listed.json()) as { id: string }[]).map((m) => m.id);
    expect(ids).toContain(id);
  });

  it("answers 404 for an id that never became a game", async () => {
    const freshId = env.APP_DO.newUniqueId().toString();
    const response = await SELF.fetch(
      `https://example.com/matches/${freshId}`,
    );
    expect(response.status).toBe(404);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("has no kind yet");
  });
});

describe("kind and id safety", () => {
  it("rejects a game id opened through the lobby accessor", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    const wrong = app.lobby.fromId(id);
    const error = await caught(wrong.listMatches());
    expect(isClaydoError(error)).toBe(true);
    if (isClaydoError(error)) expect(error.code).toBe("CLAYDO_KIND_MISMATCH");
  });

  it("fromId() never initializes an instance", async () => {
    const freshId = env.APP_DO.newUniqueId().toString();
    const ghost = app.game.fromId(freshId);
    const error = await caught(ghost.state());
    expect(isClaydoError(error)).toBe(true);
    if (isClaydoError(error)) expect(error.code).toBe("CLAYDO_UNINITIALIZED");
    // fetch() through a fromId() stub refuses to initialize too.
    const response = await ghost.fetch("https://do/");
    expect(response.status).toBe(404);
  });

  it("round-trips a unique() id through lobby SQLite", async () => {
    const id = await lobby().createMatch(["alice", "bob"]);
    // The id came back as a string (stub.id.toString()) and went through
    // SQLite; fromId() accepts the string directly.
    const stored = (await lobby().listMatches()).find((m) => m.id === id)!;
    const game = app.game.fromId(stored.id);
    expect((await game.state()).players).toEqual(["alice", "bob"]);
    // fromId() stubs have no logical name, but they know their kind.
    expect(game.name).toBeUndefined();
    expect(game.kind).toBe("game");
  });
});
