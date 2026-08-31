# DX audit: `claydo/migrate` — consolidating a real two-binding app ("GameCo")

Auditor role: an engineer on a team that must move two production Durable
Object bindings into one claydo host, all the way through cutover, using only
the README and the published API. Everything below was executed for real in
`@cloudflare/vitest-pool-workers` (workerd, compat date 2026-08-01,
partyserver 0.5.10); every quoted error is verbatim from those runs.

Run it: from the repository root,

```sh
npx vitest run --config examples/migrate-app/vitest.config.ts   # 26 tests, all green
npx tsc -p examples/migrate-app/tsconfig.json                   # clean
```

> Sections 1–5 are the original audit, preserved as written. The module was
> subsequently hardened; section 6 re-verifies every numbered issue against
> the new behavior and updates the verdict.

## 1. What I built

GameCo has two legacy namespaces and wants both slots back:

| Legacy binding | Class | Shape | Addressing |
| --- | --- | --- | --- |
| `OLD_ROOMS` | `OldRoom = exportable(RoomServer)` | partyserver `Server` subclass (hibernating WebSockets, chat broadcast, SQLite message history written in `onMessage`) | `idFromName(room)` |
| `OLD_MATCHES` | `OldMatch = exportable(MatchImpl)` | plain `DurableObject` (KV match state, SQLite moves, turn-timeout alarms) | `newUniqueId()`, id strings kept in a registry |

Target: one host `AppDO = union({ room, match, registry }, { importable: ["room", "match"] })`
behind `APP_DO`. Three bindings and one migration tag during the transition;
two `deleted_classes` at the end.

Worker routing during the transition:

- `/rooms/:room/*` (WebSocket + history) goes through a **`migrated()` facade
  with strategy `"manual"`**. Justification: `lazy` migrates on *first touch*,
  and for a chat room the first touch is usually a WebSocket connect — a
  random player would pay the whole copy inline **and** every other player's
  live socket in that room dies mid-game (see issue 4: sealing kills sockets
  silently). `drain` is out because history must survive. `manual` lets an
  operator-run driver (`POST /admin/migrate-room/:room`) move rooms off-peak.
- `/matches/:oldId/*` **cannot use `migrated()` at all** — the facade routes
  exclusively via `idFromName(name)`, and these instances only have unique
  IDs. The worker does its own registry lookup (`registry` kind) and routes
  to either the old stub (`idFromString(oldId)`) or the new accessor at the
  documented name `migrated:<oldId>`.

The journey test (`test/journey.test.ts`) walks: seeding both bindings →
migrating the `lobby` room under a live WebSocket session and observing the
client's fate → migrating all registry matches → alarm continuity for a
pending turn timeout → a cutover rehearsal on plain accessors. The
adversarial suite (`test/adversarial.test.ts`) covers the wrapper-vs-
partyserver interaction, the seal window, wrong-shape imports, a hostile
table shape, chunk-by-chunk migration under read spam, and a message racing
the migration.

## 2. What worked well

- **The core copy machinery is genuinely solid.** Seal → stream → verify →
  pin behaved exactly as documented on the happy path: multi-chunk streams
  (down to `maxRowsPerChunk: 1`), AUTOINCREMENT sequences, indexes, KV,
  rowids — all byte-identical on arrival. Idempotent re-runs returned
  `{ skipped: true }`, a simulated crashed driver resumed
  (`resumed: true`), and the rollback in the alias-table failure (issue 5)
  really did unseal the old instance with its data intact.
- **Alarm continuity just works.** A pending turn-timeout alarm scheduled on
  the old unique-id match fired on the new `match:migrated:<oldId>` instance
  after migration, with the persisted deadline intact. The importer even
  guards against past-due alarms (`Math.max(alarm, now + 1s)`).
- **partyserver runs as a kind with no ceremony**, including hibernating
  WebSockets through the host's forwarded handlers, exactly as the README's
  third-party section promises. Broadcast, history, reconnects — all fine
  *on the host side*. (The old-side `exportable()` wrapper is another story,
  issue 3.)
- **Error messages are the best I've seen in this genre.** "the target name
  'room:prefix-guard' implies kind 'room', but the import declares kind
  'match'", the both-sides-live refusal, the no-kind explanations that
  literally name the mistake you made — several probes were diagnosable from
  the message alone.
