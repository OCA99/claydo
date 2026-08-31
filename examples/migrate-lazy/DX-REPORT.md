# DX report: `claydo/migrate` — the transitional router (`migrated()`) — historical pre-facet audit

> **Facet-native update (2026-08-31).** This example now imports `DurableObject`
> from claydo and runs every kind in an isolated Durable Object facet. The
> supervisor keeps routing, kind identity, migration state, and virtualized
> alarms outside user storage. The tests were updated for the new lifecycle:
> `deleteAll()` cannot erase kind identity, post-delete writes and alarms are
> preserved, and stable public stubs survive facet eviction. The detailed report
> below is the original build-time audit; findings about shared host storage,
> `__claydo:kind` in user data, or kind-less husks are historical and are
> resolved by this refactor.

Audit of `claydo/migrate` from the perspective of a team moving a
rate-limiter fleet into a claydo kind, centered on the transitional router.
Environment: node 22, vitest 4, `@cloudflare/vitest-pool-workers` 0.22,
`compatibility_date` 2026-08-01. All quoted errors are verbatim from test
runs (`npx vitest run --config examples/migrate-lazy/vitest.config.ts`,
18/18 green).

## 1. What I built

A legacy Worker had two Durable Object bindings: `OLD_BUCKETS` (a token
bucket per API key: `configure(capacity, refillPerSec)`, `take(n)`,
`remaining()`, SQLite-backed, with a `fetch()` handler and hibernating
WebSockets) and `OLD_SESSIONS` (per-user KV session state). Both move into
one claydo host `LimiterDO = union({ bucket: Bucket, session: Session },
{ importable: ["bucket", "session"] })`, with the old classes reused as the
kind implementations (`OldBucket extends exportable(Bucket)`,
`OldSession extends exportable(Session)`).

The Worker's `fetch` routes production-style traffic through two
`migrated()` facades held as per-isolate singletons:

- `bucket`: `strategy: "lazy"` — `POST /limit/:key` migrates an old bucket
  inline on first touch, then serves the kind. Also `PUT /limit/:key/config`
  and a WebSocket route `GET /ws/:key`.
- `session`: `strategy: "drain"` — `POST|GET /session/:id` keeps old
  sessions on the old binding; new session names go straight to the kind.

Two test files: `test/router.test.ts` (intended behavior through the worker
routes, facade metadata, `oldRouteTtlMs: 0` cost measurement) and
`test/probes.test.ts` (first-touch races, a stalled import, both-live
conflicts and both suggested recoveries, cache staleness for RPC vs
`fetch()`, WebSockets to old-routed and freshly sealed instances).

## 2. What worked well

- **The core migration loop is genuinely robust.** Seal → stream → verify →
  pin held up in every probe. Resuming a stalled import worked on the first
  try (`summary.resumed === true`) and the data arrived intact. Re-runs are
  skipped. The repo's `test/migrate.test.ts` was an excellent crib: I copied
  its two-binding harness shape and everything ran on the first attempt.
- **Same-facade concurrency is exactly-once.** Five concurrent first-touch
  `take(1)` calls through one facade produced one migration and five cleanly
  serialized decrements (remaining = {99, 98, 97, 96, 95}). The route cache
  storing the *promise* (not the result) is the right design.
- **The RPC retry-on-sealed path is seamless.** With a 1-hour
  `oldRouteTtlMs` and an external `migrateInstance()`, the next RPC through
  the stale facade transparently re-resolved and answered from the new
  instance with the migrated value. As a caller I could not tell a cutover
  had happened. This is the best moment of the whole API.
- **Drain semantics are exactly as advertised.** Old sessions kept serving
  and taking writes on the old binding, unsealed; a new name landed on the
  kind and left the old namespace untouched.
