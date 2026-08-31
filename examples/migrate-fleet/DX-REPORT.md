# DX Report: `claydo/migrate` — bulk fleet migration (`examples/migrate-fleet`) — historical pre-facet audit

> **Facet-native update (2026-08-31).** This example now imports `DurableObject`
> from claydo and runs every kind in an isolated Durable Object facet. The
> supervisor keeps routing, kind identity, migration state, and virtualized
> alarms outside user storage. The tests were updated for the new lifecycle:
> `deleteAll()` cannot erase kind identity, post-delete writes and alarms are
> preserved, and stable public stubs survive facet eviction. The detailed report
> below is the original build-time audit; findings about shared host storage,
> `__claydo:kind` in user data, or kind-less husks are historical and are
> resolved by this refactor.

Audit performed against the workspace sources (`src/migrate.ts`, `src/migrate-wire.ts`,
`src/host.ts`) with vitest 4 + `@cloudflare/vitest-pool-workers` 0.22, compatibility
date 2026-08-01. All quoted errors are verbatim from test runs.

## 1. What I built

A realistic bulk migration of an existing Durable Object binding into a claydo kind:

- **`worker.ts`** — `SessionImpl`, a "finished" session class with a SQLite
  `events` table (AUTOINCREMENT id + secondary index), a plain `tags` table,
  KV preferences under `pref:` keys, an alarm, and a method surface
  (`record`, `history`, `setPref`/`getPref`, plus helpers). Four bindings:
  `OLD_SESSIONS` (= `exportable(SessionImpl)`), `APP_DO` (= `union({ session,
  audit }, { importable: ["session"] })` — `audit` deliberately not importable),
  and a secret-protected pair `OLD_SECURE` / `SECURE_DO` (both configured with
  `secret: "s1"`). The Worker's `fetch` routes `/session/:name` through
  `migrated(..., { strategy: "manual" })`.
- **`test/fleet.test.ts`** — seeds 10 old instances (3–12 events, 0–2 tags, 1–2
  prefs each, tracked in a plain-array name registry), snapshots them, serves
  them through the manual router, migrates the whole fleet with
  `migrateInstance` in a loop, verifies every instance byte-for-byte
  (`toStrictEqual` on full history including AUTOINCREMENT ids and original
  timestamps, tags, prefs), checks AUTOINCREMENT continuation, asserts the
  cutover state (every old instance sealed: RPC throws, fetch 410; every new
  instance live), re-runs the fleet (idempotency at scale), and verifies
  summary truthfulness (exact per-table rows, KV count, chunk arithmetic,
  alarm timestamp + re-armed alarm firing).
- **`test/probes.test.ts`** — adversarial probes: crash-resume; unseal-then-
  mutate between crash and resume (torn snapshot); two concurrent
  `migrateInstance` calls for the same instance; the full secrets matrix
  (none / wrong / right / old-side-only / host-side-only); import gating into a
  non-importable kind with rollback proof; a raw import whose declared kind
  contradicts the target name prefix; migrating a name that never existed;
  router behavior mid-import; stale router `fetch()` after an external
  migration; and normal kind traffic racing a migration of the same name.

**Name registry note:** the tests simulate the registry as a plain array,
because Cloudflare cannot enumerate a namespace's instance names. A real app
must already own this list — a D1/SQLite table written on instance creation, a
KV set, or one dedicated claydo "registry" instance. Without it, bulk
migration is impossible, and stale entries in it matter (see issue 4: migrating
a stale name fabricates instances).

Final state: **24 tests, all green** (`npx vitest run --config
examples/migrate-fleet/vitest.config.ts`, exit 0; `tsc --noEmit -p
examples/migrate-fleet/tsconfig.json`, exit 0).

## 2. What worked well