- **The `manual` strategy plus RPC seal-retry is slick**: an RPC call through
  the facade that hits a freshly sealed instance re-resolves and retries on
  the new side transparently. When it applies (it does not apply to
  `fetch()`, issue 4), the client never notices the migration.
- **The repo's own test harness was copy-paste reusable**: the
  `cloudflareTest` plugin config, `stub.stub` escape hatch for
  `runDurableObjectAlarm`, and per-file isolated storage all behaved exactly
  as the README's testing section says.

## 3. Papercuts and issues

### Issue 1 — a read during the seal window silently loses the migration and reports success

- **Severity: blocker.** Category: correctness (`migrateInstance` +
  `migrated()` + host initialization interplay).
- **Repro** (deterministic: adversarial suite B; also hit *reliably* by
  suite E's tiny-chunk migration under facade read spam): seal an old
  instance — or just be a driver that crashed after `__claydoSeal()`, or a
  driver whose first chunk hasn't landed yet — then let any reader touch the
  target name through `migrated()` or a plain `get()`.
  1. The facade resolves "old is sealed → route new"; `get()` **initializes**
     the empty target and pins the kind (name prefix is enough).
  2. The reader is served an **empty history** — data apparently gone.
  3. `migrateInstance()` now sees target-has-kind + old-is-sealed, which is
     indistinguishable from a *completed* migration, and returns
     `{ skipped: true, chunks: 0, rows: {} }`. **The driver reports success
     while the only copy of the data sits behind a seal forever.**
- **Observed verbatim** (when the import chunk loses the race instead, suite
  E): `claydo: instance 'room:busy' is live as kind 'room'. Imports only
  target untouched instances.` — followed by rollback, after which the
  facade (which cached "new" permanently) serves the empty instance.
- **Expected:** the driver must distinguish "completed" from "empty target
  pinned while sealed old still has data". The skipped path checks
  `__claydoHasData()` only when the old side is *not* sealed
  (`src/migrate.ts` lines 571–586) — precisely the wrong arm.
- **Suggested change:** claim the target *before or atomically with* the
  seal (write the import state first; readers already block on
  `IMPORT_STATE_KEY`), and/or make `migrated()` treat "old sealed **and**
  old has data **and** target has no import record" as in-progress (block or
  route old-for-reads) instead of initializing. At minimum,
  `migrateInstance`'s skipped branch should refuse (loudly) when the sealed
  old instance still reports data and the target imported nothing.

### Issue 2 — once wedged, there is no recovery API; even `deleteAll()` is not enough

- **Severity: major.** Category: operability.
- **Repro:** the state left by issue 1. The error text says "otherwise wipe
  the new instance before migrating" — there is no library call that does
  that. `__claydoAbortImport()` returns `false` and does nothing when no
  import state exists.
- **Observed:** after wiping the target's storage with a test-only
  `runInDurableObject(... deleteAll())`, `migrateInstance()` **still**
  returned `{ skipped: true }` — the host keeps `#kind` pinned in memory and
  `__claydoImportStatus` falls back to it. Only after `ctx.abort()` evicted
  the instance did the re-run migrate the data.
- **Suggested change:** a `__claydoReset(secret)` (or exported
  `abandonTarget()` helper) that wipes storage *and* in-memory state, gated
  on "no user data or explicit force". Documented remediation would also do.

### Issue 3 — `exportable()` breaks the wrapped class's synchronous API *before any seal*

- **Severity: major.** Category: `exportable()` wrapper semantics; directly
  contradicts the README's "Behavior is unchanged until an instance is
  sealed."
- **Repro:** wrap any class whose methods call sibling *synchronous* methods
  through `this`. partyserver is a minefield: `getConnections()`,
  `getConnection()`, `broadcast()`, and the `sql` template tag are all sync
  on `Server.prototype`, and the seal guard replaces every one of them with
  an `async` wrapper. Our `connectionCount()` (a plain
  `for (const c of this.getConnections())`) works as a kind and explodes on
  the old binding **while unsealed**.
- **Observed verbatim:** `TypeError: this.getConnections is not a function
  or its return value is not iterable`.
- **Expected:** the wrapper preserves method synchrony until sealing is
  actually possible to observe, or the docs shout about it.
