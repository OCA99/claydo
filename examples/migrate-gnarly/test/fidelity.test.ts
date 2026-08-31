/**
 * Data-fidelity audit of `claydo/migrate` against deliberately hostile
 * shapes. Every migration is fingerprinted on both sides (row counts,
 * ordered-row checksums, SQLite storage-class signatures, KV key lists and
 * value digests).
 *
 * POST-FIX VERSION: the original audit found four data-fidelity bugs
 * (asserted verbatim as `BUG:` tests); the library has since been hardened
 * and every former `BUG:` test now asserts the FIXED behavior with the same
 * rigor. See ../DX-REPORT.md §6 for the before/after evidence.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import { migrateInstance } from "../../../src/migrate";

const gnarly = () => kind(env.APP_DO, "gnarly");
const old = (name: string) =>
  env.OLD_GNARLY.get(env.OLD_GNARLY.idFromName(name));

/** Asserts a rejection without leaving an unhandled-rejection report. */
async function expectRejects(
  run: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(String(error)).toMatch(pattern);
    return;
  }
  expect.unreachable(`expected rejection matching ${pattern}`);
}

describe("1. AUTOINCREMENT sequence restore", () => {
  it("FIXED: deleted top ids are not reused; sqlite_sequence has one exact row", async () => {
    const source = old("autoinc");
    // 10 rows inserted, ids 8..10 deleted: max(id)=7 but the sequence must
    // stay at 10 so the next insert gets 11, never a recycled 8.
    const seeded = await source.seedAutoinc();
    expect(seeded).toEqual({ maxId: 7, seq: 10 });

    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "autoinc",
    });
    expect(summary.rows["autoinc_t"]).toBe(7);

    const moved = gnarly().get("autoinc");
    // The importer now does DELETE-then-INSERT on sqlite_sequence, so the
    // restored sequence is a single exact row (previously it was duplicated
    // as [7, 10] and SQLite read the wrong one).
    const seq = await moved.runSql(
      `SELECT name, seq FROM sqlite_sequence ORDER BY seq`,
    );
    expect(seq.rows).toEqual([["autoinc_t", 10]]);

    // AUTOINCREMENT semantics hold across the migration: the next insert
    // gets a NEVER-issued id (11), not the recycled 8 of the old bug.
    const nextId = await moved.insertAutoinc("post-migration");
    expect(nextId).toBe(11);
    const afterSeq = await moved.runSql(
      `SELECT name, seq FROM sqlite_sequence ORDER BY seq`,
    );
    expect(afterSeq.rows).toEqual([["autoinc_t", 11]]);
  });
});

