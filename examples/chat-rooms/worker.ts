import { DurableObject } from "cloudflare:workers";
import { Server, type Connection, type WSMessage } from "partyserver";
import { instanceName, kinds, union } from "../../src/index";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
}

/** Messages allowed per user per window. Small so tests can reach the limit. */
export const LIMIT = 5;
export const WINDOW_MS = 60_000;

/** Recent messages replayed to each client on connect. */
export const HISTORY_LIMIT = 20;

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface ChatMessage {
  user: string;
  text: string;
}

/**
 * Fixed-window per-user rate limiter. One instance per user id, addressed
 * as `kinds(env.APP_DO).limiter.get(userId)`. The window state lives in
 * this kind's own SQLite database.
 */
export class Limiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS window (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        start INTEGER NOT NULL,
        used INTEGER NOT NULL
      )`,
    );
  }

  consume(): LimitResult {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<{ start: number; used: number }>(
        `SELECT start, used FROM window WHERE id = 0`,
      )
      .toArray()[0];
    let start = row?.start ?? now;
    let used = row?.used ?? 0;
    if (now - start >= WINDOW_MS) {
      start = now;
      used = 0;
    }
    const allowed = used < LIMIT;
    if (allowed) used += 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO window (id, start, used) VALUES (0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET start = excluded.start, used = excluded.used`,
      start,
      used,
    );
    return {
      allowed,
      remaining: Math.max(0, LIMIT - used),
      resetAt: start + WINDOW_MS,
    };
  }

  /** Reads the current window without consuming. */
  peek(): { used: number; remaining: number } {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec<{ start: number; used: number }>(
        `SELECT start, used FROM window WHERE id = 0`,
      )
      .toArray()[0];
    if (row === undefined || now - row.start >= WINDOW_MS) {
      return { used: 0, remaining: LIMIT };
    }
    return { used: row.used, remaining: Math.max(0, LIMIT - row.used) };
  }
}

/**
 * A chat room: a PartyServer `Server` registered as a kind. Clients connect
 * over WebSocket, and the connection id (PartyServer's `_pk` query
 * parameter) doubles as the user id. Messages persist in the room's own
 * SQLite database and are replayed to new connections. Every message
 * consults the per-user `limiter` kind — a cross-kind call made from
 * inside the Durable Object.
 */
export class Chat extends Server<Env> {
  static options = { hibernate: true };

  onStart(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT NOT NULL,
        text TEXT NOT NULL
      )`,
    );
  }

  onConnect(connection: Connection): void {
    connection.send(
      JSON.stringify({
        type: "welcome",
        room: this.name,
        users: [...this.getConnections()].map((c) => c.id),
        history: this.history(),
      }),
    );
    this.broadcast(
      JSON.stringify({ type: "join", user: connection.id }),
      [connection.id],
    );
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") return;
    const result = await kinds(this.env.APP_DO)
      .limiter.get(connection.id)
      .consume();
    if (!result.allowed) {
      connection.send(
        JSON.stringify({ type: "rate-limited", resetAt: result.resetAt }),
      );
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (user, text) VALUES (?, ?)`,
      connection.id,
      message,
    );
    this.broadcast(
      JSON.stringify({
        type: "chat",
        user: connection.id,
        text: message,
        remaining: result.remaining,
      }),
    );
  }

  onClose(connection: Connection): void {
    this.broadcast(
      JSON.stringify({ type: "leave", user: connection.id }),
      [connection.id],
    );
  }

  /** The most recent messages, oldest first. */
  history(): ChatMessage[] {
    return this.ctx.storage.sql
      .exec<{ user: string; text: string }>(
        `SELECT user, text FROM (
           SELECT id, user, text FROM messages ORDER BY id DESC LIMIT ?
         ) ORDER BY id`,
        HISTORY_LIMIT,
      )
      .toArray();
  }

  /**
   * RPC alongside WebSockets. PartyServer reads `ctx.id.name`, which
   * includes the kind prefix, so `this.name` is `chat:<room>`; the
   * `instanceName()` helper strips the prefix.
   */
  roomInfo(): { name: string; room: string | undefined; connections: number } {
    return {
      name: this.name,
      room: instanceName(this.ctx),
      connections: [...this.getConnections()].length,
    };
  }
}

export class AppDO extends union({
  chat: Chat,
  limiter: Limiter,
}) {}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const app = kinds(env.APP_DO);
    const chatMatch = /^\/chat\/([^/]+)$/.exec(url.pathname);
    if (chatMatch !== null && chatMatch[1] !== undefined) {
      return app.chat.get(chatMatch[1]).fetch(request);
    }
    const limitMatch = /^\/limit\/([^/]+)$/.exec(url.pathname);
    if (limitMatch !== null && limitMatch[1] !== undefined) {
      const result = await app.limiter.get(limitMatch[1]).consume();
      return Response.json(result);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
