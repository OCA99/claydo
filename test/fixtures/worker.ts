import { DurableObject } from "cloudflare:workers";
import { Server, type Connection, type WSMessage } from "partyserver";
import { instanceName, kind, resetStorage, union } from "../../src/index";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
}

/** A SQLite-backed counter kind. */
export class Counter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )`,
    );
  }

  increment(by = 1): number {
    return this.ctx.storage.sql
      .exec<{ value: number }>(
        `INSERT INTO counters (name, value) VALUES ('default', ?)
         ON CONFLICT(name) DO UPDATE SET value = value + excluded.value
         RETURNING value`,
        by,
      )
      .one().value;
  }

  value(): number {
    const rows = this.ctx.storage.sql
      .exec<{ value: number }>(
        `SELECT value FROM counters WHERE name = 'default'`,
      )
      .toArray();
    return rows[0]?.value ?? 0;
  }

  whoAmI(): string | undefined {
    return instanceName(this.ctx);
  }
}

/** A kind with a fetch() handler and hibernating WebSockets. */
export class Echo extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response(`echo:${new URL(request.url).pathname}`);
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    ws.send(`echo:${message}`);
  }
}

/** A kind that uses alarms. */
export class Reminder extends DurableObject<Env> {
  async remind(text: string): Promise<void> {
    await this.ctx.storage.put("text", text);
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async alarm(): Promise<void> {
    const text = await this.ctx.storage.get<string>("text");
    await this.ctx.storage.put("fired", `fired:${text}`);
  }

  async fired(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("fired")) ?? null;
  }
}

/** A kind with no handlers, to exercise error paths. */
export class Plain extends DurableObject<Env> {
  label = "plain-label";

  ping(): string {
    return "pong";
  }
}

class TeapotError extends Error {
  override name = "TeapotError";
  status = 418;
  detail = { hint: "short and stout" };
}

/** A kind that throws a custom error, to exercise error fidelity. */
export class Teapot extends DurableObject<Env> {
  explode(): never {
    throw new TeapotError("I am a teapot");
  }
}

/** A kind that wipes its own storage, to exercise resetStorage(). */
export class Vault extends DurableObject<Env> {
  async set(key: string, value: string): Promise<void> {
    await this.ctx.storage.put(`v:${key}`, value);
  }

  async getValue(key: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`v:${key}`);
  }

  async wipe(): Promise<void> {
    await resetStorage(this.ctx);
  }
}

/** A third-party kind: a PartyServer Server, registered as-is. */
export class PartyRoom extends Server<Env> {
  onMessage(connection: Connection, message: WSMessage): void {
    connection.send(`party[${this.name}]:${message}`);
  }

  /**
   * A plain RPC method. It reads `this.name`, which only works after the
   * framework startup hook ran — the host runs it, so RPC-first access
   * works without a warm-up fetch().
   */
  roomName(): string {
    return this.name;
  }
}

export class AppDO extends union({
  counter: Counter,
  echo: Echo,
  reminder: Reminder,
  plain: Plain,
  teapot: Teapot,
  vault: Vault,
  party: PartyRoom,
}) {}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const [, resource, name] = url.pathname.split("/");
    if (resource === "counter" && name !== undefined) {
      const value = await kind(env.APP_DO, "counter").get(name).increment(1);
      return Response.json({ value });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