describe("2. rowid alias + indexes + trigger + view", () => {
  it("copies rows without firing triggers, and replays indexes/trigger/view", async () => {
    const source = old("rel");
    const seeded = await source.seedRelational();
    expect(seeded).toEqual({ people: 7, audit: 7 });
    const before = await source.fingerprintAll();

    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "rel",
      maxRowsPerChunk: 2,
      maxBytesPerChunk: 1024,
    });
    // Zero-row tables (base_notes) are reported with zero counts.
    expect(summary.rows).toEqual({
      audit_log: 7,
      base_notes: 0,
      people: 7,
    });
    expect(summary.chunks).toBeGreaterThan(5); // forced many chunks

    const moved = gnarly().get("rel");
    const after = await moved.fingerprintAll();
    // Byte fidelity: counts, ordered-row checksums, and SQLite storage
    // classes are identical for every table.
    expect(after.tables).toEqual(before.tables);

    // The trigger did NOT fire during the row copy: audit_log still has
    // exactly the 7 rows the source's own inserts produced.
    expect(after.tables["audit_log"]!.count).toBe(7);

    // Indexes (including the partial one, with its WHERE clause) exist.
    const indexes = await moved.runSql(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'people' ORDER BY name`,
    );
    expect(indexes.rows.map((r) => r[0])).toEqual([
      "people_email",
      "people_high_score",
    ]);
    expect(String(indexes.rows[1]![1])).toContain("WHERE score > 100.0");

    // The UNIQUE index enforces: duplicate email fails on the new side.
    await expectRejects(
      () => moved.insertPerson("dup", "p3@example.com", 1),
      /UNIQUE constraint failed/,
    );

    // The trigger DOES fire for new inserts after migration.
    const newId = await moved.insertPerson("newcomer", "new@example.com", 150.5);
    const audit = await moved.runSql(
      `SELECT count(*) AS n FROM audit_log`,
    );
    expect(audit.rows[0]![0]).toBe(8);
    const lastAudit = await moved.runSql(
      `SELECT person_id, source FROM audit_log ORDER BY id DESC LIMIT 1`,
    );
    expect(lastAudit.rows[0]).toEqual([newId, "trigger"]);

    // The view works and sees the new row.
    const view = await moved.runSql(`SELECT pname, score FROM top_people`);
    expect(view.rows).toEqual([
      ["person-7", 178.5],
      ["person-6", 153],
      ["newcomer", 150.5],
      ["person-5", 127.5],
      ["person-4", 102],
    ]);
  });

  it("FIXED: rowid alias in second column position migrates byte-exact", async () => {
    const source = old("alias2");
    await source.seedAliasSecond();
    const before = await source.fingerprintAll();
    const beforeRows = await source.runSql(
      `SELECT rowid, label, id FROM alias_second ORDER BY rowid`,
    );
    expect(beforeRows.rows).toEqual([
      [1, "alpha", 1],
      [2, "beta", 2],
      [3, "gamma", 3],
    ]);

    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "alias2",
    });
    expect(summary.skipped).toBe(false);
    expect(summary.rows["alias_second"]).toBe(3);

    // The wire format now carries `rows.rowid` (the alias column name, or
    // "__rowid__"), and the importer maps columns by that instead of
    // assuming column 0 is the rowid. Previously `label` was silently
    // NULLed here while verification passed.
    const moved = gnarly().get("alias2");
    const afterRows = await moved.runSql(
      `SELECT rowid, label, id FROM alias_second ORDER BY rowid`,
    );
    expect(afterRows.rows).toEqual([
      [1, "alpha", 1],
      [2, "beta", 2],
      [3, "gamma", 3],
    ]);
    // Full fingerprint equality: checksum over ordered rows AND storage
    // classes.
    const after = await moved.fingerprintAll();
    expect(after.tables["alias_second"]).toEqual(before.tables["alias_second"]);

    // The old side is sealed with a move marker (recorded after success).
    const seal = await source.__claydoSealed();
    expect(seal.sealed).toBe(true);
    expect(seal.movedTo).toBeDefined();
  });
});

describe("3. hostile scalar values and wild rowids", () => {
  it("round-trips blobs, REALs, NULLs, empty strings, 100KB text, rowids -5 and 2^40", async () => {
    const source = old("hostile");
    expect(await source.seedHostile()).toBe(6);
    const before = await source.fingerprintAll();

    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "hostile",
      maxRowsPerChunk: 2,
      maxBytesPerChunk: 8192,
    });
    expect(summary.rows["payloads"]).toBe(6);
    expect(summary.chunks).toBeGreaterThan(3);

    const moved = gnarly().get("hostile");
    const after = await moved.fingerprintAll();
    // Checksums over ordered rows AND SQLite storage classes match exactly:
    // REAL stays real (even 2.0 in a no-affinity column), blobs stay blobs.
    expect(after.tables["payloads"]).toEqual(before.tables["payloads"]);

    // Explicit spot checks. The wild rowids survived:
    const ids = await moved.runSql(
      `SELECT rowid FROM payloads ORDER BY rowid`,
    );
    expect(ids.rows.map((r) => r[0])).toEqual([
      -5, 1, 2, 3, 4, 1099511627776,
    ]);

    // Non-UTF8 blob bytes are identical.
    const blob = await moved.runSql(
      `SELECT data FROM payloads WHERE id = 1`,
    );
    const bytes = new Uint8Array(blob.rows[0]![0] as ArrayBuffer);
    expect(bytes.length).toBe(300);
    expect([...bytes.slice(0, 5)]).toEqual([0xff, 0xfe, 0x80, 0x00, 0xc0]);

    // The 100KB+ text survived to the character.
    const big = await moved.runSql(
      `SELECT length(note), substr(note, 1, 14) FROM payloads WHERE id = 4`,
    );
    expect(big.rows[0]![0]).toBeGreaterThan(100_000);
    expect(big.rows[0]![1]).toBe("«big-😀-\u0007-text»");

    // NULLs, empty string, empty blob kept their storage classes.
    const types = await moved.runSql(
      `SELECT typeof(data), typeof(ratio), typeof(note), typeof(anything)
       FROM payloads WHERE id = 3`,
    );
    expect(types.rows[0]).toEqual(["blob", "real", "text", "real"]);
  });
});

describe("4. hostile KV entries", () => {
  it("FIXED: all 199 keys migrate, including user keys starting with __claydo", async () => {
    const source = old("kvtrap");
    const seeded = await source.seedKv();
    expect(seeded.count).toBe(199); // includes the two __claydo* trap keys
    const before = await source.fingerprintAll();
    expect(before.kv.count).toBe(199);

    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "kvtrap",
      maxBytesPerChunk: 4096, // force many KV pages
    });
    // Only the three EXACT reserved keys (__claydo:sealed, __claydo:kind,
    // __claydo:import) are excluded now; user keys that merely start with
    // "__claydo" migrate and count. Previously 197 of 199 moved and the
    // count-filter symmetry hid the loss.
    expect(summary.kv).toBe(199);
    expect(summary.chunks).toBeGreaterThan(5);

    const moved = gnarly().get("kvtrap");
    expect(await moved.kvGet("__claydonote")).toBe(
      "user data that merely looks library-ish",
    );
    expect(await moved.kvGet("__claydo_config")).toEqual({
      important: true,
      version: 7,
    });

    // Full KV fingerprint equality (keys + deterministic value digests).
    const after = await moved.fingerprintAll();
    expect(after.kv.count).toBe(199);
    expect(after.kv.keys).toEqual(before.kv.keys);
    expect(after.kv.checksum).toBe(before.kv.checksum);

    // Structured-clone value shapes round-tripped exactly.
    expect(await moved.kvDigest("buffer")).toBe("bin:00fffe800107");
    expect(await moved.kvGet("colon:in:key:v2")).toBe("colons everywhere");
    expect(await moved.kvGet("uni:😀:ключ:キー")).toBe("unicode key");
    expect(await moved.kvGet("empty-string")).toBe("");
    const stamp = (await moved.kvGet("stamp")) as Date;
    expect(stamp instanceof Date).toBe(true);
    expect(stamp.toISOString()).toBe("2020-02-29T12:34:56.789Z");
    const mapval = (await moved.kvGet("mapval")) as Map<unknown, unknown>;
    expect(mapval instanceof Map).toBe(true);
    expect(mapval.get(42)).toBe("answer");
    expect(mapval.get("deep")).toEqual({ ok: true });
    const buffer = (await moved.kvGet("buffer")) as ArrayBuffer;
    expect([...new Uint8Array(buffer)]).toEqual([0, 255, 254, 128, 1, 7]);
    expect(await moved.kvGet("nested")).toEqual({
      a: { b: { c: [1, "2", { d: null }] } },
    });
    expect(await moved.kvGet("bulk:key:042")).toEqual({
      i: 42,
      tag: "value-42",
      nested: { arr: [42, 84, null], even: true },
    });

    // Facet-native storage contains exactly the 199 user keys. The kind pin
    // lives in the isolated supervisor database, not among user data.
    const keys = await moved.kvKeys();
    expect(keys.length).toBe(199);
    expect(keys.filter((k) => k.startsWith("__claydo"))).toEqual([
      "__claydo_config",
      "__claydonote",
    ]);
  });

  it("FIXED: an instance whose ONLY data is __claydo-prefixed user keys migrates fully", async () => {
    const source = old("kvshadow");
    await source.kvPut("__claydonly", "the only data this instance has");

    // hasData now recognizes user keys that start with __claydo (previously
    // false, which made the lazy router strand this data forever).
    expect(await source.__claydoHasData()).toBe(true);

    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "kvshadow",
    });
    expect(summary.skipped).toBe(false);
    expect(summary.kv).toBe(1);
    const moved = gnarly().get("kvshadow");
    expect(await moved.kvGet("__claydonly")).toBe(
      "the only data this instance has",
    );
  });
});

describe("7. schema-only instance (zero rows, zero KV)", () => {
  it("is skipped by default, and moves DDL with allowEmpty: true", async () => {
    const source = old("schemaonly");
    await source.pingCheck(); // force construction (constructor DDL only)
    expect(await source.seedSchemaOnly()).toEqual(["ghost_table", "ghost_idx"]);

    // Schema alone does not count as data (documented behavior, unchanged).
    expect(await source.__claydoHasData()).toBe(false);

    // NEW BEHAVIOR: empty instances are skipped by default so stale
    // registry entries cannot fabricate sealed husks. Nothing is touched.
    const skipped = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "schemaonly",
    });
    expect(skipped.skipped).toBe(true);
    expect(skipped.reason).toBe(
      "old instance has no data (pass allowEmpty to migrate schema-only instances)",
    );
    expect((await source.__claydoSealed()).sealed).toBe(false);
    const status = await (
      gnarly().get("schemaonly").stub as unknown as {
        __claydoImportStatus(): Promise<{ kind?: string; importing?: unknown }>;
      }
    ).__claydoImportStatus();
    expect(status).toEqual({});

    // Explicit schema-only migration with the new flag.
    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "schemaonly",
      allowEmpty: true,
    });
    expect(summary.skipped).toBe(false);
    expect(summary.chunks).toBe(1);
    expect(summary.kv).toBe(0);
    expect(summary.rows).toEqual({ base_notes: 0, ghost_table: 0 });
    expect(summary.alarm).toBeNull();

    const moved = gnarly().get("schemaonly");
    const master = await moved.runSql(
      `SELECT name, type FROM sqlite_master
       WHERE name IN ('ghost_table', 'ghost_idx', 'base_notes')
       ORDER BY name`,
    );
    expect(master.rows).toEqual([
      ["base_notes", "table"],
      ["ghost_idx", "index"],
      ["ghost_table", "table"],
    ]);
    // The new instance is live as the kind.
    expect(await moved.pingCheck()).toBe("ok");
  });
});

describe("8. big run: 2000 rows, maxRowsPerChunk 50", () => {
  it("streams 41 chunks with exact fingerprint equality", async () => {
    const source = old("big");
    expect(await source.seedBig()).toEqual({ total: 2000 });
    const before = await source.fingerprintAll();

    const startedAt = Date.now();
    const summary = await migrateInstance({
      from: source,
      to: gnarly(),
      name: "big",
      maxRowsPerChunk: 50,
    });
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `big run: ${summary.chunks} chunks, ${elapsedMs} ms for 2000 rows`,
    );

    expect(summary.rows).toEqual({
      big_a: 1000,
      big_b: 600,
      base_notes: 0,
      big_c: 400,
    });
    // 20 + 12 + 8 row chunks (the first one also carries the DDL) plus the
    // final totals/post-DDL chunk.
    expect(summary.chunks).toBe(41);
    expect(elapsedMs).toBeLessThan(30_000);

    const moved = gnarly().get("big");
    const after = await moved.fingerprintAll();
    expect(after.tables).toEqual(before.tables);
    expect(after.kv).toEqual(before.kv);
  });
});
