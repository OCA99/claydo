/**
 * counter-fleet: an actors-style fleet of counters managed by a registry.
 *
 * Two kinds share one Durable Object class:
 *
 * - `registry`: a singleton by convention (`get("main")`). It creates
 *   unique counter instances from inside the Durable Object, stores their
 *   ids with labels in its own SQLite database, and exposes
 *   create / list / increment / delete.
 * - `counter`: a per-instance counter with increment / value / destroy.
 *
 * Workers has no API that deletes a Durable Object instance. destroy()
 * wipes the counter's data with `storage.deleteAll()` and re-creates the
 * schema, so the instance keeps serving (from zero); the registry then
 * forgets the id, and nothing addresses the instance again.
 */
import { DurableObject } from "cloudflare:workers";
import { kind, union } from "../../src/index";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
}

export type CounterRecord = {
  label: string;
  id: string;
  createdAt: number;
};

export class Counter extends DurableObject<Env> {
  /** A plain public property. The stub proxies prototype methods only. */
  flavor = "vanilla";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ensureSchema();
  }

  #ensureSchema(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS counter (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 0),
        value INTEGER NOT NULL
      )`,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO counter (singleton, value) VALUES (0, 0)`,
    );
  }

  increment(by = 1): number {
    return this.ctx.storage.sql
      .exec<{ value: number }>(
        `UPDATE counter SET value = value + ? RETURNING value`,
        by,
      )
      .one().value;
  }

  value(): number {
    return this.ctx.storage.sql
      .exec<{ value: number }>(`SELECT value FROM counter`)
      .one().value;
  }

  /**
   * Best-effort deletion. `deleteAll()` clears this kind instance's tables
   * and key-value data but keeps its identity, so the schema is re-created
   * right away and the instance stays healthy if anything reaches it again.
   */
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.#ensureSchema();
  }
}

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS counters (
        label TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      )`,
    );
  }

  /** Creates a unique counter instance and records its id under a label. */
  async createCounter(label: string): Promise<CounterRecord> {
    const existing = this.#find(label);
    if (existing !== undefined) {
      // A named error with an own field. Both survive the RPC hop, so
      // callers can match on error.name and read error.label.
      const error = new Error(`registry: label '${label}' already exists`);
      error.name = "DuplicateLabelError";
      (error as Error & { label: string }).label = label;
      throw error;
    }
    // Create the instance from inside the Durable Object. unique() mints
    // an id; the first call pins the kind on the new instance.
    const counter = kind(this.env.APP_DO, "counter").unique();
    await counter.increment(0);
    const record: CounterRecord = {
      label,
      id: counter.id.toString(),
      createdAt: Date.now(),
    };
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (label, id, createdAt) VALUES (?, ?, ?)`,
      record.label,
      record.id,
      record.createdAt,
    );
    return record;
  }

  listCounters(): CounterRecord[] {
    return this.ctx.storage.sql
      .exec<CounterRecord>(
        `SELECT label, id, createdAt FROM counters ORDER BY createdAt, label`,
      )
      .toArray();
  }

  /** Increments a counter by label, resolving the stored unique id. */
  async incrementCounter(label: string, by = 1): Promise<number> {
    const record = this.#mustFind(label);
    return kind(this.env.APP_DO, "counter").fromId(record.id).increment(by);
  }

  async counterValue(label: string): Promise<number> {
    const record = this.#mustFind(label);
    return kind(this.env.APP_DO, "counter").fromId(record.id).value();
  }

  /**
   * Deletes a counter: wipes its storage, then forgets its id. Returns
   * whether the label existed.
   */
  async deleteCounter(label: string): Promise<boolean> {
    const record = this.#find(label);
    if (record === undefined) return false;
    await kind(this.env.APP_DO, "counter").fromId(record.id).destroy();
    this.ctx.storage.sql.exec(`DELETE FROM counters WHERE label = ?`, label);
    return true;
  }

  #find(label: string): CounterRecord | undefined {
    return this.ctx.storage.sql
      .exec<CounterRecord>(
        `SELECT label, id, createdAt FROM counters WHERE label = ?`,
        label,
      )
      .toArray()[0];
  }

  #mustFind(label: string): CounterRecord {
    const record = this.#find(label);
    if (record === undefined) {
      throw new Error(`registry: no counter labelled '${label}'`);
    }
    return record;
  }
}

/**
 * A kind whose constructor throws. Kinds need no DurableObject base: any
 * class with a (ctx, env) constructor works. Callers see a constructor
 * failure on every call.
 */
export class BrokenKind {
  constructor(_ctx: DurableObjectState, _env: Env) {
    throw new Error("BrokenKind constructor exploded: missing config");
  }

  ping(): string {
    return "pong";
  }
}

export class AppDO extends union({
  registry: Registry,
  counter: Counter,
  // The same class under a second kind name. Instances are disjoint:
  // different name prefixes map to different ids, and each instance is
  // pinned to one kind, so "tally" counters are not "counter" counters.
  tally: Counter,
  broken: BrokenKind,
}) {}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const registry = kind(env.APP_DO, "registry").get("main");
    const [, action, label] = url.pathname.split("/");
    if (request.method === "POST" && action === "counters" && label) {
      return Response.json(await registry.createCounter(label));
    }
    if (request.method === "POST" && action === "increment" && label) {
      return Response.json({ value: await registry.incrementCounter(label) });
    }
    if (request.method === "GET" && action === "counters") {
      return Response.json(await registry.listCounters());
    }
    if (request.method === "DELETE" && action === "counters" && label) {
      return Response.json({ deleted: await registry.deleteCounter(label) });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
