import { DurableObject } from "cloudflare:workers";
import {
  Server,
  type Connection,
  type WSMessage,
} from "partyserver";
import { kind, union } from "../../src/index";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
}

/** Messages allowed per user per window. Small so tests can hit the limit. */
export const LIMIT = 5;
export const WINDOW_MS = 60_000;

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Fixed-window per-user rate limiter. One instance per user id, addressed
 * as `kind(env.APP_DO, "limiter").get(userId)`.
 */
export class Limiter extends DurableObject<Env> {
  /** DX audit probe: a plain (non-method) public property. */
  windowMs = WINDOW_MS;

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
 * A PartyServer `Server` registered as a kind. Clients connect over
 * WebSocket; the connection id (PartyServer `_pk` query param) doubles as
 * the user id. Every message consults the per-user `limiter` kind — a
 * cross-kind call made from inside the Durable Object.
 */
export class Chat extends Server<Env> {
  static options = { hibernate: true };

  onConnect(connection: Connection): void {
    connection.send(
      JSON.stringify({
        type: "welcome",
        room: this.name,
        users: [...this.getConnections()].map((c) => c.id),
      }),
    );
    this.broadcast(
      JSON.stringify({ type: "join", user: connection.id }),
      [connection.id],
    );
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") return;
    // DX audit probe: what does a throw inside a WebSocket handler look like
    // to the client and the test runner?
    if (message === "/throw") {
      throw new Error("chat kind: deliberate failure inside onMessage");
    }
    // Cross-kind call from inside the DO: consult the per-user limiter.
    const result = await kind(this.env.APP_DO, "limiter")
      .get(connection.id)
      .consume();
    if (!result.allowed) {
      connection.send(
        JSON.stringify({ type: "rate-limited", resetAt: result.resetAt }),
      );
      return;
    }
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

  /** RPC alongside WebSockets: reports the room as seen from inside. */
  roomInfo(): { name: string; connections: number } {
    return {
      name: this.name,
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
    const chatMatch = /^\/chat\/([^/]+)$/.exec(url.pathname);
    if (chatMatch !== null && chatMatch[1] !== undefined) {
      return kind(env.APP_DO, "chat").get(chatMatch[1]).fetch(request);
    }
    const limitMatch = /^\/limit\/([^/]+)$/.exec(url.pathname);
    if (limitMatch !== null && limitMatch[1] !== undefined) {
      const result = await kind(env.APP_DO, "limiter")
        .get(limitMatch[1])
        .consume();
      return Response.json(result);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
