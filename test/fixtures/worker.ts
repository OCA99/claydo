import { DurableObject } from "cloudflare:workers";
import { instanceName, kinds, union } from "../../src/index";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
  RENAMED: DurableObjectNamespace<InstanceType<typeof RenamedDO>>;
  MISNAMED: DurableObjectNamespace<InstanceType<typeof Misnamed>>;
}

/** A kind with SQLite state, RPC methods, and a fetch handler. */
export class Counter extends DurableObject<Env> {
  /** A plain public property; the stub reports it as not callable. */
  public label = "counter";
  /** A function-valued instance field; Workers RPC cannot expose it. */
  public fieldFn = () => "field";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ensureSchema();
  }

  #ensureSchema(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL)",
    );
  }

  async increment(by = 1): Promise<number> {
    const row = this.ctx.storage.sql
      .exec<{ n: number }>(
        `INSERT INTO counters (name, n) VALUES ('main', ?)
         ON CONFLICT (name) DO UPDATE SET n = n + excluded.n
         RETURNING n`,
        by,
      )
      .one();
    return row.n;
  }

  async value(): Promise<number> {
    const rows = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT n FROM counters WHERE name = 'main'")
      .toArray();
    return rows[0]?.n ?? 0;
  }

  async whoAmI(): Promise<{ name: string | undefined; id: string }> {
    return {
      name: instanceName(this.ctx),
      id: this.ctx.id.toString(),
    };
  }

  async putKv(key: string, value: unknown): Promise<void> {
    this.ctx.storage.kv.put(key, value);
  }

  async getKv(key: string): Promise<unknown> {
    return this.ctx.storage.kv.get(key);
  }

  async listTables(): Promise<string[]> {
    return this.ctx.storage.sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
      )
      .toArray()
      .map((row) => row.name);
  }

  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.#ensureSchema();
  }

  async unserializable(): Promise<unknown> {
    class NotWireSafe {
      value = 1;
    }
    return new NotWireSafe();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/value") {
      return Response.json({ value: await this.value() });
    }
    return new Response("counter: not found", { status: 404 });
  }
}

export class VaultLockedError extends Error {
  code = "VAULT_LOCKED";
  retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "VaultLockedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** A kind that throws in interesting ways, and has no fetch handler. */
export class Vault extends DurableObject<Env> {
  async open(): Promise<never> {
    throw new VaultLockedError("the vault is locked", 1500);
  }

  async openNonError(): Promise<never> {
    // eslint-disable-next-line no-throw-literal
    throw "not an Error instance";
  }
}

/** A kind that schedules and receives alarms. */
export class Reminder extends DurableObject<Env> {
  async remindAt(time: number, payload: string): Promise<void> {
    this.ctx.storage.kv.put("payload", payload);
    await this.ctx.storage.setAlarm(time);
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const payload = this.ctx.storage.kv.get<string>("payload");
    this.ctx.storage.kv.put("fired", {
      payload,
      scheduledTime: alarmInfo?.scheduledTime,
      isRetry: alarmInfo?.isRetry,
      retryCount: alarmInfo?.retryCount,
    });
    const again = this.ctx.storage.kv.get<number>("reschedule");
    if (again !== undefined) {
      this.ctx.storage.kv.delete("reschedule");
      await this.ctx.storage.setAlarm(again);
    }
  }

  async rescheduleOnFire(time: number): Promise<void> {
    this.ctx.storage.kv.put("reschedule", time);
  }

  async fired(): Promise<unknown> {
    return this.ctx.storage.kv.get("fired");
  }

  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  async cancel(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }

  async setAlarmInTransaction(time: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      await txn.setAlarm(time);
    });
  }

  async setAlarmAroundTransaction(time: number): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      await this.ctx.storage.setAlarm(time);
    });
  }

  async setAlarmInTransactionSync(time: number): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      void this.ctx.storage.setAlarm(time);
    });
  }

  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

/**
 * A kind whose constructor captures `ctx` and `ctx.storage` into private
 * fields. Every storage access goes through the captured references.
 */
export class CapturedReminder {
  readonly #ctx: DurableObjectState;
  readonly #storage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.#ctx = ctx;
    this.#storage = ctx.storage;
  }

  async remindAt(time: number): Promise<void> {
    await this.#storage.setAlarm(time);
  }

  async alarm(): Promise<void> {
    this.#storage.kv.put("captured-fired", true);
  }

  async firedThroughCapture(): Promise<boolean> {
    return this.#storage.kv.get<boolean>("captured-fired") === true;
  }

  async capturedName(): Promise<string | undefined> {
    return instanceName(this.#ctx);
  }
}

/** A WebSocket chat kind using the hibernation API. */
export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("chat: expected a WebSocket upgrade", {
        status: 426,
      });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const body = typeof message === "string" ? message : "<binary>";
    if (body === "close-me") {
      ws.close(4000, "requested");
      return;
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (body) VALUES (?)",
      body,
    );
    for (const socket of this.ctx.getWebSockets()) {
      socket.send(`echo:${body}`);
    }
  }

  async webSocketClose(
    _ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    this.ctx.storage.kv.put("closed", { code, reason });
  }

  async history(): Promise<string[]> {
    return this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM messages ORDER BY id")
      .toArray()
      .map((row) => row.body);
  }

  async lastClose(): Promise<unknown> {
    return this.ctx.storage.kv.get("closed");
  }

  async connections(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }
}

/** A plain class kind: no DurableObject base, just a (ctx, env) constructor. */
export class PlainKind {
  #ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.#ctx = ctx;
  }

  async touch(): Promise<string> {
    this.#ctx.storage.kv.put("touched", true);
    return "plain";
  }
}

/** A kind whose constructor throws. */
export class BrokenKind extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    throw new Error("broken on purpose");
  }

  async anything(): Promise<void> {}
}

export class AppDO extends union({
  counter: Counter,
  vault: Vault,
  reminder: Reminder,
  captured: CapturedReminder,
  chat: ChatRoom,
  plain: PlainKind,
  broken: BrokenKind,
}) {}

/** A union exported without a subclass: the name option carries the export name. */
export const RenamedDO = union({ counter: Counter }, { name: "RenamedDO" });

/** A union exported without a subclass and without the name option. */
export const Misnamed = union({ counter: Counter });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, kindName, name, ...rest] = url.pathname.split("/");
    if (kindName === undefined || name === undefined || name === "") {
      return new Response("usage: /<kind>/<name>/...", { status: 400 });
    }
    const app = kinds(env.APP_DO);
    const accessor = app[kindName as keyof typeof app];
    const target = new URL(`/${rest.join("/")}`, url);
    return accessor
      .get(name)
      .fetch(new Request(target, request as RequestInit));
  },
} satisfies ExportedHandler<Env>;