- **Data fidelity is genuinely excellent.** Every fleet instance survived
  `toStrictEqual` on the full row set: AUTOINCREMENT ids, original
  timestamps, KV values, tag ordering by rowid. The `sqlite_sequence` copy
  works — a post-migration `record()` continued exactly at `lastId + 1`.
  Indexes and the pending alarm moved; `runDurableObjectAlarm` on the new
  instance fired the kind's `alarm()`.
- **The chunk protocol is honest and robust.** With `maxRowsPerChunk: 2` the
  chunk count was exactly predictable (DDL+KV page, then row pages per table,
  then a final metadata chunk = 7), and `summary.rows`/`summary.kv`/
  `summary.alarm` matched reality. Under two racing drivers, per-chunk `seq`
  dedup kept the data perfectly correct — no duplicate rows, ever, in any
  probe.
- **Crash-resume and torn-snapshot handling are right.** A simulated crash
  (seal + one chunk) resumed (`resumed: true`) and produced identical data. An
  unseal + mutation between crash and resume was detected, the partial import
  discarded, and the migration restarted from scratch — the final state
  included the mutation and the overwritten KV value, with nothing stale left
  behind.
- **Rollback on failure works as promised.** Migrating into the
  non-importable `audit` kind failed with a precise, actionable error and the
  old instance immediately served writes again.
- **Most error messages are the best I've seen in this space.** They name the
  instance, both kinds, and usually the fix:
  `claydo: imports are not enabled for kind 'audit'. Pass { importable: true } or { importable: ["audit"] } to union().`
  and
  `claydo: the target name 'audit:mismatch' implies kind 'audit', but the import declares kind 'session'.`
- **The manual router did its job for RPC.** Before migration it served the
  old side, after migration the new side, and a cached "old" route that hit a
  freshly sealed instance healed itself and retried on the new side (RPC path
  only — see issue 5).
- **The README's migration section is well-structured** — the four-step order
  (wrap, enable imports, move, cut over) matched what I actually had to do,
  and the "What moves, and the guarantees" paragraph is accurate about
  ordering, resume, and idempotency in the single-driver happy path.

## 3. Papercuts and issues

### Issue 1 — Concurrent traffic pins an empty target, silently serves wrong data, and bricks the migration with no recovery path

- **Severity:** blocker
- **Category:** safety / concurrency
- **Repro:** seed `p-traffic` on the old binding (3 events), then
  `Promise.allSettled([migrateInstance({ from, to, name }), kinds(env.APP_DO).session.get(name).history()])`.
- **Observed (verbatim):** the read wins and fulfills with `[]` — a silently
  wrong answer for a session that has 3 events. The migration loses:

  ```
  claydo: migration of 'p-traffic' to kind 'session' failed and was rolled back (old instance unsealed): claydo: instance 'session:p-traffic' is live as kind 'session'. Imports only target untouched instances.
  ```

  Every subsequent `migrateInstance` re-run refuses:

  ```
  claydo: both the old instance 'p-traffic' and the new instance 'session:p-traffic' are live. Refusing to migrate. If the new instance is the source of truth, seal the old one; otherwise wipe the new instance before migrating.
  ```

  Three compounding problems: (a) the message's **first** suggestion ("seal
  the old one") would destroy all 3 events here — the safe option is listed
  second, with no way to tell which applies; (b) there is **no public API to
  wipe the new instance** — `__claydoAbortImport` returns `false` when no
  import state exists, and even a test-harness `storage.deleteAll()` inside
  the DO does not help because the host caches `#kind`/`#impl` in memory (my
  test proves the refusal persists after a wipe); (c) the empty read is
  silent data corruption from the caller's perspective.
- **Expected:** the target should be claimed before it can be pinned by
  stray traffic, wrong-side reads should fail loudly, and a bricked target
  should be recoverable.
