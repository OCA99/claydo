/**
 * counter-fleet example for claydo.
 *
 * Actors-style "manage instances" pattern with TWO kinds in one host class:
 *
 * - `registry`: a singleton (by convention `get("main")`) that creates
 *   counter instances with `kind(env.APP_DO, "counter").unique()` from
 *   INSIDE the Durable Object, stores their ids + labels in its own SQLite,
 *   and exposes createCounter / listCounters / deleteCounter.
 * - `counter`: a tiny per-instance counter with increment / value, plus a
 *   destroy() that wipes its storage.
 *
 * On deletion: there is no true "delete a Durable Object instance" API in
 * Workers. The realistic best effort is `storage.deleteAll()` (+
 * `deleteAlarm()`), after which the instance is an empty shell that is never
 * addressed again once the registry forgets its id. Calling `ctx.abort()`
 * additionally evicts it from memory, but it kills the in-flight RPC, so the
 * caller cannot get a return value from the same call. The registry here
 * uses deleteAll-then-forget; a separate `nuke()` method demonstrates the
 * abort variant for comparison.
 */
import { DurableObject, kind, resetStorage, union } from "../../src/index";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
}

export type CounterRecord = {
  label: string;
  id: string;
  createdAt: number;
};

export class Counter extends DurableObject<Env> {
  /** Test surface: a plain public property, to see how the stub reports it. */
  flavor = "vanilla";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    Counter.#ensureSchema(this.ctx);
  }

  static #ensureSchema(ctx: DurableObjectState): void {
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS counter (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 0),
        value INTEGER NOT NULL
      )`,
    );
    ctx.storage.sql.exec(
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
   * Deletes facet-local user data. Supervisor kind identity is unaffected;
   * this method recreates its own SQL schema before returning.
   */
  async destroy(): Promise<void> {
    await resetStorage(this.ctx);
    Counter.#ensureSchema(this.ctx);
  }

  /**
   * Explicitly clears data and aborts the facet. The in-flight call fails,
   * but the stable supervisor stub starts a replacement facet next time.
   */
  async nuke(): Promise<never> {
    await this.ctx.storage.deleteAll();
    this.ctx.abort("counter nuked");
    throw new Error("unreachable");
  }

  /** Test surface: evict the instance from memory without touching storage. */
  crash(): never {
    this.ctx.abort("counter crashed on purpose");
    throw new Error("unreachable");
  }

  /** Test surface: a return value that structured clone cannot serialize. */
  weird(): object {
    class Unserializable {
      value = 42;
    }
    return new Unserializable();
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
      // A named error with an own enumerable field, to verify how much error
      // fidelity survives the RPC envelope.
      const error = new Error(`registry: label '${label}' already exists`);
      error.name = "DuplicateLabelError";
      (error as Error & { label: string }).label = label;
      throw error;
    }
    // Create the instance from INSIDE the DO. unique() only mints an id;
    // the first RPC pins the kind in supervisor storage.
    const counter = kind(this.env.APP_DO, "counter").unique();
    await counter.increment(0); // touch it so the kind is persisted
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

/** Test surface: a kind whose constructor throws. What does the caller see? */
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
  // Test surface: the same class registered under a second kind name. Instances
  // are disjoint (different name prefix -> different ids), and the pinned
  // kind string differs, so "tally" counters are not "counter" counters.
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
