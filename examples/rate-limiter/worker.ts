import { DurableObject } from "cloudflare:workers";
import { kinds, union } from "../../src/index";

export interface Env {
  APP_DO: DurableObjectNamespace<RateLimiterDO>;
}

export interface TakeResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

const DEFAULT_CAPACITY = 10;
const DEFAULT_REFILL_PER_SEC = 1;

// NOTE: `type`, not `interface`: interfaces lack the implicit index signature
// that workers-types' sql.exec<T> constraint requires.
type BucketRow = {
  capacity: number;
  refill_per_sec: number;
  tokens: number;
  updated_ms: number;
};

/**
 * A token bucket. One instance per API key (the instance name is the key).
 * Refill is computed on demand from elapsed time — no alarms. Config and
 * level live in the instance's own SQLite database, so they survive
 * eviction and restarts.
 */
export class Bucket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    Bucket.#ensureSchema(ctx);
  }

  static #ensureSchema(ctx: DurableObjectState): void {
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS bucket (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        capacity REAL NOT NULL,
        refill_per_sec REAL NOT NULL,
        tokens REAL NOT NULL,
        updated_ms INTEGER NOT NULL
      )`,
    );
  }

  /** Sets the config and refills the bucket to the new capacity. */
  async configure(capacity: number, refillPerSec: number): Promise<void> {
    if (capacity <= 0 || refillPerSec <= 0) {
      // `code` is an own enumerable field, so it survives Workers RPC.
      throw Object.assign(
        new RangeError(
          `configure(capacity, refillPerSec) requires positive numbers, got (${capacity}, ${refillPerSec})`,
        ),
        { code: "ERR_BAD_BUCKET_CONFIG" },
      );
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO bucket (id, capacity, refill_per_sec, tokens, updated_ms)
       VALUES (1, ?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET
         capacity = ?1, refill_per_sec = ?2, tokens = ?3, updated_ms = ?4`,
      capacity,
      refillPerSec,
      capacity,
      await this.#now(),
    );
  }

  async take(n = 1): Promise<TakeResult> {
    const now = await this.#now();
    const row = this.#row() ?? this.#initDefault(now);
    const elapsedSec = Math.max(0, now - row.updated_ms) / 1000;
    let tokens = Math.min(
      row.capacity,
      row.tokens + elapsedSec * row.refill_per_sec,
    );
    let allowed = false;
    let retryAfterMs = 0;
    if (tokens >= n) {
      allowed = true;
      tokens -= n;
    } else {
      retryAfterMs = Math.ceil(((n - tokens) / row.refill_per_sec) * 1000);
    }
    this.ctx.storage.sql.exec(
      `UPDATE bucket SET tokens = ?, updated_ms = ? WHERE id = 1`,
      tokens,
      now,
    );
    return { allowed, remaining: Math.floor(tokens), retryAfterMs };
  }

  config(): { capacity: number; refillPerSec: number } {
    const row = this.#row();
    return row === undefined
      ? { capacity: DEFAULT_CAPACITY, refillPerSec: DEFAULT_REFILL_PER_SEC }
      : { capacity: row.capacity, refillPerSec: row.refill_per_sec };
  }

  /**
   * Wipes this bucket back to defaults. deleteAll() clears only this
   * kind's tables and key-value data; the SQL schema goes with them, so
   * recreate it.
   */
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
    Bucket.#ensureSchema(this.ctx);
  }

  /**
   * Test hook: shifts this bucket's clock forward. Persisted in KV storage
   * so refill tests need no real timers.
   */
  async advanceClock(ms: number): Promise<void> {
    const skew = (await this.ctx.storage.get<number>("clockSkewMs")) ?? 0;
    await this.ctx.storage.put("clockSkewMs", skew + ms);
  }

  async #now(): Promise<number> {
    const skew = (await this.ctx.storage.get<number>("clockSkewMs")) ?? 0;
    return Date.now() + skew;
  }

  #row(): BucketRow | undefined {
    return this.ctx.storage.sql
      .exec<BucketRow>(
        `SELECT capacity, refill_per_sec, tokens, updated_ms FROM bucket WHERE id = 1`,
      )
      .toArray()[0];
  }

  #initDefault(now: number): BucketRow {
    const row: BucketRow = {
      capacity: DEFAULT_CAPACITY,
      refill_per_sec: DEFAULT_REFILL_PER_SEC,
      tokens: DEFAULT_CAPACITY,
      updated_ms: now,
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO bucket (id, capacity, refill_per_sec, tokens, updated_ms)
       VALUES (1, ?, ?, ?, ?)`,
      row.capacity,
      row.refill_per_sec,
      row.tokens,
      row.updated_ms,
    );
    return row;
  }
}

export class RateLimiterDO extends union({ bucket: Bucket }) {}
export const RateLimiterDOFacet = RateLimiterDO.Facet;

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "limits" || parts[1] === undefined) {
      return new Response("not found", { status: 404 });
    }
    const bucket = kinds(env.APP_DO).bucket.get(parts[1]);

    if (parts[2] === "config" && request.method === "PUT") {
      const { capacity, refillPerSec } = await request.json<{
        capacity: number;
        refillPerSec: number;
      }>();
      await bucket.configure(capacity, refillPerSec);
      return Response.json({ ok: true });
    }

    if (parts[2] === "take" && request.method === "POST") {
      const n = Number(url.searchParams.get("n") ?? "1");
      const result = await bucket.take(n);
      return Response.json(result, {
        status: result.allowed ? 200 : 429,
        headers: result.allowed
          ? undefined
          : { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) },
      });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