- **Suggested library change:** make the driver **claim the target before
  sealing the old instance** — e.g. a `__claydoBeginImport(kind, secret)`
  that atomically verifies "untouched" and writes the import state. Today the
  order is seal-old → export → first-import, so between the status check and
  the first chunk any `get(name)` call pins the kind. Note this window exists
  **even for apps that follow the README and route everything through
  `migrated()`**: the router routes "new" as soon as the old side is sealed,
  which happens before the import state exists (code path:
  `resolve()` in `src/migrate.ts` — seal check precedes any import-state
  awareness). Additionally: swap the order of the two suggestions in the
  "both live" message (or include row/KV counts for both sides so the
  operator can see which side is empty), and expose a public
  `wipeUntouched()`/`abortImport()` driver helper that works on a pinned but
  empty instance.

### Issue 2 — Duplicate concurrent drivers: the loser's rollback unseals the old instance after the winner completed (split-brain)

- **Severity:** major
- **Category:** safety / concurrency
- **Repro:** `Promise.allSettled([run(), run()])` where `run()` is the same
  `migrateInstance({ ..., maxRowsPerChunk: 1 })` for `p-race`.
- **Observed (verbatim):** exactly one driver wins with correct data
  (`chunks: 6, kv: 2, rows: { events: 3, tags: 1 }` — seq dedup is sound).
  The loser throws:

  ```
  claydo: migration of 'p-race' to kind 'session' failed and was rolled back (old instance unsealed): claydo: instance 'session:p-race' is already live as kind 'session'. Imports only target untouched instances.
  ```

  The parenthetical is the bug: the rollback **really did unseal the old
  instance**, even though the migration had just completed successfully.
  `__claydoSealed()` on the old side returns `{"sealed":false}`, both sides
  are now live, and the re-run that should say `{ skipped: true }` instead
  refuses:

  ```
  claydo: both the old instance 'p-race' and the new instance 'session:p-race' are live. Refusing to migrate. If the new instance is the source of truth, seal the old one; otherwise wipe the new instance before migrating.
  ```

  Direct old-binding callers can now write to the old instance and those
  writes are lost to the new side. (The `migrated()` router at least
  fail-stops on this state with a "Fix the split" error.) The remediation —
  manually re-sealing the old instance — is safe here because the data is
  identical, but nothing tells the operator that.
- **Expected:** the losing driver should recognize "the target completed the
  same migration" and return `{ skipped: true }` (or a distinct error) while
  **leaving the seal in place**.
- **Suggested library change:** in `migrateInstance`'s catch block, before
  unsealing, re-check `__claydoImportStatus`; if `status.kind === target.kind`
  and no import is in progress, the migration is complete — do not unseal, do
  not abort, return skipped. Duplicate drivers are not exotic: a retried cron
  or a redelivered queue message is enough.

### Issue 3 — The library's own test suite (and the documented test pattern) fails the vitest run

- **Severity:** major
- **Category:** testing / DX
- **Exact repro:** `npx vitest run` at the repo root, unmodified checkout.
- **Observed (verbatim):** all 38 tests pass, but the process exits 1:

  ```
  Vitest caught 2 unhandled errors during the test run.
  This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.
  ⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯
  Error: claydo: instance 'm9' is sealed. A migration is in progress.
  ```

  The trigger is `await expect(oldStub.method()).rejects.toThrow(...)` on a
  sealed instance: the seal-guard rejection travels as a native RPC rejection
  and `expect().rejects` leaves an extra unhandled rejection behind (isolated
  in a minimal test: try/catch and `.then(onRejected)` are clean; only
  `expect().rejects` trips it). My first draft copied the pattern from
  `test/migrate.test.ts` and got 10 unhandled errors — one per fleet
  instance — turning a fully green suite into exit code 1.
- **Expected:** the repo's own `npm test` should exit 0, and the natural
  assertion pattern should not poison the run.
- **Suggested library change:** fix the repo tests (try/catch or
  `.rejects` on a wrapped promise), investigate whether the seal wrapper can
  avoid the double-delivery (it may interact with JS RPC stub disposal), and
  add a "Testing" note documenting the safe pattern for asserting sealed
  errors.

### Issue 4 — Migrating a name that never existed fabricates and seals an instance, and reports success

