# DX Report: alarm-scheduler example — historical pre-facet audit

> **Facet-native update (2026-08-31).** This example now imports `DurableObject`
> from claydo and runs every kind in an isolated Durable Object facet. The
> supervisor keeps routing, kind identity, migration state, and virtualized
> alarms outside user storage. The tests were updated for the new lifecycle:
> `deleteAll()` cannot erase kind identity, cleared facets restart with fresh
> schemas, and stable public stubs survive facet eviction. The detailed report
> below is the original build-time audit; findings about shared host storage,
> `__claydo:kind` in user data, or kind-less husks are historical and are
> resolved by this refactor.

## 1. What I built

A Cloudflare-Actors-style "multiple alarms" scheduler as a single `scheduler`
kind hosted by `union()`. It multiplexes many named logical timers over the
one DO alarm using a SQLite `jobs` table (fire the earliest due job, record
it into a `fired` table, re-arm for the next), with `schedule(name, atMs |
{delayMs})`, `cancel(name)` and `list()` as the RPC surface. 15 tests cover
scheduling, ordering, re-arming, cancellation, cold-instance alarm delivery,
and a set of deliberate failure probes.

## 2. What worked well

- **The core promise holds.** One class, one binding, one migration; the kind
  wrote SQL, set alarms, and received `alarm()` callbacks with zero
  library-specific ceremony. The kind class is genuinely just a
  `DurableObject` subclass.
- **The alarm path resolved the kind from storage flawlessly.** This was my
  main worry going in: `alarm()` has no caller hint. I scheduled a job,
  killed the instance with `ctx.abort()`, and the alarm fired on a cold
  instance — constructor re-ran, kind resolved from `__gdo:kind`, job fired.
  No surprises. (The one caveat: this only holds while `__gdo:kind` exists;
  see issue 1.)
- **Typed stubs are pleasant.** `await s.schedule("job", { delayMs: 30 })`
  with full inference of parameters and awaited return types, and default
  parameters (`increment(by = 1)`) survive the mapping.
