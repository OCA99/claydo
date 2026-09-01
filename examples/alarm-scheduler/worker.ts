/**
 * alarm-scheduler example for claydo.
 *
 * One kind, `scheduler`, multiplexes many named jobs over its instance's
 * single alarm. Jobs live in a SQLite `jobs` table, and the alarm is always
 * armed for the earliest job. Each alarm invocation runs the earliest due
 * job, records it in a `fired` table, and re-arms for the next job
 * (immediately, if the next job is already due).
 */
import { DurableObject } from "cloudflare:workers";
import { instanceName, kinds, union } from "../../src/index";

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
  /** SQLite boolean (0/1): whether the job fired on an alarm retry. */
  wasRetry: number;
};

export class Scheduler extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ensureSchema();
  }

  #ensureSchema(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS jobs (
        name TEXT PRIMARY KEY,
        at INTEGER NOT NULL
      )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS fired (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        at INTEGER NOT NULL,
        firedAt INTEGER NOT NULL,
        wasRetry INTEGER NOT NULL DEFAULT 0
      )`,
    );
  }

  /**
   * Schedules (or reschedules) a named job. `when` is either an absolute
   * epoch-milliseconds timestamp or `{ delayMs }`.
   */
  async schedule(
    name: string,
    when: number | { delayMs: number },
  ): Promise<Job> {
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

  /** Cancels a job. Returns whether it existed. */
  async cancel(name: string): Promise<boolean> {
    const existed =
      this.ctx.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM jobs WHERE name = ?`,
          name,
        )
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

  /** Lists fired jobs in firing order. */
  fired(): FiredJob[] {
    return this.ctx.storage.sql
      .exec<FiredJob>(
        `SELECT seq, name, at, firedAt, wasRetry FROM fired ORDER BY seq`,
      )
      .toArray();
  }

  /** Returns the currently armed alarm time, if any. */
  async alarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** Cancels the armed alarm without touching the jobs table. */
  async disarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }

  /** The logical instance name, via `instanceName()`. */
  whoAmI(): string | undefined {
    return instanceName(this.ctx);
  }

  /**
   * Makes the next alarm invocation throw once. Alarm delivery is
   * at-least-once: a throwing handler keeps the pending jobs and retries
   * through the platform's native retry, so the job still runs.
   */
  failNextRun(): void {
    this.ctx.storage.kv.put("failNext", true);
  }

  /**
   * Wipes the scheduler's tables and key-value data, then recreates the
   * schema. `deleteAll()` keeps a pending alarm (same as native Durable
   * Objects); call `disarm()` to cancel it.
   */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.#ensureSchema();
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    // Clear the failure flag before throwing, so the retry succeeds.
    if (this.ctx.storage.kv.get("failNext")) {
      this.ctx.storage.kv.delete("failNext");
      throw new Error("scheduler: induced failure");
    }

    const now = Date.now();
    const job = this.ctx.storage.sql
      .exec<Job>(
        `SELECT name, at FROM jobs WHERE at <= ? ORDER BY at, name LIMIT 1`,
        now,
      )
      .toArray()[0];
    if (job !== undefined) {
      this.ctx.storage.sql.exec(`DELETE FROM jobs WHERE name = ?`, job.name);
      this.ctx.storage.sql.exec(
        `INSERT INTO fired (name, at, firedAt, wasRetry) VALUES (?, ?, ?, ?)`,
        job.name,
        job.at,
        now,
        alarmInfo?.isRetry ? 1 : 0,
      );
    }
    await this.#arm();
  }

  /**
   * Arms the alarm for the earliest pending job, or clears it. Re-arming
   * inside `alarm()` is fine: a handler that re-schedules its own alarm
   * keeps the new time.
   */
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
export const AppDOFacet = AppDO.Facet;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Tiny HTTP facade: POST /schedule/:instance/:job?delayMs=1000
    const url = new URL(request.url);
    const [, action, instance, job] = url.pathname.split("/");
    const app = kinds(env.APP_DO);
    if (action === "schedule" && instance && job) {
      const delayMs = Number(url.searchParams.get("delayMs") ?? "1000");
      const scheduler = app.scheduler.get(instance);
      return Response.json(await scheduler.schedule(job, { delayMs }));
    }
    if (action === "list" && instance) {
      return Response.json(await app.scheduler.get(instance).list());
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
