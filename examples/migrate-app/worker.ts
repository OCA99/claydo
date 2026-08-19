/**
 * GameCo — consolidating two legacy Durable Object bindings into one claydo
 * host, end to end through cutover.
 *
 * Before: two namespaces.
 *   - OLD_ROOMS   (class OldRoom):  partyserver chat rooms, addressed by
 *                                   name. Message history in SQLite.
 *   - OLD_MATCHES (class OldMatch): plain DO match state, addressed by
 *                                   newUniqueId(). The unique-id strings
 *                                   live in a registry.
 *
 * After: one claydo host (APP_DO / AppDO) with kinds `room`, `match`, and
 * `registry`. Rooms migrate name-to-name; unique-id matches migrate to the
 * documented `migrated:<oldId>` names.
 *
 * Routing during the transition:
 *   - /rooms/:room/*   goes through a `migrated()` facade with strategy
 *     "manual": an operator-run driver (the /admin/migrate-room route)
 *     moves rooms off-peak, so no player ever pays migration latency on
 *     connect, and rooms with live WebSocket sessions are only torn down
 *     when *we* decide, not on a random first touch. (`lazy` would migrate
 *     the room under the feet of connected players on any read.)
 *   - /matches/:oldId/* cannot use `migrated()` at all — the facade routes
 *     by name via idFromName(), and these instances only have unique IDs.
 *     The worker resolves the route itself from the registry.
 */

import { DurableObject } from "cloudflare:workers";
import { Server, type Connection, type WSMessage } from "partyserver";
import { instanceName, kinds, union } from "../../src/index";
import {
  exportable,
  migrateInstance,
  migrated,
  type MigratedAccessor,
} from "../../src/migrate";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
  OLD_ROOMS: DurableObjectNamespace<OldRoom>;
  OLD_MATCHES: DurableObjectNamespace<OldMatch>;
}

/** The documented naming convention for migrated unique-id instances. */
export const migratedName = (oldId: string): string => `migrated:${oldId}`;

// ---------------------------------------------------------------------------
// Kind: chat rooms (partyserver Server subclass).
// ---------------------------------------------------------------------------

// A `type` alias, not an `interface`: sql.exec<T>() constrains T to
// Record<string, SqlStorageValue>, and interfaces have no implicit index
// signature.
export type RoomMessage = {
  id: number;
  room: string;
  sender: string;
  body: string;
  at: number;
};

export class RoomServer extends Server<Env> {
  static options = { hibernate: true };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        sender TEXT NOT NULL,
        body TEXT NOT NULL,
        at INTEGER NOT NULL
      )`,
    );
  }

  onMessage(connection: Connection, message: WSMessage): void {
    const body = typeof message === "string" ? message : "<binary>";
    // `this.name` is the DO instance name. On the old binding it is the
    // plain room name ("lobby"); under the claydo host it carries the kind
    // prefix ("room:lobby"). Persisting it in rows is exactly what a real
    // team does — and it is the data-compat probe for this audit.
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (room, sender, body, at) VALUES (?, ?, ?, ?)`,
      this.name,
      connection.id,
      body,
      Date.now(),
    );
    void this.broadcast(
      JSON.stringify({ room: this.name, sender: connection.id, body }),
    );
  }

  /** Server-side post (announcements, seeding). */
  post(sender: string, body: string): number {
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (room, sender, body, at) VALUES (?, ?, ?, ?)`,
      this.name,
      sender,
      body,
      Date.now(),
    );
    void this.broadcast(JSON.stringify({ room: this.name, sender, body }));
    return this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM messages`)
      .one().n;
  }

  /** Full history, regardless of what the `room` column says. */
  history(): RoomMessage[] {
    return this.ctx.storage.sql
      .exec<RoomMessage>(`SELECT * FROM messages ORDER BY id`)
      .toArray();
  }

  /**
   * The "obvious" query a team would write: filter rows by `this.name`.
   * After migration `this.name` changes from "lobby" to "room:lobby", so
   * this silently stops seeing pre-migration rows. Audit probe.
   */
  historyForThisRoom(): RoomMessage[] {
    return this.ctx.storage.sql
      .exec<RoomMessage>(
        `SELECT * FROM messages WHERE room = ? ORDER BY id`,
        this.name,
      )
      .toArray();
  }

  /** Identity probe: what does this instance think it is called? */
  label(): { doName: string; logical: string | null } {
    return { doName: this.name, logical: instanceName(this.ctx) ?? null };
  }

  /**
   * Uses partyserver's synchronous `getConnections()` helper. Works as a
   * kind. Under `exportable()` the seal guard turns every prototype method
   * async, so `this.getConnections()` returns a Promise and the `for..of`
   * throws — an audit probe for the wrapper's collateral damage.
   */
  connectionCount(): number {
    let count = 0;
    for (const _ of this.getConnections()) count += 1;
    return count;
  }
}

