# DX audit: `claydo/migrate` vs. deliberately hostile data ("migrate-gnarly") — historical pre-facet audit

> **Facet-native update (2026-08-31).** This example now imports `DurableObject`
> from claydo and runs every kind in an isolated Durable Object facet. The
> supervisor keeps routing, kind identity, migration state, and virtualized
> alarms outside user storage. The tests were updated for the new lifecycle:
> `deleteAll()` cannot erase kind identity, post-delete writes and alarms are
> preserved, and stable public stubs survive facet eviction. The detailed report
> below is the original build-time audit; findings about shared host storage,
> `__claydo:kind` in user data, or kind-less husks are historical and are
> resolved by this refactor.

Auditor role: a user migrating an existing Durable Object binding into a
claydo kind, attacking **data fidelity** with the nastiest state I could
construct. Environment: node 22, vitest 4, `@cloudflare/vitest-pool-workers`
0.22, `compatibility_date: "2026-08-01"`.

Run everything from the repo root:

```sh
npx vitest run --config examples/migrate-gnarly/vitest.config.ts   # 13 tests, all green
npx tsc -p examples/migrate-gnarly/tsconfig.json                   # typecheck
```

Tests marked `BUG:` intentionally assert the observed **broken** behavior,
so they will start failing when the library is fixed.

