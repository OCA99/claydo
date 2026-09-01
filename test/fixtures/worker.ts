import { Server, type Connection, type WSMessage } from "partyserver";
import {
  DurableObject,
  instanceName,
  kind,
  resetStorage,
  union,
} from "../../src/index";
import { exportable } from "../../src/migrate";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
  LEGACY: DurableObjectNamespace<LegacyTally>;
  LEGACY_FW: DurableObjectNamespace<LegacyFramework>;
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
  async marker(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("marker");
  }

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
    if (message === "reset") {
      await this.ctx.storage.put("marker", "before-reset");
      await this.ctx.storage.deleteAll();
      return;
    }
    ws.send(`echo:${message}`);
  }
}

/** A kind that uses alarms. */
export class Reminder extends DurableObject<Env> {
  readonly #capturedStorage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#capturedStorage = ctx.storage;
  }

  async remind(text: string): Promise<void> {
    await this.ctx.storage.put("text", text);
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async remindThroughCapturedStorage(text: string): Promise<void> {
    await this.#capturedStorage.put("text", text);
    await this.#capturedStorage.setAlarm(Date.now() + 60_000);
  }

  async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const text = await this.ctx.storage.get<string>("text");
    await this.ctx.storage.put("fired", `fired:${text}`);
    await this.ctx.storage.put("alarm-info", {
      isRetry: info?.isRetry,
      retryCount: info?.retryCount,
      scheduledTime: info?.scheduledTime,
    });
  }

  async fired(): Promise<string | null> {
    return (await this.ctx.storage.get<string>("fired")) ?? null;
  }

  async alarmInfo(): Promise<{
    isRetry?: boolean;
    retryCount?: number;
    scheduledTime?: number;
  }> {
    return (
      (await this.ctx.storage.get("alarm-info")) as {
        isRetry?: boolean;
        retryCount?: number;
        scheduledTime?: number;
      }
    ) ?? {};
  }

  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  async alarmInsideTransaction(): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      await txn.setAlarm(Date.now() + 60_000);
    });
  }

  async outerAlarmInsideTransaction(): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    });
  }

  alarmInsideSyncTransaction(): void {
    this.ctx.storage.transactionSync(() => {
      void this.ctx.storage.setAlarm(Date.now() + 60_000);
    });
  }
}

/** A kind with no handlers, to exercise error paths. */
export class Plain extends DurableObject<Env> {
  label = "plain-label";
  fieldFunction = (): string => "not RPC";

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

  explodeWithThrowingField(): never {
    const error = Object.assign(new Error("still serializable"), {
      code: "SAFE_CODE",
    });
    Object.defineProperty(error, "hostile", {
      enumerable: true,
      get(): never {
        throw new Error("getter exploded");
      },
    });
    throw error;
  }
}

