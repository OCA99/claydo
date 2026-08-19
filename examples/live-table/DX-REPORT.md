# DX Report: live-table example (`generic-durable-objects`)

## 1. What I built

A Lunora-style live table with two product kinds in one DO namespace: `shard`
(per-room SQLite `messages` table, `insert`/`list` RPC, WebSocket subscribers
that receive a JSON delta on every insert) and `session` (per-user recency via
`touch`/`recent`). A third `probe` kind exists purely for adversarial DX
probes. A Worker routes `POST/GET /rooms/:room/messages`,
`GET /rooms/:room/subscribe`, `POST /me/:user/touch/:room`,
`GET /me/:user/recent`. 30 tests, all passing (`test/live-table.test.ts`,
`test/probes.test.ts`).

## 2. What worked well

- **The core promise holds.** Two (then three) kinds behind one binding and
  one migration. Adding the `probe` kind mid-audit was a pure code change —
  no wrangler edit, no migration. That is genuinely the selling point and it
  delivered.
- **Sharding by name is natural.** `kind(ns, "shard").get(room)` makes "each
  room is an instance" the obvious spelling. Sequence counters restarting per
  room proved SQLite isolation with zero extra work.
- **First-contact concurrency is solid.** 10 concurrent first RPC calls to a
  fresh instance produced seq 1–10 with no duplicates or init races. Mixed
  concurrent first contact (RPC + plain fetch + WebSocket upgrade in one
  `Promise.all`) also worked. The `#loading` promise dedupe in `host.ts` does
  its job.
- **Colons in logical names are safe.** `get("tenant:42")` round-trips through
  `insert`/`list` and `instanceName()` returns `tenant:42` intact (the parser
  splits on the *first* colon only). Even `get("session:9")` on the `shard`
  kind is unambiguous, because the helper always prepends its own prefix.
- **Stubs survive async boundaries.** Calling a stub after `setTimeout` and
  inside `ctx.waitUntil` both worked without "different request" I/O errors.
- **Big payloads are a non-event.** 100KB strings went through RPC arguments,
  RPC returns, and WebSocket deltas without any tuning.
- **The library's own error strings are excellent** when the library gets to
  produce them. Verbatim examples I hit:
  - `generic-durable-objects: kind 'shard' has no method 'isnert'.`
  - `generic-durable-objects: unknown kind 'coutner'. Registered kinds: shard, session, probe.`
  - `generic-durable-objects: this instance has no kind yet. Access it through kind() from a Worker, or use a name with a '<kind>:' prefix.`
- **Stub method typos are caught by TS with a fix-it:**
  `TS2551: Property 'isnert' does not exist on type 'KindStub<Shard>'. Did you mean 'insert'?`
- **WebSocket forwarding just works**, including passing the Worker's incoming
  upgrade `Request` straight through `stub.fetch(request)`.

## 3. Papercuts and issues

1. **Unsupported RPC return values die outside the error envelope, anonymously.**
   - Severity: **major**. Category: runtime-errors / debugging.
   - Repro: a kind method returns a custom class instance
     (`return new Widget("gizmo")`); call it through the stub.
   - Observed: the client rejection is, verbatim:
     `DataCloneError: Could not serialize object of type "Widget". This type does not support serialization.`
     It names neither the kind nor the method. Worse, the Workers runtime
     *also* prints an uncaught-exception line into the test output even though
     my code caught the rejection:
     `uncaught exception; source = Uncaught (in promise); stack = DataCloneError: Could not serialize object of type "Widget". This type does not support serialization.`
     That noise appears on every test run and looks like an unrelated bug.
   - Why: `__gdoCall` catches errors from the method itself, but the
     `{ ok: true, value }` envelope is serialized by workerd *after* the
     `try/catch`, on the RPC boundary. So the library's carefully built error
     path is bypassed exactly when serialization fails.
   - Desired: the host should pre-flight the value (e.g.
     `structuredClone(value)` in a try/catch) and convert failures into the
     normal `{ ok: false, error }` envelope with kind + method context, e.g.
     `kind 'probe' method 'returnCustomClass' returned a value that cannot be serialized (Widget)`.

