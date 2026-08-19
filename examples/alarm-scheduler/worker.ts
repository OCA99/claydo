/**
 * alarm-scheduler example for claydo.
 *
 * One kind, `scheduler`, multiplexes many named logical timers over the
 * single Durable Object alarm, Cloudflare-Actors style. Jobs live in a
 * SQLite `jobs` table; the DO alarm is always armed for the earliest job.
 * Each alarm invocation fires the single earliest due job, records it into
 * a `fired` table, and re-arms for the next job (immediately, if the next
 * job is already due).
 */
import { DurableObject } from "cloudflare:workers";
import { instanceName, kind, union } from "../../src/index";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
}

// NOTE: these must be type aliases, not interfaces. `sql.exec<T>` requires
// `T extends Record<string, SqlStorageValue>`, and TypeScript only grants
// implicit index signatures to object literal types, not interfaces.
export type Job = {
  name: string;
  at: number;
};

export type FiredJob = {
  seq: number;
  name: string;
  at: number;
  firedAt: number;
};

export class Scheduler extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS jobs (
        name TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      )`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS fired (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        at INTEGER NOT NULL,
        firedAt INTEGER NOT NULL
      )`,
    );
  }

  /**
   * Schedules (or reschedules) a named logical timer. `when` is either an
   * absolute epoch-milliseconds timestamp or `{ delayMs }`.
   */
  async schedule(name: string, when: number | { delayMs: number }): Promise<Job> {
    const at = typeof when === "number" ? when : Date.now() + when.delayMs;
    this.ctx.storage.sql.exec(
      `INSERT INTO jobs (name, at) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET at = excluded.at`,
      name,
      at,
    );
    await this.#arm();
    return { name, at };
  }

  /** Cancels a logical timer. Returns whether it existed. */
  async cancel(name: string): Promise<boolean> {
    const existed =
      this.ctx.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE name = ?`, name)
        .one().n > 0;
    if (existed) {
      this.ctx.storage.sql.exec(`DELETE FROM jobs WHERE name = ?`, name);
      await this.#arm();
    }
    return existed;
  }

  /** Lists pending jobs, earliest first. */
  list(): Job[] {
    return this.ctx.storage.sql
      .exec<Job>(`SELECT name, at FROM jobs ORDER BY at, name`)
      .toArray();
  }

  /** Lists fired jobs in firing order, so tests can assert ordering. */
  fired(): FiredJob[] {
    return this.ctx.storage.sql
      .exec<FiredJob>(`SELECT seq, name, at, firedAt FROM fired ORDER BY seq`)
      .toArray();
  }

  /** Returns the currently armed DO alarm time, if any. */
  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** The logical instance name, to demonstrate `instanceName()`. */
  whoAmI(): string | undefined {
    return instanceName(this.ctx);
  }

  /**
   * DX-probe helper: aborts the Durable Object so the next access hits a
   * cold instance (fresh constructor, kind resolved from storage again).
   * The in-flight RPC call dies with the abort, so callers must catch.
   */
  crash(): never {
    this.ctx.abort("scheduler crashed on purpose");
    throw new Error("unreachable");
  }

  /** DX-probe helper: wipes all storage, including the library's kind key. */
  async wipeStorage(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    // DX probe hook: a job named "poison" makes alarm() throw, so tests can
    // observe how kind-alarm errors surface. Checked before the due filter
    // so a forced `runDurableObjectAlarm` triggers it deterministically.
    const poisoned = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE name = 'poison'`)
      .one().n;
    if (poisoned > 0) throw new Error("poison job exploded");

    const now = Date.now();
    const due = this.ctx.storage.sql
      .exec<Job>(
        `SELECT name, at FROM jobs WHERE at <= ? ORDER BY at, name LIMIT 1`,
        now,
      )
      .toArray();
    const job = due[0];
    if (job !== undefined) {
      this.ctx.storage.sql.exec(`DELETE FROM jobs WHERE name = ?`, job.name);
      this.ctx.storage.sql.exec(
        `INSERT INTO fired (name, at, firedAt) VALUES (?, ?, ?)`,
        job.name,
        job.at,
        now,
      );
    }
    await this.#arm();
  }

  /** Arms the single DO alarm for the earliest pending job, or clears it. */
  async #arm(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<Job>(`SELECT name, at FROM jobs ORDER BY at, name LIMIT 1`)
      .toArray()[0];
    if (next === undefined) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(next.at);
    }
  }
}

export class AppDO extends union({
  scheduler: Scheduler,
}) {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Tiny HTTP facade: POST /schedule/:instance/:job?delayMs=1000
    const url = new URL(request.url);
    const [, action, instance, job] = url.pathname.split("/");
    if (action === "schedule" && instance && job) {
      const delayMs = Number(url.searchParams.get("delayMs") ?? "1000");
      const scheduler = kind(env.APP_DO, "scheduler").get(instance);
      return Response.json(await scheduler.schedule(job, { delayMs }));
    }
    if (action === "list" && instance) {
      return Response.json(await kind(env.APP_DO, "scheduler").get(instance).list());
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