> **Update:** the library has since been hardened; the former `BUG:` tests
> are now `FIXED:` tests asserting correct behavior. Sections 1–5 are the
> original audit, kept as the historical record. See
> [§6 Post-fix verification](#6-post-fix-verification) for the re-audit.

## 1. What I built

One "kitchen sink" class, `GnarlyImpl` (`worker.ts`), used both as the OLD
binding (`LegacyGnarly extends exportable(GnarlyImpl)`) and as the target
kind (`AppDO extends union({ gnarly: GnarlyImpl }, { importable: ["gnarly"] })`).
Each test instance seeds one hostile shape:

- `autoinc_t` — `INTEGER PRIMARY KEY AUTOINCREMENT` where the top 3 rows
  (ids 8–10) were deleted before migration, so `max(id)=7` but `seq=10`.
- `people`/`audit_log` — rowid-alias PK, UNIQUE index, partial index
  (`WHERE score > 100.0`), an AFTER INSERT audit trigger, and a view.
- `payloads` — non-UTF8 BLOBs, π as REAL, `-0.0`, NULLs vs. empty strings,
  an empty blob `x''`, a 100 KB+ unicode/control-char TEXT, explicit rowids
  `-5` and `2^40`, and a **no-affinity column** holding a REAL `2.0`.
- ~199 KV keys across multiple pages: ArrayBuffer, `Date`, `Map`, nested
  objects, colon/unicode keys, and the trap keys `__claydonote` /
  `__claydo_config`.
- `alias_second` — a rowid-alias table whose `INTEGER PRIMARY KEY` is the
  **second** column (`CREATE TABLE alias_second (label TEXT, id INTEGER
  PRIMARY KEY)`).
- Alarm instances (near future, already past, and elapsing while sealed),
  a `WITHOUT ROWID` table, an fts5 virtual table, a schema-only instance,
  and a 2000-row / 3-table instance migrated with `maxRowsPerChunk: 50`.

`fingerprintAll()` digests everything on both sides: per-table row counts,
FNV checksums over rows ordered by rowid, **SQLite storage-class signatures**
(`typeof()` per cell, to catch silent type drift like REAL→INTEGER), the KV
key list plus a deterministic value digest (handles Date/Map/ArrayBuffer),
and the pending alarm. `runSql()` is a generic escape hatch for probing
`sqlite_master` and `sqlite_sequence` from tests.

## 2. What worked well

- **Scalar fidelity is genuinely excellent.** Non-UTF8 blobs, empty blob
  vs. NULL vs. empty string, π, negative rowid `-5`, rowid `2^40`, a 100 KB
  unicode TEXT — byte-identical, and even the SQLite *storage classes*
  survive: a REAL `2.0` sitting in a **no-affinity** column came back
  `typeof = 'real'`, not `integer`. Checksums and type signatures matched
  exactly on every supported shape.
- **Triggers do not fire during the row copy.** Post-DDL (indexes,
  triggers, views) is replayed after all rows, so `audit_log` arrived with
  exactly 7 rows, and the trigger fired correctly for the first
  post-migration insert. Partial index kept its `WHERE` clause; the UNIQUE
  index enforces; the view works.
- **KV round-trip through structured clone is faithful** for `Date`, `Map`
  (including non-string keys), `ArrayBuffer`, nested objects, unicode and
  colon-riddled keys, across many pages (197 keys, 14 chunks at 4 KB).
- **Rollback is clean and honest.** After a `WITHOUT ROWID`/virtual-table
  failure: old instance unsealed, its fingerprint bit-identical to before,
  target completely untouched (`__claydoImportStatus() → {}`), and dropping
  the offending table makes the same migration succeed. Error messages are
  specific and actionable, and the wrapper message states exactly what
  happened: *"failed and was rolled back (old instance unsealed)"*.
- **Chunking is predictable and fast.** 2000 rows at `maxRowsPerChunk: 50`
  produced exactly 41 chunks (40 row pages + final totals chunk) in ~133 ms
  locally, with exact fingerprint equality.
- **Schema-only migration works**: DDL (tables *and* indexes) moves even
  with zero rows and zero KV, and `__claydoHasData()` correctly says
  `false` for constructor-created empty schema.
- fts5 **is** available in DO SQLite, and the exporter correctly detects
  and rejects the virtual table before touching anything.

## 3. Papercuts and issues

### Issue 1 — severity: **blocker**, category: **DATA-LOSS (silent corruption)**
**Rowid-alias table whose INTEGER PRIMARY KEY is not the first column:
every other column is silently NULLed, and the migration reports success.**

- Repro: `CREATE TABLE alias_second (label TEXT, id INTEGER PRIMARY KEY)`,
  rows `('alpha',1),('beta',2),('gamma',3)`; `migrateInstance(...)`.
  (Test: `fidelity.test.ts` › "BUG: silently NULLs other columns…")
- Observed (verbatim): migration returns
  `{"skipped":false,"resumed":false,"chunks":2,"kv":0,"rows":{"alias_second":3},"alarm":null}`
  — success — but the new side holds `[[1,null,1],[2,null,2],[3,null,3]]`
  where the old side had `[[1,"alpha",1],[2,"beta",2],[3,"gamma",3]]`.
  Row-count verification passes, so nothing flags the corruption.
- Expected: an exact copy, or at minimum a loud failure.
- Root cause: for alias tables the exporter sends the real column list
  (`SELECT *`), but the importer assumes **column 0 is the rowid** and
  builds `INSERT INTO alias_second (rowid, "id") VALUES (?, ?)` — binding
  `label` to `rowid`, `id` to `"id"` (the same column, last write wins),
  and never assigning `label` at all. It only works when the alias happens
  to be the first column.
- Suggested change: have the exporter always emit `__rowid__` as column 0
  (drop the alias special case), or carry `rowidAlias`/the rowid column
  index in the wire format and have the importer map columns **by name**.
  Also make the totals verification compare a per-table content checksum,
  not just row counts — counts pass here while the data is destroyed.

### Issue 2 — severity: **major**, category: **DATA-LOSS (silent)**
**User KV keys starting with `__claydo` are silently dropped, and the
verification is blind to the loss.**

- Repro: `storage.put("__claydonote", ...)` and
  `storage.put("__claydo_config", ...)` on the old instance among 197 other
  keys; migrate. (Tests: `fidelity.test.ts` › section 4.)
- Observed: `summary.kv` is `197` of 199; `__claydonote` and
  `__claydo_config` do not exist on the new side. No error, no warning —
  the exporter's KV page filter and its KV count filter use the same
  `key.startsWith("__claydo")` predicate, so totals verification passes.
  Worse: an instance whose **only** data is such keys reports
  `__claydoHasData() === false`, migrates as "empty" (`kv: 0`), and the
  lazy `migrated()` router would route it to the fresh kind instance and
  strand the data forever.
- Expected: only the library's actual bookkeeping keys (`__claydo:kind`,
  `__claydo:sealed`, `__claydo:import` — all with a colon) filtered;
  user keys copied, or at least a hard export error naming the collision.
- Suggested change: filter on the exact prefix `"__claydo:"` (the library
  already namespaces its keys with the colon), and document the reserved
  prefix in the README's migration guarantees section.

### Issue 3 — severity: **major**, category: **DATA-LOSS (pending work)**
**An alarm that comes due while the instance is sealed is silently
swallowed — not exported, not re-armed, not recoverable by rollback.**