- **Error messages carry identity.** Nearly every error names the instance,
  the kind(s), and often a next step. `migrateInstance`'s refusal on a live
  target and the out-of-order seq guard ("Another migration driver may be
  running.") read like they were written by someone who has been paged.
- **Setup DX.** `exportable(Bucket)` wrapping, the union registration, the
  wrangler two-migration story, and the vitest plugin all worked without
  reading anything beyond the README section. Typechecking caught my one
  worker-signature mistake.

## 3. Papercuts and issues

### Issue 1 — Racing lazy routers split the fleet permanently

- **Severity:** blocker. **Category:** correctness / concurrency.
- **Repro:** two `migrated(..., { strategy: "lazy" })` facades (two Workers,
  or just two isolates of the same Worker — the *default* production
  topology) touch the same never-migrated name concurrently
  (`probes.test.ts` "two facades" and the deterministic "loser replay").
- **Observed (verbatim):** the loser's callers get

  ```
  claydo: migration of 'race-two' to kind 'bucket' failed and was rolled back (old instance unsealed): claydo: instance 'bucket:race-two' is live as kind 'bucket'. Imports only target untouched instances.
  ```

  The rollback *unseals the old instance* even though the winner already
  pinned the kind. Old seal state after the race:
  `{ sealed: false, movedTo: undefined }`. From then on every fresh facade
  fails with:

  ```
  claydo: both the old instance 'race-two' and the new instance 'bucket:race-two' are live. Fix the split before routing traffic (seal the old instance, or wipe the new one).
  ```

  This is not self-healing: isolates that resolved "new" before the race
  keep working, but every new isolate 500s on that key until an operator
  manually calls `__claydoSeal()` on the old stub. The library's own driver
  manufactures the exact split its router refuses to route.
- **Expected:** the loser recognizes the winner and reports
  `{ skipped: true }`, leaving the seal alone.
- **Suggested change:** in `migrateInstance`'s catch block, re-check
  `__claydoImportStatus()` before unsealing — if the target is pinned to the
  same kind, the migration succeeded elsewhere; skip the unseal (and
  arguably return skipped instead of throwing). Longer term, make
  seal-and-import a compare-and-set on a per-migration token.
- Could an on-call engineer read the loser's message? Partially. "failed and
  was rolled back (old instance unsealed)" sounds *reassuring* — it does not
  say "you may now be in the both-live state". The two messages ("is live"
  from the in-memory check vs "is already live" from the storage check) also
  read as two different problems when they are one.

### Issue 2 — The both-live error suggests a recovery that cannot be performed

- **Severity:** major. **Category:** error message / missing API.
- **Repro:** write to the new instance via the kind accessor while the old
  instance is live with data, then route through the facade
  (`probes.test.ts` "both-live conflict").
- **Observed (verbatim):**

  ```
  claydo: both the old instance 'split-wipe' and the new instance 'bucket:split-wipe' are live. Fix the split before routing traffic (seal the old instance, or wipe the new one).
  ```

  I attempted both suggestions. **"wipe the new one":** there is no public
  API for it. A method on the kind doing raw `ctx.storage.deleteAll()` does
  not work — the host caches the kind in memory (`#kind`/`#impl`), so the
  wiped instance keeps reporting itself live until eviction, and the same
  both-live error came back verbatim. (`resetStorage()` intentionally
  re-pins the kind, so it can't help either.) **"seal the old instance"**
  (`__claydoSeal()` — a dunder method, nowhere documented as the remedy)
  works immediately, but silently strands whatever data the old instance
  held; the error never mentions that trade-off.
- **Expected:** a recovery I can actually execute, and an honest statement
  of what each option costs.
- **Suggested change:** either ship an `abandonImport()`/`wipeInstance()`
  helper that clears storage *and* in-memory state (e.g. via `ctx.abort()`),
  or remove "wipe the new one" from the message and document sealing —
  including the stranded-data consequence — as the recovery.

### Issue 3 — `fetch()` (and WebSockets) through the facade leak raw 410s; no retry-on-sealed

- **Severity:** major. **Category:** router gap.
- **Repro:** cache an "old" route with a long `oldRouteTtlMs`, externally
  migrate the instance, then `fetch()` through the facade
  (`probes.test.ts` "cache staleness", "websockets").
- **Observed (verbatim):** RPC transparently recovers, but `fetch()` returns

  ```
  410: claydo: instance 'stale-fetch' is sealed. It moved to Durable Object id 7e318e271ed1e7d064a910876672b93ed6170f166cf6dedf436a3009230f3484; route traffic through the claydo binding.
  ```

  A WebSocket upgrade gets the same 410 and `response.webSocket === null`.
  An immediate reconnect fails identically — the "old" decision stays cached
  for the full TTL, so the advertised reconnect story ("clients reconnect
  and land on the new instance") is false for up to `oldRouteTtlMs` (30 s
  default; as long as you configured otherwise). The cache only heals if an
  unrelated *RPC* call happens to hit the seal and repair it — after which
  `fetch()` works again.
- **Expected:** parity with the RPC path: on a 410 whose body matches the
  seal marker, re-resolve once and replay the request against the new side.
- **Suggested change:** implement exactly that in the facade's `fetch`
  (buffer/clone the request first). Checking the source confirms the retry
  exists only in the RPC proxy arm.

### Issue 4 — `exportable()` silently turns sync methods async for internal callers

- **Severity:** major. **Category:** wrapper semantics / documentation.
- **Repro:** a method of the wrapped class calls another of its own sync
  methods and uses the result, e.g. `webSocketMessage` doing
  `ws.send(JSON.stringify(this.take(1)))` (`probes.test.ts` "upgrades to an
  old-routed instance").
- **Observed:** the client received the string `{}` — the seal guard
  replaces every prototype method with an `async` wrapper, so `this.take(1)`
  resolved to a *pending Promise* and `JSON.stringify` serialized it as
  `{}`. The token was still deducted (asynchronously), so the client was
  charged and told nothing. The same class registered as the kind (new side)
  answers `{"allowed":true,"remaining":9}` correctly.
- **Expected:** the README says "Behavior is unchanged until an instance is
  sealed." It is not: this breaks *before* any seal, on the day you deploy
  the `exportable()` wrapper, i.e. step 1 of the migration guide.
- **Suggested change:** load the seal state synchronously at construction
  (e.g. under `blockConcurrencyWhile`) so wrappers can stay synchronous for
  sync methods; or at minimum a loud README warning that internal
  `this.method()` calls must be awaited once the class is wrapped.

### Issue 5 — Every failed route resolution leaks an unhandled rejection

- **Severity:** major. **Category:** library bug / observability.
- **Repro:** any facade call whose resolution throws (both-live, racing lazy
  migration), even when the caller catches the error.
- **Observed:** vitest failed the whole suite with 7 unhandled errors, e.g.

  ```
  Unhandled Rejection — Error: claydo: both the old instance 'split-wipe' and the new instance 'bucket:split-wipe' are live. ... ❯ resolve src/migrate.ts:710:15
  ```

  Cause (in source): `resolveCached` attaches `entry.promise.then((route) =>
  {...})` with no rejection handler, so the derived promise rejects
  unobserved. I had to add an `onUnhandledError` filter to the vitest config
  to keep the suite green — production Workers would log a spurious
  unhandled-rejection for every failed resolution too.
- **Suggested change:** `entry.promise.then(onFulfilled, () => {})`.

### Issue 6 — Facade metadata describes the NEW instance while traffic goes OLD

- **Severity:** minor. **Category:** API honesty.
- **Repro:** `router.test.ts` "facade metadata". On a manual-strategy facade
  whose traffic demonstrably serves the old instance, `.id` and `.stub` are
  the *new* instance's id and raw stub (`.id !==
  env.OLD_BUCKETS.idFromName(name)`).
- **Expected / suggested:** anyone logging `stub.id` for tracing, or passing
  `stub.stub` to `runDurableObjectAlarm`, is silently pointed at an instance
  that serves no traffic. Document it prominently, or expose an async
  `route()`/`resolvedId()` and mark `.id`/`.stub` as "destination, not
  current".

### Issue 7 — `MigratedAccessor` is not a drop-in replacement for the accessor

- **Severity:** minor. **Category:** API surface.
- **Repro:** the README says to use `migrated()` "in place of the plain
  accessor", but the facade only has `get()`. My worker and tests needed
  `idFromName()` (for `cloudflare:test` helpers) and had to reach around the
  facade to the underlying accessor. `unique()`/`fromId()` users can't adopt
  the router at all without code churn.
- **Suggested change:** pass through `idFromName` (trivial) and document
  that `unique`/`fromId` are intentionally absent (they can't have old-side
  counterparts).

### Issue 8 — The routing probe cost is real and undocumented; `oldRouteTtlMs: 0` is pathological

- **Severity:** minor. **Category:** performance / documentation.
- **Repro & measurement:** `router.test.ts` cost probe, counting old-side
  RPCs through an instrumented namespace. 10 `remaining()` calls with
  `oldRouteTtlMs: 0`: `{"__claydoSealed":10,"__claydoHasData":10,
  "remaining":10}` plus one host `__claydoImportStatus` per call (per
  source) — **3 extra round-trips per user call, 4x the RPC volume**
  (~65 ms for the batch in-process; with real network hops this is 3 added
  RTTs per request). Default TTL for the same traffic: one `__claydoSealed`
  + one `__claydoHasData` total.
- **Expected:** the README does not mention `oldRouteTtlMs` at all, nor that
  manual/drain re-probes every TTL window, nor that `__claydoHasData` can
  page through KV on each probe. A team tuning "freshness" to 0 gets a 4x
  RPC bill silently.
- **Suggested change:** document the resolve cost and the TTL trade-off;
  consider clamping/warning on very low TTLs; consider a cheap combined
  "seal+hasData" probe (one RPC instead of two).

### Issue 9 — Callers blocked by an in-flight import get a dead-end message

- **Severity:** minor. **Category:** error message.
- **Repro:** seal + apply one chunk, then call through the facade
  (`probes.test.ts` "slow migration").
- **Observed (verbatim):** RPC throws and `fetch()` answers 400 with

  ```
  claydo: instance 'session:slow-1' is importing kind 'session'. Traffic is blocked until the migration completes or is aborted.
  ```

  Accurate, but an on-call engineer gets no handle: no "since when" (the
  seal record has an `at` timestamp that is never surfaced), no "how do I
  abort" (`__claydoAbortImport()` is undocumented), no hint whether the
  driver is alive. The blockage lasts as long as the driver stalls —
  potentially forever — and `fetch()` returns 400 (a client-error status)
  for what is a temporary server-side condition; 503 + Retry-After would let
  load balancers and clients do the right thing.
- **Suggested change:** include the seal/import start time in the message,
  name the abort/resume remedies, and use 503 for the fetch path.

### Issue 10 — Cutover story for `drain` is undocumented and unsafe by default

- **Severity:** minor (documentation). **Category:** docs.
- **Repro:** thought experiment forced by the API: drain "never migrates;
  old instances stay old until their data expires" — but Durable Object
  data does not expire on its own, and step 4 of the README says to replace
  `migrated()` with the plain accessor "when the old namespace is empty".
  There is no way to *know* it is empty (Cloudflare cannot list names — the
  README itself says so), and if you cut over early, the plain accessor
  reaches fresh empty kind instances and the old data is silently
  orphaned — for a sessions fleet that is a mass logout with no error.
- **Suggested change:** document that drain requires the app to track
  live old names (in its own registry) and to run `migrateInstance` or
  wait for app-level expiry before cutover; consider a `drainReport()`
  helper that checks `__claydoHasData` for a supplied name list.

### Issue 11 — `__claydoKind()` lies about untouched instances

- **Severity:** nit. **Category:** API surprise.
- **Repro:** `router.test.ts` drain test. I used `__claydoKind()` to prove
  the new-side instance was never initialized; it answered `"session"` for a
  completely untouched instance because it falls back to the name prefix.
  The correct probe is `__claydoImportStatus().kind` (storage only), which I
  only found by reading `host.ts`. Related footgun: "checking" the new side
  through the kind accessor (`.getValue(...)`) would have *initialized* it
  and manufactured the Issue-2 both-live state — observability reads through
  the accessor are writes.
- **Suggested change:** document a blessed "is this instance live?" probe
  for migration tooling (and its difference from `__claydoKind`).

### Issue 12 — `__claydo*` RPC types collapse to `never`

- **Severity:** nit. **Category:** types.
- **Repro:** `const chunk = await oldStub.__claydoExport(undefined, null,
  { maxBytes: 16 })` then `chunk.cursor` →
  `error TS2339: Property 'cursor' does not exist on type 'never'`. The wire
  type contains `unknown` (`kv?: [string, unknown][]`), which the workers
  RPC type mapping rejects wholesale. Anyone writing a custom driver or a
  resumability test needs `as ExportChunk` casts.
- **Suggested change:** type KV values as a `Serializable`-compatible alias
  instead of `unknown`.

### Issue 13 — Successful failovers still log "uncaught exception"

- **Severity:** nit. **Category:** observability.
- **Observed:** every seal-retry that *succeeded* still emitted a runtime
  log line like `uncaught exception; source = Uncaught (in promise); stack =
  Error: claydo: instance 'stale-rpc' is sealed. It moved to Durable Object
  id 09db...; route traffic through the claydo binding.` — the throw inside
  the old DO is logged server-side even though the facade caught and
  recovered. Partly a runtime/test-pool artifact, but an on-call dashboard
  will show a burst of scary "is sealed" exceptions during a perfectly
  healthy cutover. Worth a note in the docs, or a non-throwing internal
  probe for the retry path.

## 4. Debugging experience narrative

The first full run was 15/18 with three failures and seven "unhandled
errors", and the debugging session was a fair sample of what adopters will
hit. The unhandled rejections were the most alarming: vitest pointed at
`src/migrate.ts:710` — inside the library — for tests whose assertions had
*passed*. It took reading `resolveCached` to see that the library attaches a
`.then` with no rejection handler to every route resolution; my only options
were patching the library (out of bounds) or teaching vitest to ignore
`claydo:`-prefixed unhandled errors, which is now a permanent wart in the
example's config (Issue 5).

The WebSocket failure was the best bug of the audit. The reply through the
facade to the old-routed bucket was `{}` where the identical class on the
new side answered proper JSON. My first three hypotheses (facade dropping
the body; `new Request(input, init)` mangling the upgrade; hibernation
serialization) were all wrong; the truth — `exportable()` rewrites every
prototype method as async, so the class's *own* internal `this.take(1)` call
now returns a Promise that `JSON.stringify` renders as `{}` — only fell out
of reading the static block in `migrate.ts`. Nothing warned, nothing threw,
and the token was still deducted. In production this class of bug ships to
the old fleet on day one of a migration and produces corrupt responses with
zero errors anywhere (Issue 4).

Two of my own test assertions also failed in instructive ways:
`__claydoKind()` claiming an untouched instance was already `"session"`
(Issue 11) cost me a round of "wait, did the drain facade write to the new
side?", and I nearly created a both-live split just by *reading* the new
side through the accessor to check it was empty. The library's error
messages, when they appear, are genuinely good — instance names, kinds, and
a suggested action — but the both-live suggestion sent me down a
30-minute dead end trying to "wipe the new one" before source-reading
revealed the in-memory kind cache makes that impossible (Issue 2).

As documentation, the README's migrate section is a good *narrative* and an
incomplete *reference*: the guarantees paragraph is precise and trustworthy
(everything it promises held up under probing), but `migrated()` gets three
sentences — no options table, no `oldRouteTtlMs`, no cache semantics, no
cost model, no failure-mode playbook — and the API reference section at the
bottom of the README omits the migrate module entirely. Every hard question
in this audit was answered by `src/migrate.ts`, not by the docs.

## 5. Verdict

The data plane earns trust: seal → stream → verify → pin never lost or
duplicated a byte in any probe, resume and idempotence work as advertised,
and the RPC-path retry made an external cutover invisible to callers. The
routing plane is where the sharp edges live: racing lazy routers across two
isolates — the normal state of a deployed Worker — can permanently split a
key until an operator intervenes with an undocumented dunder call (Issue 1);
HTTP and WebSocket clients get raw 410s for the full TTL window after a
cutover (Issue 3); and the wrapper you must deploy in step 1 quietly changes
your class's internal semantics (Issue 4).

**Would I route production traffic through `migrated()`?** For an
RPC-only fleet with `manual` or `drain` strategy, driven by a single
migration driver: yes, with monitoring for the both-live error. For the
headline `lazy` strategy, or anything serving `fetch()`/WebSockets during
the transition: not until Issues 1 and 3 are fixed — the failure modes are
production-shaped and the recovery is folklore.

**Score: 6/10.** Excellent core machinery and error-message craftsmanship,
held back by a real concurrency hazard in the flagship lazy path, a
router blind spot for fetch/WS, and a README that stops documenting exactly
where the hard questions start.

## 6. Post-fix verification

Re-audit against the hardened library. The suite was updated to assert the
new behavior with the same precision as the old (no weakened assertions),
re-run green (18/18, exit code 0), and re-typechecked clean. Crucially, the
`onUnhandledError` filter was **removed** from `vitest.config.ts` and the
suite stays green without it. All evidence below is verbatim from this run.

### Issue 1 (blocker, racing lazy routers split the fleet) — FIXED

The same two-facade race that previously split the fleet now succeeds for
**every** caller with exactly-once semantics:

```
[probe race-two] outcomes: [
  { allowed: true, remaining: 49 },
  { allowed: true, remaining: 47 },
  { allowed: true, remaining: 48 },
  { allowed: true, remaining: 46 }
]
```

All four callers across two facades fulfilled (losers now wait for the
winner via status polling instead of failing), each `take(1)` applied
exactly once (remaining = {46, 47, 48, 49}), and the old instance ends
sealed **with the move marker** — the rollback-unseal is gone. The
deterministic loser replay confirms the mechanism: the loser now fails at
*reservation*, before touching anything:

```
claydo: instance 'bucket:race-loser' is already live as kind 'bucket'. Imports only target untouched instances. If racing traffic polluted this instance, wipe it with wipeTarget() from claydo/migrate.
```

Nothing was rolled back (seal + `movedTo` intact), a `migrateInstance`
re-run reports `{ skipped: true, reason: "already migrated" }`, and fresh
facades route cleanly with the data preserved. The seq protocol is now also
ownership-guarded end to end — a foreign driver's chunk, a seq gap, and a
foreign abort each fail with precise errors ("this import is owned by
another migration driver", "expected seq 2, got 3", "cannot abort an import
owned by another migration driver ... Use wipeTarget() to force.").

One residual nit: the facade's wait-for-winner regex matches "owns the
import" / "is importing kind" but not the "is already live as kind" text,
so a loser whose reservation lands *after* the winner fully completes (a
much narrower window than before) still surfaces that error to one caller
instead of waiting; the next call self-heals via the status check. Fail-fast
and corruption-free, but not zero-error.

### Issue 2 (both-live recovery impossible) — FIXED

The router's both-live error now names an executable recovery:

```
claydo: both the old instance 'split-wipe' and the new instance 'bucket:split-wipe' are live. Fix the split before routing traffic: wipe the polluted new instance with wipeTarget() and migrate, or seal the old one if the new instance is the source of truth.
```

I executed it end-to-end: raw `deleteAll()` from inside the kind still
leaves the split (the in-memory pin survives — unchanged, but now
irrelevant), while `wipeTarget(accessor, name)` cleared storage *and* the
memory pin; the next lazy call migrated the OLD data and the 10 tokens
survived intact. The driver-side error also gained the honesty I asked for:

```
... If the new instance is the source of truth, seal the old one with __claydoSeal() — its data will NOT be copied.
```

The seal-old path still strands the old data, but the operator is now told
beforehand. The `wipeTarget` design is careful (requires `importable`, and a
confirm-id echo of the exact instance name).

### Issue 3 (fetch/WS leak raw 410s for the TTL) — FIXED

With a 1-hour `oldRouteTtlMs` and an external migration, `fetch()` through
the stale facade now returns a clean 200 with the migrated data — the
marked 410 (`x-claydo-sealed: 1`, generic body "claydo: this instance is
sealed (migrating or migrated). Reconnect through the current endpoint.")
is absorbed and the request replayed on the new side. The WebSocket story is
now real end to end: sealing actively closed my live socket with

```
{ code: 1012, reason: 'claydo: instance migrating; reconnect' }
```

and the reconnect through the *same stale facade* upgraded (101) against the
migrated instance with the data carried over
(`{"allowed":true,"remaining":9}`).

### Issue 4 (exportable() corrupts sync self-calls) — FIXED

The exact repro that returned `"{}"` now returns
`{"allowed":true,"remaining":9}` verbatim: the seal guards are synchronous
(seal state preloads under `blockConcurrencyWhile`), so
`JSON.stringify(this.take(1))` inside the wrapped class behaves exactly as
the unwrapped class. The README's "behavior is unchanged until sealed" claim
is true now.

### Issue 5 (unhandled rejection leak) — FIXED

The `onUnhandledError` filter is deleted from the example's vitest config
and the suite passes with exit code 0, including the tests that force
failed route resolutions. The route cache's promise chain has a rejection
handler in source.

### Issues 6–13 — status

- **6 (facade `.id`/`.stub` describe the NEW instance while routing old):
  unchanged.** The metadata test still passes asserting the misleading
  values.
- **7 (`MigratedAccessor` has only `get()`): unchanged.** Still no
  `idFromName` passthrough.
- **8 (route-probe cost / `oldRouteTtlMs` undocumented): unchanged.**
  Re-measured identically: 10 calls at TTL 0 →
  `{"__claydoSealed":10,"__claydoHasData":10}` plus 10 host status calls (3
  extra RPCs per call); default TTL → one probe pair total. `oldRouteTtlMs`
  still appears nowhere in the README.
- **9 (blocked callers during a slow import): improved.** The big win:
  facade callers now *wait* for an in-flight migration and succeed — my
  stalled-import probe's caller got its value with no error once the driver
  resumed. Direct-to-target traffic still hard-fails with the same message
  ("Traffic is blocked until the migration completes or is aborted." — now
  at least `ImportStatus.importing.ageMs` exists for tooling), still as
  HTTP 400 rather than 503, and the facade's 15 s wait deadline and 250 ms
  poll interval are hardcoded.
- **10 (drain cutover story): unchanged.** The README's migration section
  improved a lot (the four-step race-proof guarantee list and the recovery
  paragraph are excellent), but drain instances that never expire and the
  "how do I know the namespace is empty" question remain undocumented.
- **11 (`__claydoKind()` reports the name-prefix kind for untouched
  instances): unchanged.**
- **12 (`__claydo*` RPC types collapse to `never`): unchanged.** The
  `as ExportChunk` cast is still required (the wire type still contains
  `unknown`).
- **13 (server-side "uncaught exception" logs for handled errors):
  unchanged** as runtime noise (every handled seal-retry and ownership
  rejection still prints an `uncaught exception` line in the workerd
  output), but it no longer fails vitest suites now that issue 5 is fixed.
- The API reference section of the README still omits the migrate module
  entirely (`exportable`, `migrateInstance`, `migrated`, `wipeTarget`,
  `SEALED_HEADER` have no reference entries).

### Post-fix verdict

Every issue I rated major or blocker is fixed, and fixed the way I would
have wanted: ownership at reservation time rather than cleanup-time
heuristics, a real recovery API instead of a better apology, retry parity
across RPC/fetch/WS, and sync guards that make the wrapper honest. The
hardening also added things I didn't ask for but immediately benefited
from: reservation blocks racing traffic *before* it can pollute a target,
empty instances are skipped with a reason instead of sealed into husks, and
the move marker plus 410 header make the sealed state machine legible. What
remains is genuinely minor: metadata honesty, accessor parity, probe-cost
documentation, and log noise.

**Would I route production traffic through `migrated()` now?** Yes —
including the lazy strategy and fetch/WebSocket traffic during the
transition. I would still monitor for the both-live error and keep
`wipeTarget` in the runbook.

**Post-fix score: 8.5/10** (up from 6/10). The remaining deductions are the
undocumented router cost model and options, the misleading facade metadata,
and the residual one-caller error window in the lazy race — none of which
threaten data.
