import { DurableObject } from "cloudflare:workers";
import { Server, type Connection, type WSMessage } from "partyserver";
import { instanceName, kind, union } from "../../src/index";

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
  ping(): string {
    return "pong";
  }
}

/** A third-party kind: a PartyServer Server, registered as-is. */
export class PartyRoom extends Server<Env> {
  onMessage(connection: Connection, message: WSMessage): void {
    connection.send(`party[${this.name}]:${message}`);
  }
}

export class AppDO extends union({
  counter: Counter,
  echo: Echo,
  reminder: Reminder,
  plain: Plain,
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