- **Suggested change:** cache the seal state so the guard can be synchronous
  after first load (the host already caches `#sealCache`; the wrapper only
  *needs* async for the first storage read), or wrap only RPC/handler entry
  points (`fetch`, `alarm`, `webSocket*`, and methods invoked by the
  runtime), or accept an options list:
  `exportable(Base, { passthrough: ["getConnections", "sql", ...] })`.
  partyserver survived *by luck* — its internals call private fields, not
  `this.`-methods — but any subclass using its public sync helpers breaks.

### Issue 4 — the WebSocket story: sealed rooms leave clients silently dead, and reconnects 410 until an RPC heals the route

- **Severity: major.** Category: migration UX / `migrated()` fetch path.
- **Repro:** journey steps 2b–2d. Connect a WebSocket to a room through the
  facade, migrate the room, then use the socket and reconnect.
- **Observed:**
  1. The client socket stays `OPEN`. No close frame, no error event. A
     message sent after the seal simply vanishes; server-side it surfaces as
     a DO-level uncaught exception:
     `claydo: instance 'lobby' is sealed. It moved to Durable Object id
     4c72d4f2…; route traffic through the claydo binding.` The client is
     told nothing, ever.
  2. An immediate reconnect through the facade returns **410** with that
     same internal message as the response body (an implementation detail —
     including the raw DO id — leaked straight to an end user's WebSocket
     handshake).
  3. The 410 persists for `oldRouteTtlMs` (default 30 s) because the
     facade's `fetch()` path has **no** seal-retry — only RPC calls do. In
     our worker, one `history()` RPC healed the cached route and the next
     reconnect got its 101.
- **Expected vs README:** "Live WebSockets do not move — clients reconnect
  and land on the new instance." In reality clients don't *know* to
  reconnect (nothing closes the socket), and when they do, the facade can
  410 them. The README's one-liner materially oversells this.
- **Suggested changes:** (a) a close-before-seal hook — `__claydoSeal()`
  should close accepted WebSockets with a well-known code/reason (1012
  "Service Restart" is designed for exactly this) so real clients' reconnect
  logic fires; (b) give the facade's `fetch()` the same
  sealed-response-retry the RPC proxy has (detect the 410 + marker header);
  (c) replace the 410 body with something client-safe.

### Issue 5 — the importer breaks on tables whose INTEGER PRIMARY KEY is not the first column

- **Severity: major** (fails loudly, but on a perfectly legal, undocumented
  table shape; and the diagnostic is useless). Category: exporter/importer
  correctness.
- **Repro:** adversarial suite D. Old match with
  `CREATE TABLE turn_log (at INTEGER NOT NULL, seq INTEGER PRIMARY KEY, note TEXT NOT NULL)`;
  two rows; migrate.
- **Observed verbatim:** `claydo: migration of 'alias-probe' to kind 'match'
  failed and was rolled back (old instance unsealed): NOT NULL constraint
  failed: turn_log.at: SQLITE_CONSTRAINT (extended:
  SQLITE_CONSTRAINT_NOTNULL)`.
- **Why:** the importer builds its INSERT as
  `["rowid", ...columns.slice(1)]` (`src/host.ts` line 450), which assumes
  the rowid alias is the *first* exported column. When the alias sits
  anywhere else, the real first column is dropped from the column list. Had
  `at` been nullable, this would have been **silent corruption** instead of
  a rollback.
- **Expected:** any rowid-alias position works — the exporter already knows
  the alias name (`#rowidAlias`); it just doesn't ship it.
- **Suggested change:** put the alias name (or index) in the chunk and build
  the INSERT from the actual column list; add this shape to the test matrix
  next to `WITHOUT ROWID`.

### Issue 6 — migrating an instance into the wrong kind succeeds silently

- **Severity: major** (footgun; nothing breaks *at migration time*).
  Category: validation.
- **Repro:** adversarial suite C — `migrateInstance({ from: <OLD_ROOMS
  instance>, to: app.match, name: "wrong-shape" })`, i.e. binding A's data
  into binding B's kind.