- **Severity:** major
- **Category:** correctness / API contract
- **Repro:** `migrateInstance({ from: old("p-ghost"), to: sessions(), name: "p-ghost" })`
  where `p-ghost` was never touched.
- **Observed (verbatim):** summary
  `{"skipped":false,"resumed":false,"chunks":1,"kv":0,"rows":{},"alarm":null}`;
  the old side afterwards:
  `{"sealed":true,"movedTo":"d4a2a4c009dfd308620c5ccc4111f7713fc08c22d488a2e9d67dc000eb784836"}`.
  The driver materialized the never-existing old instance (its constructor's
  `CREATE TABLE`s ran), sealed it forever, copied the empty schema, and pinned
  the kind on an empty new instance — then reported a successful migration.
  This directly contradicts the `MigrationSummary.skipped` doc: *"True when
  there was nothing to do (already migrated, **or old instance empty**)"* —
  that branch only fires when the target is already live.
- **Expected:** `{ skipped: true }`, no seal written, no instance created on
  either side. A bulk driver's registry will contain stale names; each one
  currently becomes two junk instances plus a misleading "migrated" result.
- **Suggested library change:** call `__claydoHasData()` before sealing;
  if empty and the target is untouched, return
  `{ skipped: true, ... }` without touching either side.

### Issue 5 — Router `fetch()` lacks the seal-retry that RPC has: stale 410s after an external migration

- **Severity:** major
- **Category:** routing / correctness
- **Repro:** `migrated(env.OLD_SESSIONS, sessions(), { strategy: "manual", oldRouteTtlMs: 60_000 })`;
  prime the cache with one RPC call (routes old); run `migrateInstance`
  externally; then call `facade.get(name).fetch("https://do/")`.
- **Observed (verbatim):** HTTP 410 with body

  ```
  claydo: instance 'p-router-fetch' is sealed. It moved to Durable Object id c8d720dc95d841697bb4ef2a606171f73efbee401af53817f331192fe6b842cf; route traffic through the claydo binding.
  ```

  The caller **is** routing through the claydo transitional binding — the
  advice is ironic. An RPC call on the same facade heals the route (the
  documented seal-retry), after which `fetch()` works; but a pure-`fetch()`
  workload (WebSocket/HTTP kinds — exactly the kinds that must use `fetch`)
  serves 410s for up to `oldRouteTtlMs` (default 30 s) per Worker isolate
  after every externally driven migration under `manual` — the flagship
  combination for bulk fleets.
- **Expected:** `fetch()` through the facade retries on the new side when the
  old side answers the seal 410, exactly like the RPC path does.
- **Suggested library change:** in `migrated()`'s facade `fetch`, detect the
  seal response (status 410 plus a marker — a header would be more robust
  than message sniffing), drop the cached route, re-resolve once, and retry
  on the new side.

### Issue 6 — Secret failures are context-free and indistinguishable

- **Severity:** minor
- **Category:** error quality
- **Repro:** any of: no secret / wrong secret against the `s1` pair; no secret
  against a host-only or old-only secret configuration.
- **Observed (verbatim):** in all four scenarios, the identical
  `claydo: invalid migration secret.` — no instance name, no indication of
  which side (old exporter vs. new host) rejected, and, unlike every failure
  inside the chunk loop, **no** `migration of '<name>' to kind '<kind>' failed`
  wrapper, because the pre-loop calls (`__claydoImportStatus`,
  `__claydoSeal`) sit outside `migrateInstance`'s try/catch. In a loop over
  200 instances, the thrown error does not even tell you which instance
  failed.
- **Expected:** something like `claydo: invalid migration secret (rejected by
  the import host for 'session:sec-none')`, wrapped with the standard driver
  context.
- **Suggested library change:** include the instance identity and role in
  `#auth`/`#checkMigrationAuth` messages, and widen `migrateInstance`'s
  try/catch (or add a second wrapper) so pre-loop failures also carry the
  `migration of '<name>'` context.

