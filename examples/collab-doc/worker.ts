import { DurableObject, instanceName, kind, union } from "../../src/index";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
}

export type Op =
  | { type: "insert"; pos: number; text: string }
  | { type: "delete"; pos: number; len: number };

export interface DocStats {
  opCount: number;
  snapshotVersion: number;
  textLength: number;
  alarmScheduled: boolean;
}

/** How long after the first uncompacted op the compaction alarm fires. */
export const COMPACT_AFTER_MS = 30_000;

/** Applies one op to a text, throwing on out-of-range positions. */
function apply(text: string, op: Op): string {
  if (op.type === "insert") {
    if (!Number.isInteger(op.pos) || op.pos < 0 || op.pos > text.length) {
      // Structured fields verify enumerable error metadata over RPC.
      throw Object.assign(
        new Error(
          `collab-doc: insert position ${op.pos} out of range 0..${text.length}`,
        ),
        { code: "E_RANGE", pos: op.pos },
      );
    }
    return text.slice(0, op.pos) + op.text + text.slice(op.pos);
  }
  if (!Number.isInteger(op.pos) || op.pos < 0 || op.pos + op.len > text.length) {
    throw Object.assign(
      new Error(
        `collab-doc: delete range ${op.pos}..${op.pos + op.len} out of range 0..${text.length}`,
      ),
      { code: "E_RANGE", pos: op.pos },
    );
  }
  return text.slice(0, op.pos) + text.slice(op.pos + op.len);
}


export class SnapshotHandle {
  constructor(readonly version: number) {}
  describe(): string {
    return `snapshot v${this.version}`;
  }
}

/**
 * A collaborative text document. WebSocket clients send ops; the DO appends
 * them to a SQLite op log, applies them to the text, and broadcasts them to
 * the other clients. An alarm periodically compacts the op log into a
 * snapshot row. RPC (`getText`, `getStats`, `applyOp`) works alongside the
 * WebSocket protocol.
 */
export class Doc extends DurableObject<Env> {
  #text: string | undefined;
  #ctorNameProbe: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ops (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        op TEXT NOT NULL
      )`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        version INTEGER NOT NULL,
        text TEXT NOT NULL
      )`,
    );
    ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO snapshot (id, version, text) VALUES (0, 0, '')`,
    );
    // constructor because ctx.id.name is not available there. Verify.
    try {
      this.#ctorNameProbe = `value: ${String(instanceName(ctx))}`;
    } catch (error) {
      this.#ctorNameProbe = `threw: ${String(error)}`;
    }
  }

  #currentText(): string {
    if (this.#text === undefined) {
      let text = this.ctx.storage.sql
        .exec<{ text: string }>(`SELECT text FROM snapshot WHERE id = 0`)
        .one().text;
      for (const row of this.ctx.storage.sql.exec<{ op: string }>(
        `SELECT op FROM ops ORDER BY seq`,
      )) {
        text = apply(text, JSON.parse(row.op) as Op);
      }
      this.#text = text;
    }
    return this.#text;
  }

  /** Applies and logs one op. Schedules the compaction alarm if none is set. */
  async #append(op: Op): Promise<number> {
    const next = apply(this.#currentText(), op);
    const seq = this.ctx.storage.sql
      .exec<{ seq: number }>(
        `INSERT INTO ops (op) VALUES (?) RETURNING seq`,
        JSON.stringify(op),
      )
      .one().seq;
    this.#text = next;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + COMPACT_AFTER_MS);
    }
    return seq;
  }

  #broadcast(payload: unknown, exclude?: WebSocket): void {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== exclude) socket.send(message);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(
        JSON.stringify({ type: "init", text: this.#currentText() }),
      );
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return Response.json({ text: this.#currentText() });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;
    let parsed: Op | { type: "boom" };
    try {
      parsed = JSON.parse(message) as Op | { type: "boom" };
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
      return;
    }
    // look like to the client and the test runner?
    if (parsed.type === "boom") {
      throw new Error("doc kind: deliberate failure inside webSocketMessage");
    }
    try {
      const seq = await this.#append(parsed);
      ws.send(JSON.stringify({ type: "ack", seq }));
      this.#broadcast({ type: "op", seq, op: parsed }, ws);
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /** Compacts the op log into the snapshot row. */
  async alarm(): Promise<void> {
    const text = this.#currentText();
    this.ctx.storage.sql.exec(
      `UPDATE snapshot SET version = version + 1, text = ? WHERE id = 0`,
      text,
    );
    this.ctx.storage.sql.exec(`DELETE FROM ops`);
  }

  getText(): string {
    return this.#currentText();
  }

  async getStats(): Promise<DocStats> {
    const opCount = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ops`)
      .one().n;
    const snapshotVersion = this.ctx.storage.sql
      .exec<{ version: number }>(`SELECT version FROM snapshot WHERE id = 0`)
      .one().version;
    return {
      opCount,
      snapshotVersion,
      textLength: this.#currentText().length,
      alarmScheduled: (await this.ctx.storage.getAlarm()) !== null,
    };
  }

  /** RPC editing path. Throws on invalid ops; pushes to WebSocket clients. */
  async applyOp(op: Op): Promise<{ seq: number; text: string }> {
    const seq = await this.#append(op);
    this.#broadcast({ type: "op", seq, op });
    return { seq, text: this.#currentText() };
  }


  constructorNameProbe(): string {
    return this.#ctorNameProbe;
  }


  getHandle(): SnapshotHandle {
    const version = this.ctx.storage.sql
      .exec<{ version: number }>(`SELECT version FROM snapshot WHERE id = 0`)
      .one().version;
    return new SnapshotHandle(version);
  }


  getCallback(): () => void {
    return () => {};
  }
}

export class AppDO extends union({
  doc: Doc,
}) {}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/doc\/([^/]+)$/.exec(url.pathname);
    if (match !== null && match[1] !== undefined) {
      return kind(env.APP_DO, "doc").get(match[1]).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