// ---------------------------------------------------------------------------
// Kind: matches (plain DO, historically addressed by newUniqueId()).
// ---------------------------------------------------------------------------

export interface MatchState {
  players: string[];
  status: string;
  moves: number;
  turnDeadline: number | null;
  timeoutFiredAt: number | null;
}

export class MatchImpl extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player TEXT NOT NULL,
        move TEXT NOT NULL,
        at INTEGER NOT NULL
      )`,
    );
  }

  async setup(players: string[]): Promise<void> {
    await this.ctx.storage.put("players", players);
    await this.ctx.storage.put("status", "active");
  }

  async recordMove(player: string, move: string): Promise<number> {
    this.ctx.storage.sql.exec(
      `INSERT INTO moves (player, move, at) VALUES (?, ?, ?)`,
      player,
      move,
      Date.now(),
    );
    return this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM moves`)
      .one().n;
  }

  async scheduleTurnTimeout(delayMs: number): Promise<number> {
    const deadline = Date.now() + delayMs;
    await this.ctx.storage.put("turn-deadline", deadline);
    await this.ctx.storage.setAlarm(deadline);
    return deadline;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.put("timeout-fired-at", Date.now());
    await this.ctx.storage.put("status", "timed-out");
  }

  async state(): Promise<MatchState> {
    return {
      players: (await this.ctx.storage.get<string[]>("players")) ?? [],
      status: (await this.ctx.storage.get<string>("status")) ?? "unknown",
      moves: this.ctx.storage.sql
        .exec<{ n: number }>(`SELECT count(*) AS n FROM moves`)
        .one().n,
      turnDeadline:
        (await this.ctx.storage.get<number>("turn-deadline")) ?? null,
      timeoutFiredAt:
        (await this.ctx.storage.get<number>("timeout-fired-at")) ?? null,
    };
  }

  /**
   * Audit probe: a table whose INTEGER PRIMARY KEY (the rowid alias) is not
   * the first declared column. Only created on instances that call this.
   */
  async logTurn(at: number, note: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS turn_log (
        at INTEGER NOT NULL,
        seq INTEGER PRIMARY KEY,
        note TEXT NOT NULL
      )`,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO turn_log (at, note) VALUES (?, ?)`,
      at,
      note,
    );
  }

  async turnLog(): Promise<{ at: number; seq: number; note: string }[]> {
    return this.ctx.storage.sql
      .exec<{ at: number; seq: number; note: string }>(
        `SELECT at, seq, note FROM turn_log ORDER BY seq`,
      )
      .toArray();
  }
}

// ---------------------------------------------------------------------------
// Kind: the match registry (the only record of the old unique-id strings —
// Cloudflare cannot list a namespace, so GameCo has always kept this).
// ---------------------------------------------------------------------------

