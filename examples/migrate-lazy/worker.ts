/**
 * migrate-lazy — a rate-limiter fleet moving into a claydo kind with the
 * transitional router.
 *
 * The story: a legacy Worker ran two Durable Object bindings —
 * `OLD_BUCKETS` (a token bucket per API key) and `OLD_SESSIONS` (per-user
 * session state). Both move into the single claydo host `LIMITER_DO`:
 *
 * - `bucket` migrates with the `lazy` strategy: the first request that
 *   touches an old bucket migrates it inline, then serves the new instance.
 * - `session` migrates with the `drain` strategy: old sessions keep serving
 *   on the old binding until they expire; new session names go straight to
 *   the kind.
 *
 * The Worker's fetch handler routes production-style traffic through the
 * `migrated()` facades exactly as a real cutover would.
 */

import { DurableObject, kind, union } from "../../src/index";
import {
  exportable,
  migrated,
  type MigratedAccessor,
} from "../../src/migrate";

export interface Env {
  LIMITER_DO: DurableObjectNamespace<LimiterDO>;
  OLD_BUCKETS: DurableObjectNamespace<OldBucket>;
  OLD_SESSIONS: DurableObjectNamespace<OldSession>;
}

export interface TakeResult {
  allowed: boolean;
  remaining: number;
}

/**
 * A token bucket per API key. SQLite-backed so the migration exercises the
 * row-streaming path. Refill is time-based; tests use refillPerSec 0 for
 * determinism.
 */
export class Bucket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS bucket (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tokens REAL NOT NULL,
        capacity REAL NOT NULL,
        refill_per_sec REAL NOT NULL,
        updated_ms INTEGER NOT NULL
      )`,
    );
  }

  #row():
    | { tokens: number; capacity: number; refill_per_sec: number; updated_ms: number }
    | undefined {
    return this.ctx.storage.sql
      .exec<{
        tokens: number;
        capacity: number;
        refill_per_sec: number;
        updated_ms: number;
      }>(`SELECT tokens, capacity, refill_per_sec, updated_ms FROM bucket WHERE id = 1`)
      .toArray()[0];
  }

  #refilled(): { tokens: number; capacity: number; rate: number } {
    const row = this.#row();
    if (row === undefined) return { tokens: 10, capacity: 10, rate: 1 };
    const now = Date.now();
    const tokens = Math.min(
      row.capacity,
      row.tokens + ((now - row.updated_ms) / 1000) * row.refill_per_sec,
    );
    return { tokens, capacity: row.capacity, rate: row.refill_per_sec };
  }

  #store(tokens: number, capacity: number, rate: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO bucket (id, tokens, capacity, refill_per_sec, updated_ms)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         tokens = excluded.tokens,
         capacity = excluded.capacity,
         refill_per_sec = excluded.refill_per_sec,
         updated_ms = excluded.updated_ms`,
      tokens,
      capacity,
      rate,
      Date.now(),
    );
  }

  configure(capacity: number, refillPerSec: number): void {
    this.#store(capacity, capacity, refillPerSec);
  }

  take(n = 1): TakeResult {
    const { tokens, capacity, rate } = this.#refilled();
    if (tokens < n) {
      this.#store(tokens, capacity, rate);
      return { allowed: false, remaining: Math.floor(tokens) };
    }
    this.#store(tokens - n, capacity, rate);
    return { allowed: true, remaining: Math.floor(tokens - n) };
  }

  remaining(): number {
    return Math.floor(this.#refilled().tokens);
  }

  /** Raw deleteAll, used by a probe to attempt "wipe the new instance". */
  async nuke(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return Response.json({ remaining: this.remaining() });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "take") {
      ws.send(JSON.stringify(this.take(1)));
      return;
    }
    ws.send(JSON.stringify({ remaining: this.remaining() }));
  }
}

/** Per-user session state, KV-backed to exercise the KV migration path. */
export class Session extends DurableObject<Env> {
  async setValue(key: string, value: string): Promise<void> {
    await this.ctx.storage.put(`s:${key}`, value);
  }

  async getValue(key: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`s:${key}`);
  }
}

/** The legacy bindings: the same classes, plus the export surface. */
export class OldBucket extends exportable(Bucket) {}
export class OldSession extends exportable(Session) {}

/** The claydo host that both legacy fleets migrate into. */
export class LimiterDO extends union(
  { bucket: Bucket, session: Session },
  { importable: ["bucket", "session"] },
) {}

// Facades are per-isolate singletons, as production code would hold them.
let bucketFacade: MigratedAccessor<Bucket> | undefined;
let sessionFacade: MigratedAccessor<Session> | undefined;

export function buckets(env: Env): MigratedAccessor<Bucket> {
  bucketFacade ??= migrated(env.OLD_BUCKETS, kind(env.LIMITER_DO, "bucket"), {
    strategy: "lazy",
  });
  return bucketFacade;
}

export function sessions(env: Env): MigratedAccessor<Session> {
  sessionFacade ??= migrated(env.OLD_SESSIONS, kind(env.LIMITER_DO, "session"), {
    strategy: "drain",
  });
  return sessionFacade;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter((p) => p.length > 0);

    // POST /limit/:key — consume one token for an API key.
    if (parts[0] === "limit" && parts[1] !== undefined) {
      const bucket = buckets(env).get(parts[1]);
      if (request.method === "PUT" && parts[2] === "config") {
        const body = (await request.json()) as {
          capacity: number;
          refillPerSec: number;
        };
        await bucket.configure(body.capacity, body.refillPerSec);
        return Response.json({ ok: true });
      }
      if (request.method === "POST") {
        const result = await bucket.take(1);
        return Response.json(result, { status: result.allowed ? 200 : 429 });
      }
      return Response.json({ remaining: await bucket.remaining() });
    }

    // GET /ws/:key — WebSocket onto the bucket, through the facade.
    if (parts[0] === "ws" && parts[1] !== undefined) {
      return buckets(env).get(parts[1]).fetch(request);
    }

    // POST /session/:id { key, value } / GET /session/:id?key=...
    if (parts[0] === "session" && parts[1] !== undefined) {
      const session = sessions(env).get(parts[1]);
      if (request.method === "POST") {
        const body = (await request.json()) as { key: string; value: string };
        await session.setValue(body.key, body.value);
        return Response.json({ ok: true });
      }
      const key = url.searchParams.get("key") ?? "";
      return Response.json({ value: (await session.getValue(key)) ?? null });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
