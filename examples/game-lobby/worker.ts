/**
 * game-lobby example for claydo.
 *
 * Two kinds share one Durable Object class:
 *  - `lobby`: a singleton (`get("main")`) that creates matches and tracks
 *    them in its own SQLite database.
 *  - `game`: one instance per match (created with `unique()`), running a
 *    turn-based tic-tac-toe game with a turn-timeout alarm and WebSocket
 *    spectators.
 */
import { DurableObject } from "cloudflare:workers";
import { isClaydoError, kind, kinds, union } from "../../src/index";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
}

/** How long the current player has to move before the alarm forfeits them. */
export const DEFAULT_TURN_TIMEOUT_MS = 30_000;

export interface GameState {
  players: [string, string];
  /** 9 cells, row-major. `null` = empty, otherwise a player name. */
  board: (string | null)[];
  /** Whose turn it is. Meaningless once status is "finished". */
  turn: string;
  status: "active" | "finished";
  winner: string | null;
  /** Why the game finished: "win", "draw" or "timeout". */
  endReason: string | null;
  /** Per-match move clock, in milliseconds. */
  turnTimeoutMs: number;
}

const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
] as const;

/** Turn-based tic-tac-toe with a turn-timeout alarm and spectator sockets. */
export class Game extends DurableObject<Env> {
  async setup(
    players: string[],
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  ): Promise<GameState> {
    if (players.length !== 2) {
      throw new Error(`a game needs exactly 2 players, got ${players.length}`);
    }
    const existing = await this.ctx.storage.get<GameState>("state");
    if (existing !== undefined) {
      throw new Error("this game is already set up");
    }
    const state: GameState = {
      players: [players[0]!, players[1]!],
      board: Array(9).fill(null),
      turn: players[0]!,
      status: "active",
      winner: null,
      endReason: null,
      turnTimeoutMs,
    };
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(Date.now() + turnTimeoutMs);
    return state;
  }

  async move(player: string, cell: number): Promise<GameState> {
    const state = await this.#state();
    if (state.status !== "active") {
      throw new Error(`game is ${state.status}; no more moves accepted`);
    }
    if (!state.players.includes(player)) {
      throw new Error(`'${player}' is not in this game`);
    }
    if (state.turn !== player) {
      throw new Error(`not your turn: it is '${state.turn}' to move`);
    }
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) {
      throw new Error(`cell must be an integer 0-8, got ${cell}`);
    }
    if (state.board[cell] !== null) {
      throw new Error(`cell ${cell} is already taken`);
    }

    state.board[cell] = player;
    const won = WIN_LINES.some((line) =>
      line.every((i) => state.board[i] === player),
    );
    if (won) {
      state.status = "finished";
      state.winner = player;
      state.endReason = "win";
    } else if (state.board.every((c) => c !== null)) {
      state.status = "finished";
      state.endReason = "draw";
    } else {
      state.turn = state.players.find((p) => p !== player)!;
    }

    await this.ctx.storage.put("state", state);
    if (state.status === "active") {
      await this.ctx.storage.setAlarm(Date.now() + state.turnTimeoutMs);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
    this.#broadcast({ type: "move", player, cell, state });
    return state;
  }

  async state(): Promise<GameState> {
    return this.#state();
  }

  /** When the current turn times out, or `null` when no clock is running. */
  async deadline(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** Turn timeout: the player who failed to move forfeits. */
  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<GameState>("state");
    if (state === undefined || state.status !== "active") return;
    const slow = state.turn;
    state.status = "finished";
    state.winner = state.players.find((p) => p !== slow)!;
    state.endReason = "timeout";
    await this.ctx.storage.put("state", state);
    this.#broadcast({ type: "forfeit", player: slow, state });
  }

  /** Spectators connect over WebSocket and receive move broadcasts. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json(await this.#state());
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async #state(): Promise<GameState> {
    const state = await this.ctx.storage.get<GameState>("state");
    if (state === undefined) {
      throw new Error("game not set up yet: call setup(players) first");
    }
    return state;
  }

  #broadcast(event: object): void {
    const message = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) ws.send(message);
  }
}

/** Singleton lobby: creates game instances and tracks them in SQLite. */
export class Lobby extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        players TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
  }

  /** Creates a new game instance (a cross-kind call, from inside this kind). */
  async createMatch(
    players: string[],
    turnTimeoutMs?: number,
  ): Promise<string> {
    const game = kind(this.env.APP_DO, "game").unique();
    await game.setup(players, turnTimeoutMs);
    const id = game.id.toString();
    this.ctx.storage.sql.exec(
      `INSERT INTO matches (id, players, created_at) VALUES (?, ?, ?)`,
      id,
      JSON.stringify(players),
      Date.now(),
    );
    return id;
  }

  listMatches(): { id: string; players: string[] }[] {
    return this.ctx.storage.sql
      .exec<{ id: string; players: string }>(
        `SELECT id, players FROM matches ORDER BY created_at`,
      )
      .toArray()
      .map((row) => ({ id: row.id, players: JSON.parse(row.players) }));
  }
}

export class AppDO extends union({
  lobby: Lobby,
  game: Game,
}) {}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx?: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const app = kinds(env.APP_DO);
    const lobby = app.lobby.get("main");

    if (request.method === "POST" && url.pathname === "/matches") {
      const { players, turnTimeoutMs } = (await request.json()) as {
        players: string[];
        turnTimeoutMs?: number;
      };
      const id = await lobby.createMatch(players, turnTimeoutMs);
      return Response.json({ id }, { status: 201 });
    }
    if (request.method === "GET" && url.pathname === "/matches") {
      return Response.json(await lobby.listMatches());
    }

    const match = url.pathname.match(/^\/matches\/([0-9a-f]{64})(\/.*)?$/);
    if (match !== null) {
      const game = app.game.fromId(match[1]!);
      if (match[2] === "/ws") {
        return game.fetch(request);
      }
      try {
        if (request.method === "POST" && match[2] === "/move") {
          const { player, cell } = (await request.json()) as {
            player: string;
            cell: number;
          };
          return Response.json(await game.move(player, cell));
        }
        if (request.method === "GET" && match[2] === undefined) {
          return Response.json(await game.state());
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : `${error}`;
        // A claydo error here means the id does not name a live game:
        // fromId() never initializes an instance.
        const status = isClaydoError(error) ? 404 : 409;
        return Response.json({ error: message }, { status });
      }
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
