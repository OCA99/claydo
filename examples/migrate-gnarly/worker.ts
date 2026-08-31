/**
 * migrate-gnarly — a hostile-data stress fixture for `claydo/migrate`.
 *
 * One "kitchen sink" Durable Object class (`GnarlyImpl`) doubles as the OLD
 * binding (wrapped with `exportable()`) and as the destination kind on the
 * claydo host. Every seed method builds a deliberately nasty shape, and
 * `fingerprintAll()` produces a deterministic digest of the full state
 * (per-table row counts, ordered-row checksums, SQL storage-class
 * signatures, KV key list + value checksum, pending alarm) so tests can
 * prove byte fidelity — or catch exactly where it breaks.
 */
import { DurableObject, union } from "../../src/index";
import { exportable } from "../../src/migrate";

export interface Env {
  APP_DO: DurableObjectNamespace<AppDO>;
  OLD_GNARLY: DurableObjectNamespace<LegacyGnarly>;
}

type SqlScalar = null | number | string | ArrayBuffer;

/** Quotes an SQLite identifier (same rule the library uses). */
function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** FNV-1a 32-bit over a string, hex-encoded. Deterministic and cheap. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function hex(value: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Deterministic serialization of any value the KV store or SQLite can hold,
 * including the structured-clone types (Date, Map, Set, ArrayBuffer).
 */
function stable(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "string":
      return `s:${JSON.stringify(value)}`;
    case "number":
      return Object.is(value, -0) ? "n:-0" : `n:${value}`;
    case "boolean":
      return `b:${value}`;
    case "bigint":
      return `big:${value}`;
  }
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `bin:${hex(value as ArrayBuffer)}`;
  }
  if (value instanceof Map) {
    return `map:[${[...value.entries()]
      .map(([k, v]) => `${stable(k)}=>${stable(v)}`)
      .join(",")}]`;
  }
  if (value instanceof Set) return `set:[${[...value].map(stable).join(",")}]`;
  if (Array.isArray(value)) return `arr:[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `obj:{${keys.map((k) => `${JSON.stringify(k)}:${stable(record[k])}`).join(",")}}`;
}

export interface TablePrint {
  count: number;
  /** FNV over all rows ordered by rowid, values serialized with `stable()`. */
  checksum: string;
  /** FNV over the SQLite storage class (`typeof()`) of every cell, ordered. */
  typeSig: string;
}

export interface Fingerprint {
  tables: Record<string, TablePrint>;
  kv: { count: number; keys: string[]; checksum: string };
  alarm: number | null;
}

/** The kitchen-sink datastore. Constructor creates only `base_notes`. */
export class GnarlyImpl extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS base_notes (
        k TEXT PRIMARY KEY,
        v TEXT
      )`,
    );
  }

  pingCheck(): string {
    return "ok";
  }

  // ---------------------------------------------------------------- SQL API

  /** Generic SQL escape hatch for probing sqlite_master, sequences, etc. */
  runSql(
    query: string,
    ...params: SqlScalar[]
  ): { columns: string[]; rows: SqlScalar[][] } {
    const cursor = this.ctx.storage.sql.exec(query, ...params);
    const columns = cursor.columnNames;
    const rows = [...cursor.raw()] as SqlScalar[][];
    return { columns, rows };
  }

  // ---------------------------------------------------------- fingerprints

  async fingerprintAll(): Promise<Fingerprint> {
    const sql = this.ctx.storage.sql;
    const tables = sql
      .exec<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND sql IS NOT NULL
           AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
         ORDER BY name`,
      )
      .toArray();
    const prints: Record<string, TablePrint> = {};
    for (const table of tables) {
      if (/^\s*CREATE\s+VIRTUAL/i.test(table.sql)) {
        prints[table.name] = { count: -1, checksum: "virtual", typeSig: "virtual" };
        continue;
      }
      const count = sql
        .exec<{ n: number }>(`SELECT count(*) AS n FROM ${q(table.name)}`)
        .one().n;
      let checksum: string;
      let typeSig: string;
      try {
        const cursor = sql.exec(
          `SELECT rowid AS __r__, * FROM ${q(table.name)} ORDER BY rowid`,
        );
        const columns = cursor.columnNames;
        let acc = "";
        for (const row of cursor.raw()) {
          acc += "|" + (row as unknown[]).map(stable).join(",");
        }
        checksum = fnv1a(acc);
        const dataColumns = columns.slice(1);
        if (dataColumns.length > 0) {
          const sig = dataColumns
            .map((c) => `typeof(${q(c)})`)
            .join(" || ',' || ");
          const typeCursor = sql.exec<{ sig: string }>(
            `SELECT ${sig} AS sig FROM ${q(table.name)} ORDER BY rowid`,
          );
          let typeAcc = "";
          for (const row of typeCursor) typeAcc += "|" + row.sig;
          typeSig = fnv1a(typeAcc);
        } else {
          typeSig = "none";
        }
      } catch {
        // WITHOUT ROWID tables have no rowid to order by.
        checksum = `unorderable:${count}`;
        typeSig = "unorderable";
      }
      prints[table.name] = { count, checksum, typeSig };
    }

    const listed = await this.ctx.storage.list();
    const keys: string[] = [];
    let kvAcc = "";
    for (const [key, value] of listed) {
      // Exclude only the library's own bookkeeping keys ("__claydo:kind",
      // "__claydo:sealed", "__claydo:import"). USER keys that merely start
      // with "__claydo" (no colon) are user data and stay in the print.
      if (key.startsWith("__claydo:")) continue;
      keys.push(key);
      kvAcc += `|${JSON.stringify(key)}=${stable(value)}`;
    }
    return {
      tables: prints,
      kv: { count: keys.length, keys, checksum: fnv1a(kvAcc) },
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  // ------------------------------------------- 1. AUTOINCREMENT + deletes

  /** 10 rows, then the TOP 3 (ids 8..10) deleted: max(id)=7 but seq=10. */
  seedAutoinc(): { maxId: number | null; seq: number } {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE autoinc_t (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL
      )`,
    );
    for (let i = 1; i <= 10; i++) {
      sql.exec(`INSERT INTO autoinc_t (label) VALUES (?)`, `row-${i}`);
    }
    sql.exec(`DELETE FROM autoinc_t WHERE id >= 8`);
    const maxId = sql
      .exec<{ m: number | null }>(`SELECT max(id) AS m FROM autoinc_t`)
      .one().m;
    const seq = sql
      .exec<{ seq: number }>(
        `SELECT seq FROM sqlite_sequence WHERE name = 'autoinc_t'`,
      )
      .one().seq;
    return { maxId, seq };
  }

  insertAutoinc(label: string): number {
    return this.ctx.storage.sql
      .exec<{ id: number }>(
        `INSERT INTO autoinc_t (label) VALUES (?) RETURNING id`,
        label,
      )
      .one().id;
  }

  // ------------- 2. rowid alias + unique/partial index + trigger + view

  seedRelational(): { people: number; audit: number } {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE people (
        id INTEGER PRIMARY KEY,
        pname TEXT NOT NULL,
        email TEXT,
        score REAL
      )`,
    );
    sql.exec(
      `CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id INTEGER NOT NULL,
        source TEXT NOT NULL
      )`,
    );
    sql.exec(`CREATE UNIQUE INDEX people_email ON people (email)`);
    sql.exec(
      `CREATE INDEX people_high_score ON people (score) WHERE score > 100.0`,
    );
    sql.exec(
      `CREATE TRIGGER people_audit AFTER INSERT ON people
       BEGIN
         INSERT INTO audit_log (person_id, source) VALUES (NEW.id, 'trigger');
       END`,
    );
    sql.exec(
      `CREATE VIEW top_people AS
       SELECT pname, score FROM people WHERE score > 100.0 ORDER BY score DESC`,
    );
    for (let i = 1; i <= 7; i++) {
      sql.exec(
        `INSERT INTO people (pname, email, score) VALUES (?, ?, ?)`,
        `person-${i}`,
        `p${i}@example.com`,
        i * 25.5,
      );
    }
    const people = sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM people`)
      .one().n;
    const audit = sql
      .exec<{ n: number }>(`SELECT count(*) AS n FROM audit_log`)
      .one().n;
    return { people, audit };
  }

  insertPerson(pname: string, email: string, score: number): number {
    return this.ctx.storage.sql
      .exec<{ id: number }>(
        `INSERT INTO people (pname, email, score) VALUES (?, ?, ?) RETURNING id`,
        pname,
        email,
        score,
      )
      .one().id;
  }

  // ------------------------------- 3. hostile scalar values, wild rowids

  seedHostile(): number {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE payloads (
        id INTEGER PRIMARY KEY,
        data BLOB,
        ratio REAL,
        note TEXT,
        anything
      )`,
    );
    const nasty = new Uint8Array(300);
    for (let i = 0; i < nasty.length; i++) nasty[i] = (i * 7 + 251) & 0xff;
    // Non-UTF8 bytes on purpose (0xff, 0xfe, lone continuation bytes).
    nasty.set([0xff, 0xfe, 0x80, 0x00, 0xc0], 0);
    sql.exec(
      `INSERT INTO payloads (id, data, ratio, note, anything)
       VALUES (?, ?, ?, ?, ?)`,
      1,
      nasty.buffer,
      Math.PI,
      "plain text",
      "typed as nothing",
    );
    sql.exec(
      `INSERT INTO payloads (id, data, ratio, note, anything)
       VALUES (2, NULL, NULL, NULL, NULL)`,
    );
    // Empty string, empty blob, and a REAL literal in a no-affinity column
    // (the storage class MUST stay 'real' after migration).
    sql.exec(
      `INSERT INTO payloads (id, data, ratio, note, anything)
       VALUES (3, x'', 0.5, '', 2.0)`,
    );
    const big = `«big-😀-\u0007-text»${"x".repeat(1024)}`.repeat(110); // > 100 KB
    sql.exec(
      `INSERT INTO payloads (id, data, ratio, note, anything)
       VALUES (4, NULL, -0.0, ?, 'after-big')`,
      big,
    );
    sql.exec(
      `INSERT INTO payloads (id, data, ratio, note, anything)
       VALUES (-5, x'deadbeef', -1.5, 'negative rowid', NULL)`,
    );
    sql.exec(
      `INSERT INTO payloads (id, data, ratio, note, anything)
       VALUES (1099511627776, NULL, NULL, 'rowid 2^40', NULL)`,
    );
    return sql.exec<{ n: number }>(`SELECT count(*) AS n FROM payloads`).one()
      .n;
  }

  // ------------------------------------------------- 4. hostile KV entries

  async seedKv(): Promise<{ count: number; keys: string[] }> {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < 190; i++) {
      entries[`bulk:key:${String(i).padStart(3, "0")}`] = {
        i,
        tag: `value-${i}`,
        nested: { arr: [i, i * 2, null], even: i % 2 === 0 },
      };
    }
    entries["buffer"] = Uint8Array.from([0, 255, 254, 128, 1, 7]).buffer;
    entries["stamp"] = new Date("2020-02-29T12:34:56.789Z");
    entries["mapval"] = new Map<unknown, unknown>([
      ["a", 1],
      [42, "answer"],
      ["deep", { ok: true }],
    ]);
    entries["colon:in:key:v2"] = "colons everywhere";
    entries["uni:😀:ключ:キー"] = "unicode key";
    entries["empty-string"] = "";
    entries["nested"] = { a: { b: { c: [1, "2", { d: null }] } } };
    // THE TRAP: user keys that literally start with "__claydo".
    entries["__claydonote"] = "user data that merely looks library-ish";
    entries["__claydo_config"] = { important: true, version: 7 };
    const keys = Object.keys(entries);
    for (let i = 0; i < keys.length; i += 100) {
      const batch: Record<string, unknown> = {};
      for (const key of keys.slice(i, i + 100)) batch[key] = entries[key];
      await this.ctx.storage.put(batch);
    }
    return { count: keys.length, keys: keys.sort() };
  }

  async kvGet(key: string): Promise<unknown> {
    return this.ctx.storage.get(key);
  }

  async kvPut(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  async kvKeys(): Promise<string[]> {
    return [...(await this.ctx.storage.list()).keys()];
  }

  /** stable() digest of one KV value, for value round-trip comparisons. */
  async kvDigest(key: string): Promise<string> {
    return stable(await this.ctx.storage.get(key));
  }

  // ----------------------------------------------------------- 5. alarms

  async armAlarm(timestamp: number): Promise<number | null> {
    await this.ctx.storage.setAlarm(timestamp);
    return this.ctx.storage.getAlarm();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.put("alarm-fired-at", Date.now());
  }

  async alarmProbe(): Promise<{
    scheduled: number | null;
    firedAt: number | null;
  }> {
    return {
      scheduled: await this.ctx.storage.getAlarm(),
      firedAt: (await this.ctx.storage.get<number>("alarm-fired-at")) ?? null,
    };
  }

  // ------------------------------- 6. WITHOUT ROWID and virtual tables

  seedWithoutRowid(): number {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE keep_t (id INTEGER PRIMARY KEY, v TEXT)`);
    sql.exec(`INSERT INTO keep_t (v) VALUES ('a'), ('b'), ('c')`);
    sql.exec(
      `CREATE TABLE wor_t (k TEXT PRIMARY KEY, v INTEGER) WITHOUT ROWID`,
    );
    sql.exec(`INSERT INTO wor_t (k, v) VALUES ('one', 1), ('two', 2)`);
    return 2;
  }

  seedVirtual(): string {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE keep_t (id INTEGER PRIMARY KEY, v TEXT)`);
    sql.exec(`INSERT INTO keep_t (v) VALUES ('x'), ('y')`);
    try {
      sql.exec(`CREATE VIRTUAL TABLE fts_docs USING fts5(body)`);
      sql.exec(`INSERT INTO fts_docs (body) VALUES ('hello gnarly world')`);
      return "ok";
    } catch (error) {
      return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  dropTableByName(table: string): void {
    this.ctx.storage.sql.exec(`DROP TABLE ${q(table)}`);
  }

  // --------------------------------------- 7. schema-only, zero rows/KV

  seedSchemaOnly(): string[] {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE ghost_table (a TEXT, b REAL, c BLOB)`,
    );
    sql.exec(`CREATE INDEX ghost_idx ON ghost_table (a)`);
    return ["ghost_table", "ghost_idx"];
  }

  // -------------------------------------------------------- 8. big run

  seedBig(): { total: number } {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE big_a (id INTEGER PRIMARY KEY, txt TEXT, num REAL)`);
    sql.exec(`CREATE TABLE big_b (id INTEGER PRIMARY KEY, txt TEXT, num REAL)`);
    sql.exec(`CREATE TABLE big_c (id INTEGER PRIMARY KEY, txt TEXT, num REAL)`);
    const fill = (table: string, n: number) => {
      for (let i = 1; i <= n; i++) {
        sql.exec(
          `INSERT INTO ${table} (txt, num) VALUES (?, ?)`,
          `${table}-item-${i}-${"pad".repeat(i % 5)}`,
          i * 0.25,
        );
      }
    };
    fill("big_a", 1000);
    fill("big_b", 600);
    fill("big_c", 400);
    return { total: 2000 };
  }

  // ----------------------- case: rowid alias NOT in first position

  seedAliasSecond(): number {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE alias_second (label TEXT, id INTEGER PRIMARY KEY)`);
    sql.exec(
      `INSERT INTO alias_second (label, id) VALUES ('alpha', 1), ('beta', 2), ('gamma', 3)`,
    );
    return 3;
  }
}

/** The OLD binding's class: unchanged behavior plus the export surface. */
export class LegacyGnarly extends exportable(GnarlyImpl) {}

/** The claydo host, with imports enabled for the destination kind. */
export class AppDO extends union(
  { gnarly: GnarlyImpl },
  { importable: ["gnarly"] },
) {}

export default {
  async fetch(): Promise<Response> {
    return new Response("migrate-gnarly fixture", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