- Repro: arm an alarm at `now + 700ms`, `__claydoSeal()`, wait 1.5 s,
  export to the final chunk, unseal.
  (Test: `alarms-and-limits.test.ts` › "BUG: an alarm that elapses while
  the instance is sealed is silently lost".)
- Observed: final chunk has `alarm: null`; after unseal,
  `{"scheduled":null,"firedAt":null}` — the alarm never fired and no longer
  exists anywhere. The sealed wrapper's `alarm()` no-op **returns
  successfully** (logging `claydo: alarm() skipped on sealed instance`), so
  the runtime deletes the alarm instead of retrying it.
- Expected: pending work survives the migration. The window is the whole
  migration duration — and unbounded if a crashed driver stays sealed for
  hours before resuming.
- Suggested change: stash the pending alarm timestamp inside the seal
  record at `__claydoSeal()` time (and restore it on unseal); export from
  the stash. Alternatively the sealed `alarm()` no-op should re-arm itself
  (`setAlarm(far future)`) instead of letting the runtime delete it.

### Issue 4 — severity: **major**, category: **correctness (ID reuse)**
**AUTOINCREMENT sequences are restored into a duplicated `sqlite_sequence`
row, and the new instance reuses previously-issued ids.**

- Repro: AUTOINCREMENT table, insert ids 1–10, delete ids 8–10 (so
  `max(id)=7`, `seq=10`), migrate, insert one row on the new side.
  (Test: `fidelity.test.ts` › section 1.)
- Observed (verbatim): after migration the new side's `sqlite_sequence`
  contains `[["autoinc_t",7],["autoinc_t",10]]` — two rows for one table —
  and the next insert gets **id 8**, an id the old instance had already
  issued and deleted. After that insert: `[["autoinc_t",8],["autoinc_t",10]]`.
- Expected: next id 11. Never reissuing rowids is the *only* reason to use
  AUTOINCREMENT; external references to deleted rows can silently
  re-attach to unrelated new rows.
- Root cause: the explicit-rowid inserts during the copy already create a
  `sqlite_sequence` row (`seq = max imported rowid = 7`);
  `INSERT OR REPLACE INTO sqlite_sequence` then **never conflicts**
  (`sqlite_sequence` has no unique constraint), so it appends a second row,
  and SQLite reads the first one.
- Suggested change: `UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE
  name = ?`, inserting only when no row was updated.

### Issue 5 — severity: minor, category: types/DX
**`ExportChunk` does not typecheck over an RPC stub.** Calling
`stub.__claydoExport(...)` (needed for resume tooling, custom drivers, or
tests) yields TS2339 `Property 'cursor' does not exist on type 'never'`:
the return type collapses to `never` under workers RPC typing because
`ExportChunk.kv` is `[string, unknown][]`. The library's own driver hides
this behind `as unknown as ExportableStub` casts; consumers have to
discover the same cast themselves. Suggested: make the KV value type a
serializable union, or ship a typed `ExportableStub` helper type.

### Issue 6 — severity: minor, category: observability
**Handled export failures still print scary "uncaught exception" logs.**
Every `WITHOUT ROWID`/virtual-table rejection prints, e.g.:

```
uncaught exception; source = Uncaught (in promise); stack = Error: claydo: table 'wor_t' is WITHOUT ROWID, which the exporter does not support yet. ...
```

even though `migrateInstance` catches it and rolls back cleanly. During
debugging this reads like a crash in the Durable Object when it is actually
a handled, rolled-back failure. Suggested: note this in the README, or
restructure the export-side throw so workerd does not double-report it.

### Issue 7 — severity: nit, category: API consistency
`MigrationSummary.rows` omits tables that had zero rows (`base_notes`
missing from the summary) while the exporter's verification totals include
them. Diffing the summary against a table inventory needs a special case.

### Issue 8 — severity: nit, category: docs
Alarm semantics are under-documented: the importer clamps re-armed alarms
to `max(alarm, now + 1s)` (observed and reasonable, but undocumented), and
an already-past alarm races the seal — it either fires on the old side just
before sealing (its side effects then migrate as ordinary data; the test
pins this outcome by waiting) or falls into Issue 3's swallow window.

## 4. Debugging experience

Good: error messages are the best part of this library. Every failure named
the instance, the kind(s), and the next action ("Seal it with
__claydoSeal() before exporting…", "Abort with __claydoAbortImport() and
retry"). The rollback wrapper message states the recovery status inline.
The `stub.stub` escape hatch made `runDurableObjectAlarm` painless, and
`__claydoImportStatus()` being side-effect-free (it never initializes the
target) made "is the target clean?" checks safe — whereas any ordinary
method call would have pinned the kind and poisoned the test.

Bad: the two silent-corruption bugs (Issues 1 and 4) were only catchable
because I fingerprinted with content checksums and `typeof()` signatures —
the library's own verification (row/KV counts) is satisfied while data is
destroyed, which is the worst possible failure mode for a migration tool.
The "uncaught exception" noise (Issue 6) sent me hunting for a crash that
did not exist, and the `never`-typed export surface (Issue 5) forced casts
before I could even write the resume-style probe. Also note vitest hides
`console.log` from passing tests unless you use `--reporter=verbose`, which
cost a few minutes when reading probe output.

## 5. Verdict

The pipeline architecture is right — seal → stream → verify → pin, clean
rollback, resumability, exact scalar/BLOB/KV fidelity, triggers correctly
suppressed during copy — and when it fails on declared limits it fails
loudly and recoverably. But this is a *migration* tool, and it can corrupt
or drop data **while reporting success** in four distinct ways: alias-PK
column order (Issue 1), `__claydo*` user keys (Issue 2), in-flight alarms
(Issue 3), and AUTOINCREMENT id reuse (Issue 4). Issues 1 and 4 are
ordinary SQLite schemas, not exotica. Until verification checksums content
(not just counts) and those four are fixed, I would only trust it with
production data after fingerprinting both sides myself — which is exactly
the work the library should be doing for me.

**Score: 5/10.** Would not run against production data unaudited today;
would happily re-score 8+ once Issues 1–4 land, because everything else
held up under real abuse.

## 6. Post-fix verification

Re-audited after the hardening pass. Same gauntlet, same fingerprints; the
four `BUG:` tests were flipped to `FIXED:` assertions with the same rigor
(exact expected values, checksum + storage-class equality). Result:
**13/13 tests green, exit code 0**, `tsc` clean.

### Issue-by-issue status

**Issue 1 (alias-PK column position) — FIXED.**
`ExportChunk.rows` gained a `rowid` field (`"__rowid__"` or the alias
column's name), and the importer maps columns by it instead of assuming
column 0. My `alias_second (label TEXT, id INTEGER PRIMARY KEY)` table now
arrives byte-exact:

```
before: [[1,"alpha",1],[2,"beta",2],[3,"gamma",3]]
after:  [[1,"alpha",1],[2,"beta",2],[3,"gamma",3]]   (was [[1,null,1],...])
```

Full fingerprint equality (ordered-row checksum **and** `typeof()` storage
classes). The root suite gained the regression test "preserves rowid-alias
tables whose primary key is not the first column".

**Issue 2 (`__claydo*` user KV keys) — FIXED.**
The filter is now the exact reserved-key set (`__claydo:sealed`,
`__claydo:kind`, `__claydo:import`; see `RESERVED_STORAGE_KEYS` in
`migrate-wire.ts`). All **199 of 199** seeded keys migrate
(`summary.kv === 199`, previously 197); on the new side
`__claydonote === "user data that merely looks library-ish"` and
`__claydo_config` deep-equals its source. The old/new KV fingerprints
(key list + deterministic value digests) are identical. The shadow-instance
corollary is fixed too: `__claydoHasData()` now returns `true` for an
instance whose only data is `__claydonly`, and its migration transfers
`kv: 1` instead of stranding the data.

**Issue 3 (alarms elapsing while sealed) — FIXED.**
An alarm firing on a sealed instance (without a move marker) now **defers
itself** to `now + 60s` with a `console.warn`, instead of returning success
and letting the runtime delete it. Verified end to end: forced the alarm
during the sealed window (`runDurableObjectAlarm → true`), the final export
chunk captured the deferred timestamp (observed ~60s after arming, within
my asserted 50–70s window), `summary.alarm` carried it, the new side
scheduled it exactly, and the handler fired there. After the move marker is
recorded, the old instance's alarm is deleted
(`runDurableObjectAlarm(old) → false`), so it can never double-fire.

**Issue 4 (sqlite_sequence duplicates / id reuse) — FIXED.**
The importer now does DELETE-then-INSERT on `sqlite_sequence` ("no unique
constraint, so replace by hand"). After migrating the table with
`max(id)=7, seq=10`:

```
sqlite_sequence: [["autoinc_t",10]]        (was [["autoinc_t",7],["autoinc_t",10]])
next insert id:  11                         (was 8 — a recycled deleted id)
```

**Issue 5 (ExportChunk collapses to `never` over RPC stubs) — UNCHANGED,
documented workaround.** My manual export walk still needs
`as ExportChunk` casts on the raw stub; the sanctioned pattern is to type
manual old-stub code as the exported `ExportableOldStub` interface rather
than `DurableObjectStub<OldClass>`.

**Issue 6 (uncaught-exception log noise for handled export failures) —
UNCHANGED (inherent).** Old-side throws still cross raw RPC, so workerd
still prints, verbatim:

```
uncaught exception; source = Uncaught (in promise); stack = Error: claydo: table 'wor_t' is WITHOUT ROWID, which the exporter does not support yet. ...
```

The repo's tests (and now mine) use a try/catch `expectRejects` helper so
vitest at least reports no unhandled errors.

**Issue 7 (`summary.rows` omits zero-row tables) — UNCHANGED** (`base_notes`
still absent from the summary while export totals include it). Offset by a
real improvement: `MigrationSummary.reason` now says *why* a run was
skipped (e.g. `"already migrated"`, `"old instance has no data (pass
allowEmpty to migrate schema-only instances)"`).

**Issue 8 (alarm semantics under-documented / racy) — IMPROVED.** The
past-alarm race is now safe on both branches: fires pre-seal (effects
migrate as data) or defers through the sealed window (Issue 3 fix). The
`max(alarm, now + 1s)` import clamp is unchanged; near-future timestamps
still transfer to the millisecond.

### Behavior changes worth knowing (not regressions)

- **Unsupported tables now fail pre-flight.** The driver's `hasData` probe
  walks the table list before sealing or reserving anything, so WITHOUT
  ROWID / virtual-table errors surface as the **raw** exporter message
  (no "was rolled back" wrapper — there is nothing to roll back). Verified:
  old instance never sealed, fingerprint bit-identical, target status `{}`,
  and drop-then-retry migrates cleanly. Strictly better than the old
  seal→fail→unseal churn, but anyone matching on the wrapped error string
  must update.
- **Empty instances are skipped by default.** Schema-only migration now
  requires `allowEmpty: true`; without it the run returns
  `skipped: true` with the reason quoted above and touches nothing (no
  sealed husks from stale registry entries). With the flag, DDL-only
  migration works exactly as before (1 chunk, `ghost_table` + `ghost_idx`
  arrive).
- **Imports are reserved and owned.** `__claydoBeginImport(kind, token)`
  blocks target traffic from reservation on, concurrent drivers fail fast
  ("another migration driver owns the import"), and stale imports (>30s
  without progress) are adopted. My manual-chunk probes had to adopt the
  new protocol; `migrateInstance` callers are unaffected.
- Sealed `fetch()` is now a generic 410 with an `x-claydo-sealed: 1` header,
  and `wipeTarget()` provides a sanctioned recovery for polluted targets.

### Regression sweep

The full gauntlet re-passed unchanged: non-UTF8 blobs, rowids `-5` and
`2^40`, 100 KB unicode/control-char text, REAL-in-no-affinity-column storage
classes, NULL vs. empty string vs. empty blob, Date/Map/ArrayBuffer/nested
KV values across pages, triggers suppressed during copy (audit table exact),
partial-index WHERE preserved, UNIQUE enforced, views live, and the
2000-row run: **41 chunks, ~130 ms**, fingerprints identical.

### Post-fix verdict

All four data-fidelity findings are genuinely fixed — not patched around —
and each is locked in by a regression test in the root suite as well as
this gauntlet. The remaining flaws are cosmetic (log noise, a typing
papercut, a summary-shape nit). My one structural reservation stands:
verification is still count-based rather than content-checksum-based, so a
future fidelity bug of the Issue-1 shape would again pass silently — the
fingerprinting this audit did belongs in the library. The migration flow
itself got *safer* than what I audited (reservation before seal, ownership
tokens, stale adoption, pre-flight checks, wipeTarget recovery).

**Score: 8.5/10.** Yes — I would now trust it with production data, with
the standard precaution the design already encourages: keep the sealed old
instances around until you have spot-checked the new side.