- **Error messages that the library itself produces are excellent.** They are
  prefixed with `generic-durable-objects:`, name both sides of a mismatch,
  and suggest a remedy ("Access it through kind() from a Worker, or use a
  name with a '<kind>:' prefix.").
- **`.stub` escape hatch** made `runDurableObjectAlarm(s.stub)` work once I
  discovered I needed it (see issue 6).

## 3. Papercuts and issues

1. **`ctx.storage.deleteAll()` inside a kind half-kills the instance**
   — severity: **major**, category: runtime-errors / API-shape.
   - Repro: `await stub.schedule(...)`, then a kind method runs
     `await this.ctx.storage.deleteAll()`, then call any SQL-backed method on
     the *same warm instance*.
   - Observed: the library's cached in-memory kind keeps answering RPC, but
     its tables are gone and the constructor does not re-run, so every call
     fails with a raw SQLite error, verbatim:
     ```
     Error: no such table: jobs: SQLITE_ERROR
     ```
     The instance is now in a state it can never reach from a fresh boot
     (constructor always creates the tables). After a restart, a *named*
     instance heals: storage no longer has `__gdo:kind`, but the `scheduler:`
     name prefix re-resolves and re-pins the kind and the constructor
     recreates the tables. Only the data is lost. A *unique-id* instance does
     not heal: it has no name prefix, so it becomes fully amnesiac
     (`__gdoKind()` → `undefined`, raw fetch → 400 "has no kind yet") until
     some caller re-pins it via the hint.
   - Expected/desired: deleteAll is a documented, normal DO operation
     ("reset this object"); the library silently rides on a storage key the
     kind can wipe without knowing it exists.
   - Suggested change: (a) document `deleteAll()` loudly in "Rules and
     limits"; (b) better, have the host re-persist `__gdo:kind` after any
     call on a loaded instance whose storage lost it (cheap check, or hook
     `deleteAll` via the storage proxy); (c) consider a supported
     `resetInstance()`/`destroyInstance()` helper so users never call
     deleteAll directly.

2. **Alarm errors during natural firing are invisible to tests and carry no
   instance context** — severity: **major**, category: debugging.
   - Repro: make `alarm()` throw, let the alarm fire naturally (past-dated
     alarm) inside `@cloudflare/vitest-pool-workers`.
   - Observed: the test cannot observe the failure at all; the only trace is
     stderr, verbatim:
     ```
     uncaught exception; source = Uncaught (in promise); stack = Error: poison job exploded
         at Scheduler.alarm (/workspace/examples/alarm-scheduler/worker.ts:132:15)
         at AppDO.alarm (/workspace/src/host.ts:210:18)
     ```
     Forcing the alarm with `runDurableObjectAlarm(rawStub)` does propagate
     the error to the test, so that is the workaround. Related: if the host's
     own `#load()` fails on the alarm path (no resolvable kind), the error
     `generic-durable-objects: this instance has no kind yet...` contains no
     hint of *which instance* — on the alarm path there is no caller to know.
   - Suggested change: include `ctx.id.toString()` (and the resolved-or-not
     kind) in every host error message; add a "Testing alarms" section to the
     README (schedule far-future + `runDurableObjectAlarm(stub.stub)` is the
     only deterministic recipe, past-dated alarms fire for real and race the
     helper).

3. **RPC errors lose their stack and identity; test failures point at the
   library's client** — severity: **minor**, category: debugging.
   - Repro: any kind method throws; assert on it in a test and let it fail.
   - Observed: the client rebuilds a fresh `Error` from `{name, message}`, so
     vitest attributes every remote failure to the library, verbatim frame:
     ```
     Error: no such table: jobs: SQLITE_ERROR
      ❯ Proxy.<anonymous> src/client.ts:142:23
     ```
     The kind-side stack exists only in workerd's stderr. `instanceof
     CustomError` is always false; only `error.name` survives.
   - Suggested change: carry the remote `stack` in the envelope and attach it
     (`error.stack = remote.stack` or `cause`), and document that custom
     error classes flatten to `Error` with a preserved `name`.

4. **`runDurableObjectAlarm` rejects the library's stub; the failure does not
   say why** — severity: **minor**, category: API-shape / docs.
   - Repro: `runDurableObjectAlarm(kind(env.APP_DO, "scheduler").get("x"))` —
     the natural first attempt, since the KindStub *looks* like a stub.
   - Observed, verbatim:
     ```
     TypeError: Failed to execute 'runDurableObjectAlarm': parameter 1 is not of type 'DurableObjectStub'.
     ```
     Nothing connects this to "you passed the Proxy; use `.stub`". I found
     `.stub` by reading `src/client.ts`.
   - Suggested change: README "Testing" section should show
     `runDurableObjectAlarm(myStub.stub)` explicitly.

5. **Aborting an instance permanently breaks existing KindStubs**
   — severity: **minor**, category: API-shape / docs.
   - Repro: kind method calls `ctx.abort("scheduler crashed on purpose")`;
     then call anything on the *same* KindStub.
   - Observed: every later call through the old stub rejects with the abort
     reason (`Error: scheduler crashed on purpose`), and workerd logs
     `broken.outputGateBroken` noise for each one. A freshly created accessor
     stub works fine. This is standard DO stub behavior, but the KindStub
     caches one raw stub forever and gives no way to refresh it.
   - Suggested change: document it; optionally lazily re-`ns.get()` after a
     disconnection, since the KindStub already knows the id.

6. **`sql.exec<T>` rejects `interface` row types** — severity: **nit**,
   category: types / docs (workers-types interaction, but README-adjacent).
   - Repro: `interface Job { name: string; at: number }` then
     `ctx.storage.sql.exec<Job>(...)`.
   - Observed, verbatim:
     ```
     error TS2344: Type 'Job' does not satisfy the constraint 'Record<string, SqlStorageValue>'.
       Index signature for type 'string' is missing in type 'Job'.
     ```
     Works with a `type` alias (implicit index signature). The README's SQL
     examples only use inline literals, so a user discovers this alone.
   - Suggested change: one-line note in the README's SQL example.

7. **A "spurious" alarm wake must be tolerated by every alarm-using kind**
   — severity: **nit**, category: docs.
   - `runDurableObjectAlarm` (and production retries) can invoke `alarm()`
     when nothing is due. My first scheduler version fired unconditionally.
     Worth one sentence in a "writing alarm kinds" docs section, since alarm
     multiplexing is the flagship use case for kinds.

8. **The repo's root vitest config sweeps up example tests** — severity:
   **minor**, category: docs/debugging (repo hygiene, not library code).
   - Repro: add `examples/<x>/test/*.test.ts` with its own vitest config,
     then run a bare `npx vitest run` (the repo's `npm test`) from the root.
   - Observed: the root config has no `test.include`, so vitest's default
     glob collects the example tests and runs them against
     `test/fixtures/worker.ts` — a worker with different kinds — producing
     dozens of `unknown kind 'scheduler'`-style failures. My test files now
     detect the wrong worker via `__gdoKind()` on a prefixed probe name and
     `describe.skipIf` themselves.
   - Suggested change: add `include: ["test/**/*.test.ts"]` to the root
     vitest config so `npm test` and per-example configs stay independent.

## 4. Debugging experience

The two debugging sessions this example forced on me were both about the
environment, not the library — but the library's error envelope made them
slower than necessary. First: alarms scheduled in the past fire *for real* in
the workers vitest pool, so my `runDurableObjectAlarm`-driven ordering test
raced its own alarms and returned `false` ("no alarm scheduled"); the only
clue was stderr `uncaught exception` lines interleaved with the reporter
output. I had to correlate three sources (vitest assertion diffs, workerd
stderr, library source) to reconstruct the timeline. Second: after
`deleteAll()`, the `no such table: jobs: SQLITE_ERROR` failure pointed at
`src/client.ts:142` instead of my kind, because the client re-throws a
reconstructed error. Once I knew to read workerd's stderr for the *real*
stack (`at Scheduler.alarm ... at AppDO.alarm (src/host.ts:210)`), everything
was diagnosable — but the kind-side stack should be in the thrown error, not
in a log stream. On the positive side, when I mis-held the library (wrong
kind, missing method, kindless instance) the failures were instant, loud, and
self-explanatory; I never once got a *silent* wrong behavior from the library
itself on this example.

## 5. Verdict

**8/10 — I would adopt it for this workload.** The alarm story — the part I
expected to be flaky in a "many kinds, one class" design — worked first try,
including cold-start kind resolution from storage, hibernation-style
restarts, and re-arming. The typed client is genuinely nicer than hand-rolled
`fetch` routing between DO classes. What keeps it from 9–10: the
`deleteAll()` interaction with `__gdo:kind` is an undocumented data/identity
footgun sitting on an API every DO developer uses, and the error envelope
discards stacks, which taxes exactly the debugging sessions where you need
them. Both are fixable without API changes.

## 6. Post-fix verification

Re-audited after the library update. Status of each issue from section 3,
with new verbatim evidence from the re-run suite (15/15 passing):

1. **deleteAll() half-kills the instance — IMPROVED.** The new
   `resetStorage(ctx)` helper does deleteAll but re-pins the kind marker; I
   adopted it in the counter-fleet example and proved a unique instance
   survives wipe + eviction with its kind intact. The README now has a
   "Storage lifecycle" section with exactly the destroy() recipe I asked
   for. What remains: a *raw* `deleteAll()` still breaks the warm instance
   the same way (`Error: no such table: jobs: SQLITE_ERROR`, constructor
   does not re-run), and a unique instance that raw-wipes is now
   **permanently stranded** rather than silently re-pinnable — `fromId()`
   refuses with:
   ```
   generic-durable-objects: instance '<64-hex id>' has no kind yet. It was accessed as kind 'scheduler' through fromId(), which never initializes an instance. Create the instance first with kind(ns, 'scheduler').get(name) or .unique(), then reach it by id.
   ```
   That trade (explicit loss instead of silent identity corruption) is the
   right one, but the underlying footgun still requires the developer to
   know to call `resetStorage` — now at least it is documented.

2. **Alarm errors invisible / no instance context — IMPROVED.** Forwarded
   handler errors are now logged with kind and instance identity before
   rethrowing. Verified with a `console.error` spy during a forced poison
   alarm; captured verbatim:
   ```
   generic-durable-objects: alarm() failed on kind 'scheduler' instance 'scheduler:poison': [Error: poison job exploded]
   ```
   Host errors also carry the instance identity now (e.g. the 400 body
   `instance '<id>' has no kind yet. Unique-ID instances initialize on
   their first call through kind(ns, '<kind>').unique().`). Naturally-firing
   alarm errors still cannot be *asserted* in tests — they reach only the
   log — so: improved, not fully fixed (that part is a platform limit).

3. **RPC errors lose stack/identity — FIXED.** Asserted in the suite: the
   revived error's stack now begins with the remote frames (`at
   Scheduler.list`) followed by the marker line
   `at [remote call scheduler.list() via generic-durable-objects]` and then
   local frames. Error `name` and own enumerable fields survive too (proven
   in counter-fleet with a `DuplicateLabelError` carrying a `label` field).
   `instanceof` still does not survive, which the README now states
   explicitly with the `error.name` guidance I wanted.

4. **`runDurableObjectAlarm` rejects the KindStub — IMPROVED (docs).** The
   platform TypeError is unchanged (verbatim identical), but the README's
   new Testing section now says to pass `stub.stub` or a raw stub, which is
   what I asked for.

5. **Abort permanently breaks existing KindStubs — UNCHANGED.** Old stubs
   still reject every call with the abort reason (`Error: scheduler crashed
   on purpose`), and there is no lazy reconnect. Minor, and arguably
   correct DO semantics, but still undocumented.

6. **`sql.exec<T>` rejects interfaces — UNCHANGED.** No README note about
   the type-alias requirement; the same TS2344 fires for `interface` row
   types. (workers-types interaction, so low priority.)

7. **Spurious alarm wakes — UNCHANGED.** No docs guidance that `alarm()`
   must tolerate a wake with nothing due; my scheduler still needs its
   due-check for `runDurableObjectAlarm`-driven tests.

8. **Root vitest config sweeps example tests — FIXED.** A bare
   `npx vitest run` from the root now runs only the library suite (24
   passing) and there is a separate `npm run test:examples`. My
   `describe.skipIf` guards are now redundant but harmless; I kept them as
   defense in depth.

**Updated score: 9/10** (up from 8). Both majors addressed: the deleteAll
footgun has a supported answer (`resetStorage` + docs) and alarm failures
are now attributable to a kind and instance. Errors carrying real stacks
removes my single biggest debugging tax. What keeps the last point: raw
`deleteAll()` remains a silent trap you must know to avoid (a runtime
warning or a storage-proxy interception would close it), and alarm errors
are still assertable only via forced runs.