2. **Raw namespace access without the prefix silently reaches a different instance.**
   - Severity: **major**. Category: API-shape / debugging.
   - Repro: write via `kind(ns, "shard").get("room-raw")`, then read via
     `env.APP_DO.idFromName("room-raw")` / `getByName("room-raw")` — the
     realistic mistake when half a codebase predates the library.
   - Observed: no error at all at ID-creation time; you simply get a different
     `DurableObjectId` (the helper's real name is `shard:room-raw`). The
     mistake only surfaces if you `fetch()` the unprefixed instance before
     anything else touches it — then you get the (good) 400:
     `generic-durable-objects: this instance has no kind yet. Access it through kind() from a Worker, or use a name with a '<kind>:' prefix.`
     If you only compare data ("why is my table empty?") there is no signal
     at all. Nothing links the two names.
   - Desired: this is partly inherent (the library cannot hook
     `env.APP_DO.idFromName`), but the README should show the failure mode
     explicitly ("you will get a *different, empty instance*, not an error"),
     and the "no kind yet" error could mention the accessed name when
     available (e.g. `instance name 'room-raw' has no kind prefix`), which
     would let a user connect the dots immediately. Also consider documenting
     a debugging recipe: call `__gdoKind()` on a suspect raw stub.

3. **`kind()` type errors hide the list of valid kind names.**
   - Severity: **major** (it hits every new user). Category: types.
   - Repro: `kind(env.APP_DO, "shrad")` or passing a `string`-typed variable.
   - Observed, verbatim:
     `TS2345: Argument of type '"shrad"' is not assignable to parameter of type 'KindNames<DurableObjectNamespace<LiveTableDO>>'.`
     and for a runtime-built string:
     `TS2345: Argument of type 'string' is not assignable to parameter of type 'KindNames<DurableObjectNamespace<LiveTableDO>>'.`
     `KindNames<DurableObjectNamespace<LiveTableDO>>` is an opaque internal
     alias. The stub-method typo gets a lovely "Did you mean 'insert'?", but
     the kind-name typo — the *first* thing a user types — gets nothing.
     Autocomplete inside the string literal does work, which softens this.
   - Desired: restructure the generic so the diagnostic surfaces the literal
     union (e.g. make the parameter type resolve to `"shard" | "session" |
     "probe"` rather than a deferred conditional type).

4. **Runtime-built kind names force a lying cast.**
   - Severity: minor. Category: types / API-shape.
   - Repro: routing table code, `const k: string = pickKind(url)`, then
     `kind(env.APP_DO, k)`.
   - Observed: the TS2345 above. The workaround everyone will write is
     `kind(env.APP_DO, k as "shard")` — a cast that lies (the string might be
     anything). At runtime an unregistered name fails well
     (`unknown kind 'coutner'. Registered kinds: shard, session, probe.`),
     but the type system pushed me into the unsafe spelling.
   - Desired: an escape hatch like `kind.unsafe(ns, name: string)` or an
     exported `KindNamesOf<NS>` type plus a documented runtime guard
     (`isKind(ns, name)`), so dynamic dispatch does not require `as`.

5. **Kind methods named `name` / `id` / `kind` / `stub` / `fetch` are silently shadowed — and TS actively lies about one of them.**
   - Severity: minor (but nasty when hit). Category: types / runtime-errors.
   - Repro: give a kind a `name(): string` method; call `stub.name()`.
   - Observed: this **typechecks** (the stub type is the intersection
     `(() => Promise<string>) & string`), but at runtime `stub.name` is the
     metadata string, so you get, verbatim:
     `TypeError: probe.name is not a function`.
     No library error, no `union()`-time validation, nothing in the type
     system. The README does list the reserved names under "Rules and limits",
     but nothing enforces them.
   - Desired: either (a) `union()` throws at class-creation time when a kind
     declares a reserved method name, or (b) the `KindStub` mapped type maps
     such kinds to `never` with a branded error type so it fails at compile
     time. (a) is cheap and catches JS users too.

6. **Non-method properties: good TS story, confusing `as any` story.**
   - Severity: nit. Category: types.
   - Repro: `Probe` has a public field `version = 7`. Typed access:
     `TS2339: Property 'version' does not exist on type 'KindStub<Probe>'.` —
     correct and per the documented "RPC covers methods only" rule, though the
     diagnostic can't explain *why* it's missing.
   - Observed at runtime (`(stub as any).version`): the Proxy returns an
     **async function** — truthy, `typeof === "function"` — so
     `if ((stub as any).version)` silently takes the wrong branch. Only
     *calling* it produces the good error:
     `generic-durable-objects: kind 'probe' has no method 'version'.`
   - Desired: hard to fix without a server round-trip per property get; a
     README sentence ("any property access returns a function; only calls are
     validated") would set expectations.

7. **Docs gap: serialization rules for RPC are never stated.**
   - Severity: minor. Category: docs.
   - Observed: Map, Date, and ArrayBuffer all round-trip perfectly
     (structured clone), custom classes explode per issue 1. The README says
     nothing about what argument/return types are legal.
   - Desired: a "What can cross the RPC boundary" section: structured-clone
     types yes, class instances no, and what the failure looks like.

8. **Docs gap: colon-in-name behavior is undocumented.**
   - Severity: nit. Category: docs.
   - Observed: works fine (first-colon split), but the README only says *kind*
     names must not contain `:` — a reader can't tell whether `get("tenant:42")`
     is safe. It is; say so.

Environment papercuts (not the library's fault, but they cost me time and the
README's Testing section could warn about them): `sql.exec<T>` rejects
`interface` row types (`TS2344 … Index signature for type 'string' is missing
in type 'MessageRow'`) — you must use `type` aliases; and `import.meta.url` is
not declared under `@cloudflare/workers-types`, so the vitest config needs to
be excluded from the example's `tsc` program.

## 4. Debugging experience

Nothing in the happy path needed debugging — the first full test run of the
functional suite passed. The probes are where debugging quality shows:

- The **best** moments were the library's own errors: `unknown kind 'coutner'.
  Registered kinds: shard, session, probe.` tells you the fix in the message
  itself, and `kind 'shard' has no method 'isnert'` names both sides of the
  mistake. Wrong-kind access (`is kind 'counter', but the caller expected
  kind 'plain'`) is equally self-explanatory.
- The **worst** moment was the custom-class return: an anonymous
  `DataCloneError` with no kind, no method, no stack into my code, *plus* a
  spurious "uncaught exception" line polluting every subsequent test run's
  output. I only located the offending method because I had written it ten
  minutes earlier. In a real codebase I would have been grepping for `Widget`
  across every kind.
- The **silent** failure mode (raw unprefixed access) produced no error to
  debug at all — the only reason I noticed was that I was explicitly comparing
  `DurableObjectId`s. A user staring at an inexplicably empty table has no
  breadcrumb pointing at the `shard:` prefix. This is the issue I'd most want
  the docs to shout about.
- Missing information generally: server-side stacks never reach the client
  (only `name` + `message` survive the envelope), so any error thrown deep
  inside a kind arrives with a client-side stack that ends at the library's
  `makeStub` re-throw. Fine for library errors, painful for application
  errors.

## 5. Verdict

**8/10 — I would adopt it.** The core mechanic (one class, one migration,
kinds as plain classes) worked exactly as advertised through two real kinds,
WebSockets, SQLite, concurrency abuse, and odd names, and the library-authored
error messages are among the best I've seen in a DO wrapper. What keeps it
from 9–10: the serialization failure escaping the error envelope (issue 1) is
the kind of thing that burns an afternoon in production, the unprefixed-raw-
access trap (issue 2) has no guardrail beyond one README bullet, and the
`kind()` type diagnostics (issue 3) make the very first typo a worse
experience than every later one. All three look fixable without API changes.
Compared to separate DO classes, I lose per-kind metrics and gain freedom from
the 500-namespace ceiling and migration ceremony — for a team with many small
use cases, that trade is clearly worth it.

## 6. Post-fix verification

Re-audited against the updated library. Suite grew from 30 to 36 tests, all
passing; `tsc` clean. Verdict per issue from §3:

1. **DataCloneError escapes the envelope anonymously — FIXED (with one residue).**
   The client rejection is now, verbatim:
   `generic-durable-objects: call to probe.returnCustomClass() failed: Could not serialize object of type "Widget". This type does not support serialization.`
   with the original `DataCloneError` attached as `cause`. Kind and method are
   named; grepping is over. Residue: the runner still prints
   `uncaught exception; source = Uncaught (in promise); stack = DataCloneError: Could not serialize object of type "Widget". ...`
   once per run — the host-side serialization failure still detonates outside
   any catch on the server. Cosmetic now that the client error carries
   context, but the noise remains.

2. **Raw unprefixed access is silent — IMPROVED.** The silent-divergence window
   (never fetching the orphan) is inherent and remains, but the first `fetch()`
   of an unprefixed instance now returns a 400 that teaches the exact mistake,
   verbatim:
   `generic-durable-objects: instance 'room-raw' has no kind yet. Its name has no registered '<kind>:' prefix. Raw namespace access (for example getByName('room-raw')) reaches a different instance than kind(ns, '<kind>').get('room-raw'). Access instances through the kind() helper, or use a '<kind>:' prefixed name.`
   The README's Identity section now spells out the failure mode too. This is
   about as good as it can get without hooking the namespace itself.

3. **Opaque `kind()` diagnostics — FIXED VIA NEW API, unchanged on the old one.**
   The new `kinds()` accessor delivers exactly the right experience; a typo
   now yields, verbatim:
   `TS2551: Property 'shrad' does not exist on type '{ shard: KindAccessor<Shard>; session: KindAccessor<Session>; probe: KindAccessor<Probe>; }'. Did you mean 'shard'?`
   Note `kind()` itself still shows an opaque alias (merely renamed):
   `TS2345: Argument of type '"shrad"' is not assignable to parameter of type 'KindNameOf<DurableObjectNamespace<LiveTableDO>>'.`
   Acceptable, since the docs now steer literal-name usage to `kinds()` and
   reserve `kind()` for runtime names.

4. **Runtime kind names force a lying cast — FIXED.** The exported
   `KindNameOf<NS>` gives the sanctioned spelling:
   `const k = value as KindNameOf<typeof env.APP_DO>` then narrow. One honest,
   greppable cast to a named contract instead of `as "shard"`. Proven in the
   probe suite.

5. **Reserved-name shadowing — FIXED, twice over.** `union()` now throws at
   class-creation time, verbatim:
   `generic-durable-objects: kind 'bad' (class BadKind) defines a method named 'name'. The stub reserves 'id', 'name', 'kind', 'stub' for metadata, so this method would not be callable. Rename the method.`
   And the `KindStub` type strips the metadata keys, so `stub.name()` no
   longer typechecks (`TS2722: Cannot invoke an object which is possibly 'undefined'.` / `TS2349: This expression is not callable.`).
   One migration note from experience: because my `Probe` kind had a `name()`
   method, the throw fired at *module import*, which vitest reports as two
   failed suites and "no tests" — for a moment it looked like a broken test
   config rather than the (excellent) new validation. The error message itself
   made the fix obvious once I scrolled up.

6. **Property access through the stub — IMPROVED.** Calling a leaked property
   now explains itself, verbatim:
   `generic-durable-objects: 'version' on kind 'probe' is a property, not a method (type: number). The stub only proxies methods; add a getter method to read it.`
   The `as any` trap that property *access* returns a truthy function remains
   (inherent to the Proxy design), but the moment you call it, the message is
   now exactly right.

7. **Serialization rules undocumented — FIXED.** The README gained a
   "Serialization rules" section listing what crosses the boundary, the
   custom-class failure with its wrapped message, and even the
   functions-become-RPC-stubs subtlety I hadn't probed.

8. **Colon-in-name behavior undocumented — FIXED.** The Identity section now
   states: "Logical names may themselves contain `:`; only the first segment
   routes, and only when it matches a registered kind."

Also verified as new, unprompted-by-me improvements: `fromId()` no longer
initializes (the error is a small tutorial:
`generic-durable-objects: instance '<id>' has no kind yet. It was accessed as kind 'shard' through fromId(), which never initializes an instance. Create the instance first with kind(ns, 'shard').get(name) or .unique(), then reach it by id.`),
kind-mismatch and unknown-kind errors now carry the instance identity
(`instance 'shard:probe-mismatch' is kind 'shard', but the caller expected kind 'session'.` /
`unknown kind 'coutner' on instance 'coutner:x'. ...`).

**Updated score: 9/10.** Every fixable issue I filed was fixed or materially
improved, mostly in the exact shape I suggested, and the two big runtime traps
(anonymous serialization death, silent raw access) now teach the user instead
of stranding them. What keeps the last point: the residual uncaught-exception
noise on serialization failures, the still-opaque `kind()` diagnostic, and the
one-namespace metrics limitation, which is inherent but real.