### Issue 7 — One-sided secret configurations are silently accepted

- **Severity:** minor
- **Category:** security / configuration
- **Repro:** old side `exportable(Impl, { secret: "s1" })`, host side plain
  `union(...)` (no secret); driver passes `secret: "s1"`.
- **Observed:** the migration succeeds; the host simply ignores the supplied
  secret (and vice versa for host-only). The mismatch story is *coherent* —
  each side enforces only its own configuration, and the failure direction
  (driver missing a secret a side requires) is always rejected — but a
  deployment that forgot to configure the secret on one side is
  indistinguishable from a correct one. Combined with issue 6 (no side
  attribution), diagnosing "which side did I misconfigure" is guesswork.
- **Expected/suggested:** at minimum document the asymmetry in the README
  ("the secret is enforced per side; passing a secret to an unprotected side
  is silently accepted"). Nice-to-have: host warns (`console.warn`) when a
  secret is presented but none is configured.

### Issue 8 — `summary.rows` omits zero-row tables

- **Severity:** minor
- **Category:** API contract / observability
- **Repro:** migrate any instance with an empty table (fleet members with 0
  tags; or the ghost in issue 4).
- **Observed (verbatim):** vitest diff from my first run:

  ```
  - { "events": 0, "tags": 0 }
  + {}
  ```

  and `expected undefined to be +0` for `summary.rows["tags"]`. The exporter's
  `totals.rows` includes every table (that is what verification checks), but
  the ack's `applied.rows` — which becomes `summary.rows` — only gains keys
  when a chunk actually carries rows. A verification-oriented caller
  (`assert(summary.rows[t] === expected[t])`) hits `undefined` and cannot
  distinguish "table copied, empty" from "table not seen at all".
- **Expected:** `rows` lists every migrated table, with `0` for empty ones.
- **Suggested library change:** seed `state.applied.rows` with `0` for each
  entry of `chunk.tables` in the first chunk (or merge `totals.rows` keys
  into the final ack).

### Issue 9 — Mid-import traffic is answered with HTTP 400 (and RPC errors) rather than a retryable signal

- **Severity:** minor
- **Category:** error quality / HTTP semantics
- **Repro:** apply one import chunk manually, then call the target:
  `sessions().get(name).history()` and `sessions().get(name).fetch(...)`.
- **Observed (verbatim):** RPC throws
  `claydo: instance 'session:p-midimport' is importing kind 'session'. Traffic is blocked until the migration completes or is aborted.`
  and `fetch()` answers **400** with the same text. The message is good, but
  400 ("your request is malformed") is the wrong signal for "temporarily
  unavailable, retry shortly" — clients and proxies will not retry a 400. The
  `migrated()` router also surfaces this error directly to callers instead of
  waiting or retrying, so during each instance's copy window, router users see
  hard errors.
- **Expected:** 503 with `Retry-After` for the import-blocked state; ideally
  the router recognizes "importing" and briefly retries/waits before failing.
- **Suggested library change:** distinguish "no kind / bad access" (400) from
  "import in progress" (503) in the host's `fetch()` error path.

### Issue 10 — README/API gaps around migration

- **Severity:** nit
- **Category:** documentation
- **Details:**
  - The API section documents `union(kinds)` with no mention of the options
    bag — `importable` and `secret` are only discoverable in the migration
    walkthrough or the JSDoc.
  - `MigrationSummary`'s shape, `oldRouteTtlMs`, and the route-caching
    semantics of `migrated()` ("new is cached forever, old expires") are not
    in the README; I had to read `src/migrate.ts` to predict router behavior.
  - Nothing warns that plain-accessor traffic to a not-yet-migrated name is
    dangerous during the transition (issue 1) — the README shows `migrated()`
    as an option ("Or lazily…"), not as a requirement for safety.
  - The seal-error assertion pitfall (issue 3) belongs in the Testing section.

### Issue 11 — Sealed-instance rejections spam "uncaught exception" logs server-side

- **Severity:** nit
- **Category:** observability / noise
- **Repro:** any RPC call to a sealed old instance, even when the caller
  handles the rejection.
- **Observed (verbatim, once per call):**

  ```
  uncaught exception; source = Uncaught (in promise); stack = Error: claydo: instance 'sess-00' is sealed. It moved to Durable Object id 3076c7...; route traffic through the claydo binding.
      at OldSession.wrapper (/workspace/src/migrate.ts:167:31)
  ```

  After cutting over a large fleet, every straggler request to the old
  binding emits one of these with a full stack. At 10 instances it filled my
  test output; at production fleet scale it would drown a log pipeline.
- **Suggested library change:** investigate why the wrapper's rejection is
  double-reported (likely the same root cause as issue 3); consider having
  the seal wrapper log one structured line instead.

## 4. Debugging experience narrative

Getting the happy path running was fast: the two-binding harness in
`test/fixtures/worker.ts` + `test/migrate.test.ts` is an excellent template,
and copying its wrangler/vitest shape worked first try. Two small snags on the
way in: `sql.exec<T>` rejects an `interface` row type (TS needs an anonymous
object type for the implicit index signature — a Workers-types quirk worth a
docs note, since every kind author will hit it), and vitest 4 swallowed my
`console.log` diagnostics until I found `--disable-console-intercept`.

The first full run was the low point. My suite was functionally green but the
run **failed with 10 "unhandled errors"**, all of them seal rejections I had
asserted with `expect(...).rejects.toThrow(...)` — the exact pattern the
library's own tests use. Debugging that meant writing a three-way isolation
test (try/catch vs `.rejects` vs `.then(onRejected)`), and then discovering
that the library's own `npx vitest run` exits 1 the same way. Until that's
fixed, every adopter who copies the repo's test style inherits a broken CI
signal that has nothing to do with their code.

The adversarial probes were where the library both shone and cracked. The
positive surprise: I could not corrupt data. Torn snapshots were detected,
duplicate chunks deduped, verification totals honest — every byte-level check
passed on the first attempt. The negative surprise: the *state machine around*
the data is fragile. Both concurrency probes (duplicate drivers; traffic
racing a migration) ended in a "both live" state that `migrateInstance`
itself created and then refused to fix, and in the traffic race the refusal
message's first suggestion would have deleted real data. Confirming there was
truly no recovery path took the longest of any probe: I wiped the pinned
target's storage via `runInDurableObject` and the refusal *persisted*,
because the host caches the kind in memory — that behavior is invisible
unless you read `src/host.ts`.

Error messages deserve praise: nearly every failure named the instance, both
kinds, and a next step, which made the probes fast to interpret. The two
exceptions were the context-free `claydo: invalid migration secret.` (which
side? which instance?) and the 410 body that tells you to "route traffic
through the claydo binding" while you are literally calling through
`migrated()`.

## 5. Verdict

**Score: 6.5 / 10.**

Would I trust it to migrate production data? **The copy engine, yes — the
operational envelope, not yet.** The data plane is genuinely production-grade:
byte-exact fidelity including rowids, sequences, indexes and alarms; honest
verification; correct resume; correct torn-snapshot restart; idempotent
re-runs. In every probe, the data that landed on the new side was correct, and
no probe produced silent corruption *of migrated data*.

What I cannot yet trust is what happens around the edges of a real rollout:
one stray read during the copy window serves fabricated empty data, bricks the
instance with no recovery API, and offers a destructive first suggestion
(issue 1); a retried cron re-opens the old side for writes after a completed
migration (issue 2); a stale registry entry becomes two sealed junk instances
reported as success (issue 4); and pure-fetch workloads eat 30 seconds of 410s
after each manual migration (issue 5). Every one of these is reachable from
ordinary operational events — retries, stale registries, traffic — not from
adversarial abuse. Issues 1, 2, and 4 look like small, local fixes (claim the
target first; re-check status before unsealing; check `__claydoHasData` before
sealing). With those plus a green `npm test` (issue 3), this would be an
8.5–9: the hard part — a correct, resumable, verifiable copy protocol — is
already done.

## 6. Post-fix verification

Re-audited after the hardening pass (target reservation, import ownership,
move markers, empty-instance skip, `wipeTarget()`, synchronous seal guards,
router fetch retry). The suite was updated to assert the new behavior with
the same precision — now **25 tests, all green** (`set -o pipefail; npx
vitest run --config examples/migrate-fleet/vitest.config.ts` exits 0;
`tsc --noEmit` clean). All quoted errors below are verbatim from the
re-verification runs.

### Issue 1 (blocker — traffic pollution, bricked target, no recovery): **fixed in substance, window narrowed but not zero**

- **Reservation works.** With an import reserved (`__claydoBeginImport`),
  target traffic no longer initializes an empty instance; it fails with
  `claydo: instance 'session:p-midimport' is importing kind 'session'. Traffic is blocked until the migration completes or is aborted.`
  and the `migrated()` router no longer surfaces that error — it polls until
  the migration finishes and then serves the new side (verified by running a
  router read concurrently with the completing migration).
- **Recovery exists and works end-to-end.** After a polluted target, the
  refusal now leads with the correct remediation:

  ```
  claydo: both the old instance 'p-traffic' and the new instance 'session:p-traffic' are live. Refusing to migrate. If racing traffic polluted the new instance (it has no real data), wipe it with wipeTarget() from claydo/migrate and re-run. If the new instance is the source of truth, seal the old one with __claydoSeal() — its data will NOT be copied.
  ```

  The dangerous option is now last, is explicit about the consequence ("its
  data will NOT be copied"), and `wipeTarget()` genuinely unbricks: my test
  wipes and re-migrates successfully, byte-checked — the in-memory kind pin
  that previously survived a storage wipe is cleared too.
- **The driver no longer makes things worse.** In the same race, the
  migration now refuses at reservation, *before* sealing the old side — the
  old instance stays unsealed and fully intact (previously it was sealed,
  then blindly unsealed by the rollback).
- **Residual:** a plain-accessor read that lands in the window *before* the
  driver's reservation still pins an empty instance and still answers with a
  silently wrong `[]` (my race test reproduces this deterministically). It
  is now recoverable and loudly refused on the next driver run, and callers
  that follow the README and route through `migrated()` are not exposed
  (the router routes "old" until the old side seals, which now happens after
  reservation). Downgraded from blocker to a documented minor sharp edge.

### Issue 2 (major — duplicate drivers unseal after completion): **fixed**

The loser now fails fast at reservation, before touching anything:

```
claydo: another migration driver owns the import on instance 'session:p-race' (last progress 2ms ago). It is not stale yet; retry later.
```

Verified: exactly one winner with correct, non-duplicated data; the old
instance **stays sealed** with the move marker recorded
(`movedTo` = the target's Durable Object id); no "rolled back" path runs;
and the re-run returns `{ skipped: true, reason: "already migrated" }`
instead of the previous "both live" refusal. The crashed-driver story is
also coherent now: a fresh import is owned (same fail-fast error), and a
backdated (~30 s stale) import is adopted and resumed (`resumed: true`,
byte-identical data) — the torn-snapshot restart still works on top of
adoption.

### Issue 3 (major — repo `npm test` exits 1): **fixed**

Unmodified repo checkout: `npx vitest run` → 46 tests passed, exit 0, zero
vitest unhandled errors. The repo tests now use a try/catch `expectRejects`
helper instead of `expect(...).rejects` for raw-RPC seal throws; my suite
keeps the equivalent `messageOf` pattern.

### Issue 4 (major — ghost fabrication): **fixed**

Migrating a never-existing name now returns

```
{"skipped":true,"reason":"old instance has no data (pass allowEmpty to migrate schema-only instances)","resumed":false,"chunks":0,"kv":0,"rows":{},"alarm":undefined}
```

with **nothing** sealed or created on either side (old unsealed, target has
no kind and no import state — both asserted). The documented `allowEmpty:
true` opt-in performs the schema-only migration when you actually want one.

### Issue 5 (major — router fetch() stale 410s): **fixed**

With a cached "old" route and an externally completed migration, the facade
`fetch()` now detects the marked 410 (`x-claydo-sealed: 1`, exported as
`SEALED_HEADER`), re-resolves, and retries: the caller receives a 200 served
by the kind instance (body confirms `raw=session:p-router-fetch`). No stale
410 window remains.

### Issue 6 (minor — context-free secret errors): **unchanged**

All four secret failure scenarios still produce the identical, bare
`claydo: invalid migration secret.` — no instance name, no side attribution,
no driver context wrapper.

### Issue 7 (minor — one-sided secrets silently accepted): **unchanged**

Old-side-only and host-side-only secret configurations still silently accept
the extra/ignored secret. The README still does not call this out.

### Issue 8 (minor — `summary.rows` omits zero-row tables): **unchanged**

An `allowEmpty` migration of a schema-only instance reports `rows: {}`
instead of `{ events: 0, tags: 0 }`; fleet members with zero tags still omit
the `tags` key (my tests still need the `?? 0` workaround).

### Issue 9 (minor — mid-import fetch answers 400): **unchanged**

The target's `fetch()` during an import still answers **400** with the
"is importing kind" text rather than a retryable 503. Practical exposure is
smaller now because the router waits out migrations instead of surfacing the
error, but direct-fetch callers still see a non-retryable status.

### Issue 10 (nit — README/API gaps): **improved**

The migration walkthrough now documents the reservation ordering, ownership
and staleness, the sealed-fetch header, WebSocket close 1012, alarm
deferral, the empty-instance skip with `allowEmpty`, and the `wipeTarget()`
recovery path — the operational story is genuinely documented now. Still
missing: the API section documents `union(kinds)` without the
`importable`/`secret` options bag, `oldRouteTtlMs` and the
`MigrationSummary` shape appear nowhere in the README, and the Testing
section does not mention the seal-rejection assertion pitfall (the
`expectRejects` pattern lives only in the repo's test code).

### Issue 11 (nit — "uncaught exception" log spam): **unchanged**

Every handled seal/ownership rejection over raw RPC still emits a
workerd-side `uncaught exception; source = Uncaught (in promise)` line with
a full stack (12 in my fully green run). Cosmetic, but at fleet scale it is
real log noise.

### New behavior verified along the way

Beyond my original issues, the re-audit confirmed: the old side is sealed
*without* a move marker during the copy ("A migration is in progress.") and
re-sealed *with* it only after success ("It moved to Durable Object id …"),
at which point the old instance's pending alarm is deleted
(`runDurableObjectAlarm` on the old side returns `false` post-migration,
while the transferred alarm fires on the new side); import chunks without a
prior reservation are refused
(`claydo: no import is reserved on instance 'session:p-name-unreserved'. Call __claydoBeginImport first (migrateInstance does this automatically).`);
and the wrong-kind name check now fires at reservation time, before any
state is written.

### Updated verdict

**Score: 8.5 / 10** (up from 6.5).

Every major and blocking finding is fixed or defused: duplicate drivers are
safe, ghosts are skipped, the router heals fetch traffic, the repo's CI
signal is trustworthy, and — most importantly — the failure states that used
to be unrecoverable dead ends now come with a working, documented recovery
tool whose error messages point the right way. The copy engine was already
production-grade; the operational envelope now mostly is too. I would trust
this to migrate production data, with two provisos: route all transitional
traffic through `migrated()` (the pre-reservation pollution window still
exists for plain-accessor callers, though it is now loud and recoverable),
and budget for the remaining paper cuts — context-free secret errors,
zero-row omission in summaries, and the 400-instead-of-503 mid-import
status — none of which threatens data.