export class BrokenConstructor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    throw new Error("broken constructor");
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

  async wipeAndFinishWork(): Promise<string> {
    await this.ctx.storage.deleteAll();
    await scheduler.wait(25);
    return "finished";
  }

  async wipeThenWrite(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("v:epoch", "2");
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  seedForeignKeys(): void {
    this.ctx.storage.sql.exec("PRAGMA foreign_keys = ON");
    this.ctx.storage.sql.exec(
      `CREATE TABLE a_parent (id INTEGER PRIMARY KEY)`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE z_child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES a_parent(id)
      )`,
    );
    this.ctx.storage.sql.exec(`INSERT INTO a_parent VALUES (1)`);
    this.ctx.storage.sql.exec(`INSERT INTO z_child VALUES (1, 1)`);
  }

  userTables(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE '_cf_%'
         ORDER BY name`,
      )
      .toArray()
      .map((row) => row.name);
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

/** Shared implementation for the migration source and target kind. */
export class Tally extends DurableObject<Env> {
  readonly #capturedStorage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#capturedStorage = ctx.storage;
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS counts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL UNIQUE,
        value INTEGER NOT NULL
      )`,
    );
    ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS counts_by_value ON counts (value)`,
    );
  }

  bump(label: string, by = 1): number {
    return this.ctx.storage.sql
      .exec<{ value: number }>(
        `INSERT INTO counts (label, value) VALUES (?, ?)
         ON CONFLICT(label) DO UPDATE SET value = value + excluded.value
         RETURNING value`,
        label,
        by,
      )
      .one().value;
  }

  /** Sync self-call: breaks if a wrapper turns bump() async. */
  bumpAndRead(label: string): number {
    const value = this.bump(label);
    return value + 100;
  }

  removeLabel(label: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM counts WHERE label = ?`, label);
  }

  maxCountId(): number {
    return this.ctx.storage.sql
      .exec<{ m: number }>(`SELECT COALESCE(MAX(id), 0) AS m FROM counts`)
      .one().m;
  }

  /** A rowid-alias table whose INTEGER PRIMARY KEY is NOT the first column. */
  addEvent(ts: number, note: string): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
        ts INTEGER NOT NULL,
        id INTEGER PRIMARY KEY,
        note TEXT NOT NULL
      )`,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO events (ts, note) VALUES (?, ?)`,
      ts,
      note,
    );
  }

  events(): { ts: number; id: number; note: string }[] {
    return this.ctx.storage.sql
      .exec<{ ts: number; id: number; note: string }>(
        `SELECT ts, id, note FROM events ORDER BY id`,
      )
      .toArray();
  }

  async putRaw(key: string, value: string): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  async putThroughCapturedStorage(key: string, value: string): Promise<void> {
    await this.#capturedStorage.put(key, value);
  }

  async delayedSyncKvPut(
    key: string,
    value: string,
    delayMs: number,
  ): Promise<void> {
    await scheduler.wait(delayMs);
    this.ctx.storage.kv.put(key, value);
  }

  async getRaw(key: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(key);
  }

  total(): number {
    return this.ctx.storage.sql
      .exec<{ total: number }>(
        `SELECT COALESCE(SUM(value), 0) AS total FROM counts`,
      )
      .one().total;
  }

  async note(key: string, value: string): Promise<void> {
    await this.ctx.storage.put(`note:${key}`, value);
  }

  async getNote(key: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`note:${key}`);
  }

  async remindAt(timestamp: number): Promise<void> {
    await this.ctx.storage.setAlarm(timestamp);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.put("alarm-fired-at", Date.now());
  }

  async alarmFiredAt(): Promise<number | undefined> {
    return this.ctx.storage.get<number>("alarm-fired-at");
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response(`tally:${instanceName(this.ctx) ?? "?"}`);
  }

  /** A self-contained FTS5 table (Think-style conversation search). */
  addDoc(body: string): void {
    this.ctx.storage.sql.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(body)`,
    );
    this.ctx.storage.sql.exec(`INSERT INTO docs (body) VALUES (?)`, body);
  }

  searchDocs(query: string): string[] {
    return this.ctx.storage.sql
      .exec<{ body: string }>(`SELECT body FROM docs WHERE docs MATCH ?`, query)
      .toArray()
      .map((row) => row.body);
  }

  searchArticles(query: string): string[] {
    return this.ctx.storage.sql
      .exec<{ body: string }>(
        `SELECT body FROM articles_fts WHERE articles_fts MATCH ?`,
        query,
      )
      .toArray()
      .map((row) => row.body);
  }

  relationalRows(): { users: number; orders: number } {
    return {
      users: this.ctx.storage.sql
        .exec<{ n: number }>(`SELECT count(*) AS n FROM users`)
        .one().n,
      orders: this.ctx.storage.sql
        .exec<{ n: number }>(`SELECT count(*) AS n FROM orders`)
        .one().n,
    };
  }

  descendingPrimaryKeys(): number[] {
    return this.ctx.storage.sql
      .exec<{ id: number }>(`SELECT id FROM descending_ids ORDER BY id`)
      .toArray()
      .map((row) => row.id);
  }

  /** A table with STORED and VIRTUAL generated columns. */
  addPriced(name: string, cents: number): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS priced (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        cents INTEGER NOT NULL,
        dollars REAL GENERATED ALWAYS AS (cents / 100.0) STORED,
        upper_name TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL
      )`,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO priced (name, cents) VALUES (?, ?)`,
      name,
      cents,
    );
  }

  pricedRows(): { name: string; cents: number; dollars: number; upper_name: string }[] {
    return this.ctx.storage.sql
      .exec<{ name: string; cents: number; dollars: number; upper_name: string }>(
        `SELECT name, cents, dollars, upper_name FROM priced ORDER BY id`,
      )
      .toArray();
  }
}

/**
 * Simulates a framework base class (Agents SDK shape): the constructor
 * calls its own prototype methods, and a subclass constructor inspects the
 * prototype chain and refuses when one level owns both deprecated-pair
 * hooks. exportable() must not break either behavior.
 */
class FrameworkBase extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this._setup();
  }

  _setup(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS fw (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
    );
  }

  onStateChanged(): void {}
  onStateUpdate(): void {}
}

export class FrameworkImpl extends FrameworkBase {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Mimic the Agents SDK override detection: no single prototype level
    // between the instance and the framework base may own both hooks.
    let proto: object | null = Object.getPrototypeOf(this) as object;
    while (proto !== null && proto !== FrameworkBase.prototype) {
      const owns = (name: string) =>
        Object.prototype.hasOwnProperty.call(proto, name);
      if (owns("onStateChanged") && owns("onStateUpdate")) {
        throw new Error(
          "framework: Cannot override both onStateChanged and onStateUpdate.",
        );
      }
      proto = Object.getPrototypeOf(proto);
    }
  }

  setEntry(k: string, v: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO fw (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      k,
      v,
    );
  }

  getEntry(k: string): string | undefined {
    const rows = this.ctx.storage.sql
      .exec<{ v: string }>(`SELECT v FROM fw WHERE k = ?`, k)
      .toArray();
    return rows[0]?.v;
  }
}

/** The old binding's class: the same behavior, plus the export surface. */
export class LegacyTally extends exportable(Tally) {}

/** A framework-shaped old binding. */
export class LegacyFramework extends exportable(FrameworkImpl) {}

export class AppDO extends union(
  {
    counter: Counter,
    echo: Echo,
    reminder: Reminder,
    plain: Plain,
    teapot: Teapot,
    brokenConstructor: BrokenConstructor,
    vault: Vault,
    party: PartyRoom,
    tally: Tally,
    fw: FrameworkImpl,
  },
  { importable: ["tally", "fw"] },
) {}

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