- **Observed:** complete success — `rows: { messages: 2 }` — and afterwards
  `match.get("wrong-shape").state()` returns `{ players: [], status:
  "unknown", moves: 0, … }`: a ghost match sitting on top of chat rows that
  are physically present in its database. Nothing errors, ever. The only
  shape guard that exists (target name prefix vs declared kind) can never
  catch this, because the driver derives both from the same `to` accessor.
- **Expected:** at least an opt-in tripwire.
- **Suggested change:** let kinds declare expected tables (or a
  `validateImport(chunk.tables)` hook on `union()` options); a cheap default
  heuristic — warn when the imported DDL creates zero tables that the kind's
  constructor would create — would have caught this immediately.

### Issue 7 — unique-id migration is 100 % on the user

- **Severity: minor** (it works; the ergonomics are bare). Category: API
  surface / docs.
- The entire documented guidance is one sentence ("give them names (for
  example `migrated:<oldId>`)"). In practice we had to: hand-roll the name
  convention in two places (worker + tests — no exported helper, nothing
  keeps them consistent), hand-roll the registry and its migrated flag,
  hand-roll routing (the `migrated()` facade is `idFromName`-only and cannot
  express "old side is `idFromString(oldId)`"), and discover by experiment
  that the tempting `app.match.fromId(oldId)` throws
  `Durable Object ID is not valid for this namespace.` (obvious in
  hindsight — IDs embed their namespace — but nothing in the docs closes
  that door).
- **Suggested change:** export `migratedName(oldId)`; accept an
  `oldStubFor: (name) => stub` resolver in `migrated()` so unique-id fleets
  can use the facade; add a worked unique-id example to the README.

### Issue 8 — sealing leaves the old instance's alarm armed forever

- **Severity: minor.** Category: lifecycle hygiene.
- **Repro:** journey step 5b. After migrating the match with a pending
  turn-timeout, the OLD instance still had its alarm scheduled —
  `runDurableObjectAlarm(old)` returned `true` — and it executed as the
  wrapper's warning no-op (storage confirmed untouched).
- **Expected:** the migration captured the alarm into the new instance; the
  old one should have been deleted at seal-final time (wasted wakeups,
  billing, and a recurring `alarm() skipped on sealed instance` warning that
  will page someone eventually).
- **Suggested change:** `migrateInstance` deletes the old alarm after the
  final chunk verifies (it already has the value safely re-armed).

### Issue 9 — partyserver's `this.name` changes value across the migration, and persisted copies go stale

- **Severity: minor** (by design, but a real data-compat trap the migration
  docs never mention). Category: docs / data compatibility.
- **Repro:** journey step 3. Our room stored `this.name` in every history
  row (as real apps do). After migration the same table holds rows with
  `room = "lobby"` (pre) and `room = "room:lobby"` (post); the natural
  `WHERE room = ?` query bound to `this.name` returns **only the
  post-migration row** — the entire pre-migration history silently
  disappears from that query. The broadcast payload's `room` field also
  changed client-visibly from `"lobby"` to `"room:lobby"`. partyserver's own
  `__ps_name` KV record migrates as stale data (`"lobby"`) and is silently
  overwritten on first contact.
- **Suggested change:** a "data written under the old identity" checklist
  item in the README's migration section, pointing at `instanceName(ctx)` as
  the stable value to persist *before* wrapping the old class.

### Issue 10 — the sealed-410 story requires a `fetch()` the old class may never have had

- **Severity: minor.** Category: `exportable()` / docs.
- **Repro:** journey step 4d. `MatchImpl` is RPC-only; `exportable()` only
  wraps methods that exist, so a sealed old match has no fetch-based
  tombstone. Calling `stub.fetch()` yields
  `TypeError: OldMatch exported by /workspace/examples/migrate-app/worker.ts
  does not define a `fetch()` method` — while the README states
  unconditionally that a sealed instance's "`fetch()` answers 410".
- **Suggested change:** `exportable()` should define a `fetch()` when the
  base has none (410 when sealed, 404/501 otherwise), or the README should
  scope the claim.

### Issue 11 — readers during an active import get hard 400s/errors with no retry guidance

