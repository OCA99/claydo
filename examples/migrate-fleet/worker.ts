/**
 * migrate-fleet — a bulk migration of an existing Durable Object binding
 * (`OLD_SESSIONS`, class `OldSession`) into the `session` kind of a claydo
 * host (`APP_DO`), with `manual` routing during the transition.
 *
 * A second binding pair (`OLD_SECURE` → `SECURE_DO`) is configured with a
 * shared migration secret, to exercise the cross-Worker authentication
 * story. (In this test harness everything lives in one Worker; the secret
 * plumbing is identical.)
 */
import { DurableObject, instanceName, kinds, union } from "../../src/index";
import { exportable, migrated } from "../../src/migrate";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
  OLD_SESSIONS: DurableObjectNamespace<OldSession>;
  SECURE_DO: DurableObjectNamespace<SecureDO>;
  OLD_SECURE: DurableObjectNamespace<OldSecureSession>;
}

// A type alias (not an interface): sql.exec<T> constrains T to
// Record<string, SqlStorageValue>, and only anonymous object types get the
// implicit index signature that satisfies it.
export type SessionEvent = {
  id: number;
  type: string;
  payload: string;
  at: number;
};

/**
 * The "finished" session class: SQLite (an AUTOINCREMENT `events` table and
 * a plain `tags` table), KV preferences under `pref:` keys, and an alarm.
 * This is the class that used to run as its own binding; after migration it
 * serves as the kind implementation, unchanged.
 */
export class SessionImpl extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        at INTEGER NOT NULL
      )`,
    );
    ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS events_by_type ON events (type)`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS tags (label TEXT NOT NULL)`,
    );
  }

  record(type: string, payload: string): number {
    return this.ctx.storage.sql
      .exec<{ id: number }>(
        `INSERT INTO events (type, payload, at) VALUES (?, ?, ?) RETURNING id`,
        type,
        payload,
        Date.now(),
      )
      .one().id;
  }

  history(): SessionEvent[] {
    return this.ctx.storage.sql
      .exec<SessionEvent>(`SELECT id, type, payload, at FROM events ORDER BY id`)
      .toArray();
  }

  eventCount(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM events`)
      .one().n;
  }

  addTag(label: string): void {
    this.ctx.storage.sql.exec(`INSERT INTO tags (label) VALUES (?)`, label);
  }

  listTags(): string[] {
    return this.ctx.storage.sql
      .exec<{ label: string }>(`SELECT label FROM tags ORDER BY rowid`)
      .toArray()
      .map((row) => row.label);
  }

  async setPref(key: string, value: string): Promise<void> {
    await this.ctx.storage.put(`pref:${key}`, value);
  }

  async getPref(key: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`pref:${key}`);
  }

  async listPrefs(): Promise<Record<string, string>> {
    const map = await this.ctx.storage.list<string>({ prefix: "pref:" });
    return Object.fromEntries(
      [...map].map(([key, value]) => [key.slice("pref:".length), value]),
    );
  }

  async remindAt(timestamp: number): Promise<void> {
    await this.ctx.storage.setAlarm(timestamp);
  }

  async pendingAlarm(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.put("alarm-fired-at", Date.now());
  }

  async alarmFiredAt(): Promise<number | undefined> {
    return this.ctx.storage.get<number>("alarm-fired-at");
  }

  /**
   * The body includes the raw `ctx.id.name`, so tests can tell whether a
   * response was served by the OLD binding (name `sess-01`) or the NEW kind
   * instance (name `session:sess-01`).
   */
  async fetch(_request: Request): Promise<Response> {
    return new Response(
      `session logical=${instanceName(this.ctx) ?? "?"} raw=${this.ctx.id.name ?? "?"} events=${this.eventCount()}`,
    );
  }
}

/** A second kind that is registered but NOT importable, for gating probes. */
export class AuditLog extends DurableObject<Env> {
  async append(line: string): Promise<void> {
    const lines = (await this.ctx.storage.get<string[]>("lines")) ?? [];
    lines.push(line);
    await this.ctx.storage.put("lines", lines);
  }

  async lines(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("lines")) ?? [];
  }
}

/** The OLD binding's class: same behavior, plus the export surface. */
export class OldSession extends exportable(SessionImpl) {}

/** The OLD binding's class for the secret-protected pair. */
export class OldSecureSession extends exportable(SessionImpl, {
  secret: "s1",
}) {}

/** The claydo host. Only `session` accepts imports; `audit` does not. */
export class AppDO extends union(
  {
    session: SessionImpl,
    audit: AuditLog,
  },
  { importable: ["session"] },
) {}

/** A second host with a migration secret, mirroring a cross-Worker setup. */
export class SecureDO extends union(
  { session: SessionImpl },
  { importable: true, secret: "s1" },
) {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, resource, name] = url.pathname.split("/");
    if (resource === "session" && name !== undefined && name !== "") {
      // Transitional router: manual strategy — old instances keep serving
      // until an external driver (the fleet migration) moves them.
      const sessions = migrated(env.OLD_SESSIONS, kinds(env.APP_DO).session, {
        strategy: "manual",
        oldRouteTtlMs: 0,
      });
      return sessions.get(name).fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
