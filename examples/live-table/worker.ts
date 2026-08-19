import { DurableObject } from "cloudflare:workers";
import { instanceName, kind, union } from "../../src/index";

export interface Env {
  APP_DO: DurableObjectNamespace<LiveTableDO>;
}

// NOTE: must be a `type`, not an `interface` — interfaces get no implicit
// index signature, so `sql.exec<MessageRow>` rejects them (workers-types).
export type MessageRow = {
  room: string;
  body: string;
  seq: number;
};

export interface InsertDelta {
  type: "insert";
  room: string;
  body: string;
  seq: number;
}

/**
 * One shard per room: the shard instance name IS the room key, which is the
 * sharding scheme. Owns a SQLite `messages` table and pushes a JSON delta to
 * every WebSocket subscriber on each insert (live query).
 */
export class Shard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        body TEXT NOT NULL
      )`,
    );
  }

  insert(room: string, body: string): { seq: number } {
    const { seq } = this.ctx.storage.sql
      .exec<{ seq: number }>(
        `INSERT INTO messages (room, body) VALUES (?, ?) RETURNING seq`,
        room,
        body,
      )
      .one();
    const delta: InsertDelta = { type: "insert", room, body, seq };
    const encoded = JSON.stringify(delta);
    for (const ws of this.ctx.getWebSockets()) ws.send(encoded);
    return { seq };
  }

  list(room: string): MessageRow[] {
    return this.ctx.storage.sql
      .exec<MessageRow>(
        `SELECT room, body, seq FROM messages WHERE room = ? ORDER BY seq`,
        room,
      )
      .toArray();
  }

  /** The logical room name, i.e. the instance name without the kind prefix. */
  roomName(): string | undefined {
    return instanceName(this.ctx);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}

/**
 * One session per user. Tracks the last time the user touched each room.
 * A second kind in the same namespace, with its own SQLite schema.
 */
export class Session extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS seen (
        room TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      )`,
    );
  }

  touch(room: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO seen (room, at) VALUES (?, ?)
       ON CONFLICT(room) DO UPDATE SET at = excluded.at`,
      room,
      Date.now(),
    );
  }

  recent(): { room: string; at: number }[] {
    return this.ctx.storage.sql
      .exec<{ room: string; at: number }>(
        `SELECT room, at FROM seen ORDER BY at DESC, room ASC`,
      )
      .toArray();
  }
}

/** A custom class that structured clone does not know. Used by DX probes. */
export class Widget {
  constructor(public label: string) {}
}

/**
 * DX-probe kind. Not part of the "product"; it exists so the test suite can
 * poke at RPC serialization, non-method properties, and reserved-name
 * shadowing. Adding it required no wrangler change — nice.
 */
export class Probe extends DurableObject<Env> {
  /** A public non-method field, to see how the stub treats it. */
  version = 7;

  returnMap(): Map<string, number> {
    return new Map([
      ["a", 1],
      ["b", 2],
    ]);
  }

  returnDate(): Date {
    return new Date(1_700_000_000_000);
  }

  returnBuffer(): ArrayBuffer {
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setUint32(0, 42);
    return buffer;
  }

  returnCustomClass(): Widget {
    return new Widget("gizmo");
  }

  echoLength(payload: string): number {
    return payload.length;
  }

  // NOTE: this class used to define a method named `name()` to probe stub
  // metadata shadowing. The library now rejects that at union() time — see
  // the "union() rejects reserved method names" probe test.
}

export class LiveTableDO extends union({
  shard: Shard,
  session: Session,
  probe: Probe,
}) {}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // POST/GET /rooms/:room/messages, GET /rooms/:room/subscribe
    if (parts[0] === "rooms" && parts[1] !== undefined) {
      const room = decodeURIComponent(parts[1]);
      const shard = kind(env.APP_DO, "shard").get(room);
      if (parts[2] === "messages" && request.method === "POST") {
        const { body } = await request.json<{ body: string }>();
        const { seq } = await shard.insert(room, body);
        return Response.json({ seq }, { status: 201 });
      }
      if (parts[2] === "messages" && request.method === "GET") {
        return Response.json(await shard.list(room));
      }
      if (parts[2] === "subscribe" && request.method === "GET") {
        return shard.fetch(request);
      }
    }

    // POST /me/:user/touch/:room, GET /me/:user/recent
    if (parts[0] === "me" && parts[1] !== undefined) {
      const session = kind(env.APP_DO, "session").get(parts[1]);
      if (parts[2] === "touch" && parts[3] !== undefined && request.method === "POST") {
        await session.touch(decodeURIComponent(parts[3]));
        return Response.json({ ok: true });
      }
      if (parts[2] === "recent" && request.method === "GET") {
        return Response.json(await session.recent());
      }
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