- **Severity: minor.** Category: availability semantics.
- **Observed verbatim** (adversarial suite E, tiny chunks + read spam):
  `claydo: instance '…' is importing kind 'room'. Traffic is blocked until
  the migration completes or is aborted.` — and the host's `fetch()` answers
  **400** during the import (the repo's own test asserts the 400). The good
  news: no reader ever saw partial data. The bad news: for a large instance
  under `manual` strategy this is a hard downtime window, surfaced as a
  *client error* status with no `Retry-After`, and the facade makes no
  attempt to wait it out.
- **Suggested change:** 503 + `Retry-After` for fetch; an optional
  `waitForImportMs` on the facade so short imports are absorbed instead of
  erroring.

### Issue 12 — handled seal rejections spam the test output as "unhandled errors"

- **Severity: nit.** Category: DX noise.
- Every `expect(stub.method()).rejects` against a sealed old instance also
  surfaces as a vitest "Unhandled Rejection" with `remote: true`, plus
  workerd `uncaught exception` log lines. The repo's **own** suite does it
  too (`npm test`: 38 passed, "Errors 2 errors"). Real failures hide in
  this noise. Likely fixable by how the wrapper rejects (or documenting the
  artifact).

### Issue 13 — `migrated()` must be hoisted, and nothing says so

- **Severity: nit.** Category: docs.
- The route cache lives in the closure. The README example calls
  `migrated(...)` inline, which in a real Worker handler would rebuild the
  facade per request and re-pay 2–4 subrequests (`__claydoImportStatus`,
  `__claydoSealed`, `__claydoHasData`) on *every* call, and lose the
  "sealed → retried → new, cached forever" healing. One sentence ("create it
  once at module scope / per env") would save teams a latency mystery.

### Issue 14 — `migrated()` returns `{ get }` only

- **Severity: nit.** Category: API completeness. The plain accessor has
  `unique`, `fromId`, `idFromName`; the facade has `get`. Code being ported
  from accessor to facade that uses `idFromName` (we did, for
  `runDurableObjectAlarm`) has to keep a second reference to the real
  accessor. Fine, but worth stating in the docs, and `idFromName` at least
  would be free to add.

## 4. Debugging experience

**The good.** claydo's own errors carry the instance identity and both kinds
in almost every failure, which made most probes self-explanatory from the
message alone — the prefix-vs-declared-kind guard, the both-sides-live
refusal, and the fromId()-never-initializes explainer are exemplary. The
`MigrationSummary` (`chunks`/`kv`/`rows`/`alarm`/`resumed`) was genuinely
useful for asserting behavior instead of poking storage. The `stub.stub`
escape hatch plus `runInDurableObject`/`runDurableObjectAlarm` covered every
forensic need (reading `__ps_name`, proving the old alarm no-op, inspecting
stranded tables).

**The bad.** Three things cost real time:

1. **Noise.** workerd `uncaught exception` lines and vitest "Unhandled
   Rejection" reports fire for rejections my tests *handled* (issue 12), and
   for every seal-guard denial inside a WebSocket handler. During the
   red-green loop I repeatedly had to distinguish "expected scream" from
   "new failure" by eyeballing DO ids in hex.
2. **The alias-table failure** (issue 5) surfaces as a bare
   `NOT NULL constraint failed: turn_log.at` — no hint that the *importer's
   column mapping* is the cause. I only diagnosed it by reading
   `src/host.ts` line 450. An error like "importer requires the rowid alias
   to be the first column (table 'turn_log' has it at position 2)" would
   have been a 30-second fix-or-avoid decision.
3. **The seal-window wedge** (issues 1–2) was the opposite of debuggable:
   the system *reports success* (`skipped: true`). I found it only because a
   test asserted row counts end to end. In production this is the kind of
   thing you discover from a customer.

Also worth a line: `sql.exec<T>()` rejecting `interface` types (no implicit
index signature — needs `type` aliases) is a workers-types papercut the
claydo docs could pre-empt, since every kind hits it.

## 5. Verdict

**Would I run this consolidation at my company today? Not yet — but I would
after two fixes, and I'd be enthusiastic about it.**

The pitch is real: we ended the exercise with every room and match served by
one binding, history and alarms intact, a rehearsed cutover path, and two
reclaimable namespace slots. The copy engine (seal/stream/verify/pin,
resume, rollback, idempotency) passed everything I threw at it on the happy
path, including single-row chunks under concurrent read spam — **no reader
ever saw partial data**, which is the invariant that matters most.

What blocks production use is the *coordination* layer around that engine:
issue 1 is a silent-data-loss race that my read-spam test hit **reliably**,
not theoretically, and issue 2 means the escape from it requires
`ctx.abort()` surgery. For a WebSocket product, issue 4 additionally means
the "clients reconnect" story needs to be written by the application (close
sockets yourself before driving the migration; we would wrap the driver to
do exactly that).

Cutover plan we'd actually run (rehearsed here up to the deploy boundary,
since tests can't run `wrangler deploy`):

1. Freeze creation of new instances on the old bindings (code change).
2. Drive `migrateInstance` from the registry until `/admin/registry` shows
   100 % migrated; verify a sample with `__claydoSealed()` /
   `__claydoHasData()` per name. There is no namespace listing — if your
   registry is incomplete, unlisted instances are about to die.
3. Deploy the worker with facades replaced by plain accessors (our
   `?phase=cutover` path, as a real code change), bindings still present.
   Soak.
4. One final deploy: remove `OLD_ROOMS`/`OLD_MATCHES` bindings and the
   `OldRoom`/`OldMatch` exports, and ship
   `{ "tag": "v2", "deleted_classes": ["OldRoom", "OldMatch"] }`.
   What can go wrong: `deleted_classes` is irreversible — any
   not-yet-migrated or sealed-but-never-imported instance (issue 1's
   leftovers!) is destroyed with no recovery; any *other* Worker binding
   these classes via `script_name` breaks; and the migration tag sequence
   must build on `v1` or wrangler rejects the deploy. Given issue 1, I would
   add a pre-deletion sweep asserting `__claydoHasData() === false` or
   import-completed for every registry entry, and take a namespace-wide
   inventory snapshot first.

**Score: 6 / 10.** The engine is an 8.5; the routing/driver coordination and
the WebSocket story pull it down. Fix issue 1 (make the target claim atomic
with the seal) and issue 3 (stop async-ifying sync methods), add a
close-before-seal hook, and this is an easy 8+ that I'd happily bet a
production migration on.

---

## 6. Post-fix verification

The hardened module was re-audited with the same app. Every test below was
re-run for real (26 tests, 3 consecutive green runs, `tsc` clean); every
quoted string is verbatim from those runs. Where the old suite asserted a
bug, it now asserts the fix at the same precision — nothing was weakened.

### Issue-by-issue

**Issue 1 (blocker: seal-window race → silent data loss) — FIXED, with one
residual corner.** The driver now reserves the target *before* touching the
old instance, and reads in the window block instead of initializing:

> `claydo: instance 'room:race-window' is importing kind 'room'. Traffic is
> blocked until the migration completes or is aborted.`

My deterministic repro (reserve, then read through the accessor) can no
longer pin an empty instance, and the read-spam probe (suite E, 1-row
chunks, 12 facade reads at `oldRouteTtlMs: 0` during the copy) now returns
the complete 30-row history on **every** read — the facade waits out the
import instead of erroring or wedging. `{ skipped: true }` as a lie is gone:
a target polluted before migration makes the driver refuse loudly (see
issue 2), and the skip reason now requires the explicit move marker
(`reason: "already migrated"`, asserted in journey 4a). **Residual** (new
test, suite B3): `__claydoSeal()` is public — an operator who seals by hand
*without* the driver leaves the old pre-fix hole open: a facade read still
pins an empty target and the driver then reports
`{ skipped: true, reason: "already migrated" }` while the data sits sealed.
The driver can no longer create this state itself, and `wipeTarget()` +
re-run now recovers it, so I downgrade this from blocker to **minor** — but
the seal docs should warn that manual seals belong *after* a
`__claydoBeginImport` reservation.

**Issue 2 (no recovery API) — FIXED.** `wipeTarget(accessor, name)` un-wedges
a polluted target completely — storage, alarm, import state, and the
in-memory kind pin. Verified twice: after the both-live refusal
(the error itself now names the tool:

> `claydo: both the old instance 'polluted' and the new instance
> 'room:polluted' are live. Refusing to migrate. If racing traffic polluted
> the new instance (it has no real data), wipe it with wipeTarget() from
> claydo/migrate and re-run. …`

) and after the manual-seal shadow. In both cases the re-run migrated all
rows byte-exact. No more `ctx.abort()` surgery; error message and recovery
tool finally point at each other. The `__claydoReset` confirmation argument
(exact `kind:name`) is a nice guard against fat-fingering a destructive call.

**Issue 3 (`exportable()` broke sync methods while unsealed) — FIXED.** The
guards are now synchronous and the seal state loads in the constructor via
`blockConcurrencyWhile`. Re-verified specifically against partyserver
(suite A): `connectionCount()` — a plain `for (const c of
this.getConnections())` over the hibernating-connection iterator — works
under the mixin while unsealed, correctly reports a live hibernating
WebSocket (`1`), and throws the seal message only once sealed. The README
now also documents the guarantee ("the seal guards are synchronous, so sync
methods, internal self-calls, and framework helpers keep working") and the
repo's own suite pins it with a sync self-call test.

**Issue 4 (WebSocket story) — FIXED.** All three sub-complaints:

1. *Silently dead sockets*: sealing now closes hibernatable WebSockets. The
   mid-session client in journey 2b observes exactly
   `{ code: 1012, reason: "claydo: instance migrating; reconnect",
   wasClean: true }` and `readyState` goes to `CLOSED`. Real reconnect logic
   fires.
2. *410 with a DO-id leak*: the sealed body is now the generic
   `claydo: this instance is sealed (migrating or migrated). Reconnect
   through the current endpoint.` — asserted to contain no Durable Object
   id — plus the machine-readable `x-claydo-sealed: 1` header.
3. *No fetch retry / TTL wait*: the facade's `fetch()` path retries on the
   marker header. Journey 2c reconnects **immediately** after the migration
   (route still cached "old", ttl 60 s) and gets a 101 on the new instance
   with history intact. The connect → migrate → 1012 → reconnect → history
   journey is now exactly what the README claims.

   New nit found while verifying: the seal's own close triggers the old
   instance's `webSocketClose` handler, which the seal guard then throws on —
   every sealed socket produces one server-side uncaught exception
   (`claydo: instance 'lobby' is sealed. A migration is in progress.` at the
   guard wrapper). Harmless but noisy; `webSocketClose`/`webSocketError`
   should be exempt from (or no-op under) the guard, since the library
   itself invokes them at seal time.

**Issue 5 (rowid alias not in first column) — FIXED.** `ExportChunk.rows`
now carries the alias name (`rowid: "seq"` for our `turn_log`) and suite D
migrates the hostile table byte-exact:
`[{ at: 1000, seq: 1, note: "opening" }, { at: 2000, seq: 2, note: "midgame" }]`
arrives identical, `summary.rows.turn_log === 2`, no constraint error, no
rollback. The repo test matrix gained the same shape. (Tiny observation:
empty tables are absent from `summary.rows` rather than reported as `0` —
totals verification still covers them.)

**Issue 6 (wrong-kind import succeeds silently) — UNCHANGED, by explicit
decision.** Suite C still imports a chat room into the match kind without a
whisper and serves a ghost match. The changelog frames shape validation as
the app's responsibility; the name-prefix guard did move earlier (it now
fires at reservation time, before anything is sealed — a real improvement
for rollback hygiene). But the README still does not *state* the stance —
nothing in "What moves, and the guarantees" says "nothing checks that the
imported schema matches the target kind; the name prefix is the only
guard". If it's a documented non-goal, document it; one honest sentence
would finish this.

**Issue 7 (unique-id ergonomics) — UNCHANGED.** Still one README sentence
(`migrated:<oldId>`), still no exported name helper, still no way to give
`migrated()` an `idFromString` resolver — our worker keeps its hand-rolled
registry routing. It works; it's still all on the user.

**Issue 8 (old alarm armed forever) — FIXED.** Recording the move marker
deletes the old alarm: journey 5b now asserts
`runDurableObjectAlarm(old) === false`. Better still, alarms that fire
*during* the sealed window are deferred (+60 s), not swallowed, so a
mid-migration alarm survives into the copy (pinned by the repo's own m7b
test).

**Issue 9 (`this.name` data compatibility) — UNCHANGED.** Journey 3 still
shows pre-migration rows under `room = "lobby"` and post-migration rows
under `room = "room:lobby"`, the client-visible payload change, and the
stale `__ps_name`. Still no "data written under the old identity" checklist
in the README's migration section. This remains the trap I'd expect real
partyserver teams to hit first.

**Issue 10 (sealed 410 needs a `fetch()` the class never had) — UNCHANGED.**
`stub.fetch()` on the RPC-only sealed match still throws
`TypeError: OldMatch exported by /workspace/examples/migrate-app/worker.ts
does not define a `fetch()` method`, and the README still says sealed
"`fetch()` answers 410" unconditionally.

**Issue 11 (hard errors during the import window) — IMPROVED.** The facade
now absorbs the window entirely: `migrated()` waits for an in-progress
import (suite E saw zero errors across 12 reads during a 30-chunk copy).
Direct accessor traffic still gets the hard error / a 400 with no
`Retry-After`, so operators bypassing the facade still see a downtime
window presented as a client error — half-fixed, and the half that matters
(client-facing routes) is the fixed half.

**Issue 12 (unhandled-rejection noise) — IMPROVED.** Adopting the repo's
try/catch `expectRejects` pattern removed every vitest-level "Unhandled
Rejection" from this suite — the "Unhandled Errors" section is simply gone
from the output. workerd-level `uncaught exception` log lines remain for
DO-side seal throws (including the new webSocketClose-at-seal one, see
issue 4), so the output is quieter but not silent.

**Issue 13 (`migrated()` hoisting) and Issue 14 (`{ get }`-only facade) —
UNCHANGED.** Both remain as described; both remain nits.

### Cutover guidance, updated

The rehearsal (journey 6a/6b) still passes on plain accessors, and the new
semantics make the risky step *materially safer*:

- The pre-deletion sweep now has a reliable per-instance receipt: after a
  successful migration the old side reports
  `{ sealed: true, movedTo: "<target DO id>" }` (asserted in suite E), and
  the move marker is written only after verification. Sweep the registry
  for `movedTo !== undefined` instead of my previous
  "`__claydoHasData() === false` or import-completed" heuristic.
- Never-used names no longer become sealed husks: the driver skips them
  unsealed with `reason: "old instance has no data …"`, so a stale registry
  entry cannot make the sweep lie.
- The remaining human risks are unchanged: `deleted_classes` is
  irreversible, there is still no namespace listing (an incomplete registry
  still means unlisted instances die), and a *manually* sealed instance
  without a move marker (issue 1's residual corner) would sweep as
  "not migrated" — which is the correct, loud outcome.

### Verdict, updated

**Would I run this consolidation at my company now? Yes.** The blocker is
gone at its root (reservation-first ordering, not a patch on the symptom),
the recovery tool exists and is named in the very error that requires it,
the wrapper is honest about being invisible, and the WebSocket story a
client experiences — 1012 close, reconnect, full history — now matches the
README sentence for sentence. My whole top-5 list is fixed; what remains is
ergonomics (unique IDs), one documented-non-goal I'd still like one honest
README sentence for (wrong-shape), a residual manual-seal corner, and noise.

**Score: 8.5 / 10** (was 6). The engine was always an 8.5; the coordination
layer now deserves it too. The remaining half-points: the wrong-shape
silence (issue 6) still needs at least a README sentence, unique-id fleets
still route by hand (issue 7), the `this.name` data-compat trap is still
undocumented (issue 9), and the seal-close `webSocketClose` uncaught is new
noise. None of those would stop me from shipping this migration.

---

### Appendix: files in this example

| File | Purpose |
| --- | --- |
| `worker.ts` | Kinds (`RoomServer`, `MatchImpl`, `MatchRegistry`), `exportable()` old classes, `AppDO` host, transitional routes, admin driver |
| `wrangler.jsonc` | Three bindings, one migration tag (all three classes), commented-out `deleted_classes` cutover tag |
| `test/journey.test.ts` | The end-to-end consolidation (seed → live-WS migration → unique-id fleet → alarms → cutover rehearsal) |
| `test/adversarial.test.ts` | Wrapper-vs-partyserver, seal window, wrong-shape import, alias-column table, chunked migration under read spam, mid-flight message race |
| `vitest.config.ts` / `tsconfig.json` / `env.d.ts` | Harness, mirroring the repo's example conventions |