export class MatchRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS matches (
        old_id TEXT PRIMARY KEY,
        migrated INTEGER NOT NULL DEFAULT 0
      )`,
    );
  }

  register(oldId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO matches (old_id, migrated) VALUES (?, 0)`,
      oldId,
    );
  }

  markMigrated(oldId: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE matches SET migrated = 1 WHERE old_id = ?`,
      oldId,
    );
  }

  lookup(oldId: string): { found: boolean; migrated: boolean } {
    const row = this.ctx.storage.sql
      .exec<{ migrated: number }>(
        `SELECT migrated FROM matches WHERE old_id = ?`,
        oldId,
      )
      .toArray()[0];
    return { found: row !== undefined, migrated: row?.migrated === 1 };
  }

  list(): { oldId: string; migrated: boolean }[] {
    return this.ctx.storage.sql
      .exec<{ old_id: string; migrated: number }>(
        `SELECT old_id, migrated FROM matches ORDER BY old_id`,
      )
      .toArray()
      .map((row) => ({ oldId: row.old_id, migrated: row.migrated === 1 }));
  }
}

// ---------------------------------------------------------------------------
// The OLD bindings' classes (deployed on the legacy Worker in real life; in
// this example everything lives in one Worker, like the repo test harness).
// ---------------------------------------------------------------------------

export class OldRoom extends exportable(RoomServer) {}
export class OldMatch extends exportable(MatchImpl) {}

// ---------------------------------------------------------------------------
// The claydo host.
// ---------------------------------------------------------------------------

export class AppDO extends union(
  {
    room: RoomServer,
    match: MatchImpl,
    registry: MatchRegistry,
  },
  { importable: ["room", "match"] },
) {}

// ---------------------------------------------------------------------------
// Worker routes.
// ---------------------------------------------------------------------------

let facadeMemo: { env: Env; facade: MigratedAccessor<RoomServer> } | undefined;

/**
 * The transitional room router, hoisted so its route cache survives across
 * requests (a per-request `migrated()` call would re-pay the resolution
 * subrequests on every request).
 */
function roomsFacade(env: Env): MigratedAccessor<RoomServer> {
  if (facadeMemo === undefined || facadeMemo.env !== env) {
    facadeMemo = {
      env,
      facade: migrated(env.OLD_ROOMS, kinds(env.APP_DO).room, {
        strategy: "manual",
        oldRouteTtlMs: 60_000,
      }),
    };
  }
  return facadeMemo.facade;
}

/** The methods both the old match stub and the new kind stub expose. */
interface MatchClient {
  state(): Promise<MatchState>;
  recordMove(player: string, move: string): Promise<number>;
  scheduleTurnTimeout(delayMs: number): Promise<number>;
}

function matchClient(env: Env, oldId: string, isMigrated: boolean): MatchClient {
  if (isMigrated) {
    return kinds(env.APP_DO).match.get(migratedName(oldId));
  }
  // Pre-migration: straight to the old unique-id instance.
  return env.OLD_MATCHES.get(
    env.OLD_MATCHES.idFromString(oldId),
  ) as unknown as MatchClient;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const seg = url.pathname.split("/").filter(Boolean);
    const app = kinds(env.APP_DO);

    // ---- Rooms: /rooms/:room/(ws|history|post) --------------------------
    if (seg[0] === "rooms" && seg[1] !== undefined) {
      const room = decodeURIComponent(seg[1]);
      // Cutover rehearsal: `?phase=cutover` is the post-cutover code path
      // (plain accessor, facade deleted). In production this is a deploy.
      const accessor =
        url.searchParams.get("phase") === "cutover"
          ? app.room
          : roomsFacade(env);
      const stub = accessor.get(room);
      if (seg[2] === "ws") return stub.fetch(request);
      if (seg[2] === "history") return Response.json(await stub.history());
      if (seg[2] === "post" && request.method === "POST") {
        const { sender, body } = await request.json<{
          sender: string;
          body: string;
        }>();
        return Response.json({ count: await stub.post(sender, body) });
      }
    }

    // ---- Matches: /matches/:oldId/(state|move|schedule-timeout) ---------
    if (seg[0] === "matches" && seg[1] !== undefined) {
      const oldId = seg[1];
      const entry = await app.registry.get("main").lookup(oldId);
      if (!entry.found) {
        return new Response("unknown match", { status: 404 });
      }
      const match = matchClient(env, oldId, entry.migrated);
      if (seg[2] === "state") return Response.json(await match.state());
      if (seg[2] === "move" && request.method === "POST") {
        const { player, move } = await request.json<{
          player: string;
          move: string;
        }>();
        return Response.json({ moves: await match.recordMove(player, move) });
      }
      if (seg[2] === "schedule-timeout" && request.method === "POST") {
        const { delayMs } = await request.json<{ delayMs: number }>();
        return Response.json({
          deadline: await match.scheduleTurnTimeout(delayMs),
        });
      }
    }

    // ---- Admin: seeding and the migration driver ------------------------
    if (seg[0] === "admin") {
      if (seg[1] === "matches" && request.method === "POST") {
        const { players } = await request.json<{ players: string[] }>();
        const id = env.OLD_MATCHES.newUniqueId();
        await env.OLD_MATCHES.get(id).setup(players);
        await app.registry.get("main").register(id.toString());
        return Response.json({ oldId: id.toString() });
      }
      if (
        seg[1] === "migrate-room" &&
        seg[2] !== undefined &&
        request.method === "POST"
      ) {
        const room = decodeURIComponent(seg[2]);
        const summary = await migrateInstance({
          from: env.OLD_ROOMS.get(env.OLD_ROOMS.idFromName(room)),
          to: app.room,
          name: room,
        });
        return Response.json(summary);
      }
      if (
        seg[1] === "migrate-match" &&
        seg[2] !== undefined &&
        request.method === "POST"
      ) {
        const oldId = seg[2];
        const summary = await migrateInstance({
          from: env.OLD_MATCHES.get(env.OLD_MATCHES.idFromString(oldId)),
          to: app.match,
          name: migratedName(oldId),
        });
        await app.registry.get("main").markMigrated(oldId);
        return Response.json(summary);
      }
      if (seg[1] === "registry") {
        return Response.json(await app.registry.get("main").list());
      }
      // Simulates a fresh Worker isolate (deploy/restart): the facade's
      // route cache is per-isolate and does not survive.
      if (seg[1] === "reset-rooms-facade" && request.method === "POST") {
        facadeMemo = undefined;
        return Response.json({ reset: true });
      }
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
