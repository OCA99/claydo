# DX report: game-lobby example

Audit of `generic-durable-objects` v0.1.0, written while building this example.
Companion report (error propagation focus): `../shop/DX-REPORT.md`.

## 1. What I built

A multiplayer coordination worker with two kinds in one host class: a
singleton `lobby` that creates matches (each a `unique()` instance of the
`game` kind, created cross-kind from inside the lobby DO) and tracks them in
its SQLite database, and a `game` kind running turn-based tic-tac-toe with a
turn-timeout alarm that forfeits the slow player and WebSocket spectators
that receive move broadcasts. A second `union()` host class (`MetricsDO`)
lives in the same worker as a probe. 16 tests, all passing.

## 2. What worked well

- **The core promise holds.** Two kinds (plus a second namespace) needed one
  wrangler migration each, written once. Adding the `game` kind after `lobby`
  was a pure code change. This is exactly what the README sells.
- **Cross-kind calls from inside a DO are frictionless.** `Lobby.createMatch`
  does `kind(this.env.APP_DO, "game").unique()` then `await game.setup(players)`
  and it just works, fully typed. This pattern is the best thing about the
  library and the README never shows it (see issue 6).
- **`unique()` id round-trip has zero friction.** `stub.id` is a real
  `DurableObjectId`; `id.toString()` went into lobby SQLite as TEXT and came
  back out into `fromId(storedString)` with no cast anywhere. `fromId` accepting
  `string | DurableObjectId` is the right call.
- **Alarms and hibernating WebSockets forward correctly.** The turn-timeout
  alarm set inside `Game.move` fired through the host's `alarm()` and reached
  the kind. Kind resolution for the unnamed `unique()` instance came from
  persisted storage (verified indirectly: the rename probe below proves storage
  is read on first load). `runDurableObjectAlarm(env.APP_DO.get(idFromString(id)))`
  on a fresh raw stub worked; `runDurableObjectAlarm(stub.stub)` also
  typechecks directly — the `.stub` escape hatch is exactly right for
  `cloudflare:test`.
- **Kind pinning is airtight in every direction I attacked it.** Wrong-kind
  `fromId`, unknown kinds, uninitialized unique instances — every path produced
  a distinct, prefixed, accurate error (quoted below).
- **Two `union()` classes coexist cleanly.** Separate bindings, separate
  registries, no runtime bleed, and TypeScript rejects cross-namespace kind
  names (diagnostics under issue 4).
- **Domain errors thrown by kind methods surface with clean messages.**
  `await game.move("bob", 4)` before bob's turn rejects with exactly
  `not your turn: it is 'alice' to move`. Message-level ergonomics are good;
  see the shop report for what is *lost* (class identity, fields, stacks).

## 3. Papercuts and issues

Issues about error *propagation* (the worst ones) are in the shop report;
these are the ones this example surfaced.

1. **Reserved stub names silently shadow kind methods.**
   Severity: major. Category: API-shape/types.
   Repro: give a kind a public method named `name`, `id`, `kind`, `stub` or
   `fetch`, then call it through the typed stub.
   Observed: nothing stops you. `union()` validates kind *names* but not kind
   *prototypes*. The client Proxy (`client.ts` `makeStub`) returns its own
   meta property before consulting the kind, so `stub.name(...)` throws
   `TypeError: stub.name is not a function` at runtime while the type level is
   confused-but-callable: `ReservedKey` in `KindStub` only strips `ctx`, `env`,
   `fetch`, the WebSocket handlers, `alarm`, and `__`-prefixed keys — `name`,
   `id`, `kind`, `stub` are NOT stripped, so the mapped method type intersects
   with the meta property type instead of erroring. The README lists these as
   reserved but only as prose ("These method names are reserved on stubs").
   Expected: `union()` throws at registration time (it already has the class),
   or the stub type makes such a kind unusable with a readable error.
   Suggested change: in `union()`, walk each kind's prototype and throw for
   reserved method names, same as the `:` check — that check fires at exactly
   the right moment (module evaluation) and its message is a model of clarity.

2. **A renamed kind half-fails loudly and half-fails silently.**
   Severity: major. Category: runtime-errors/docs.
   Repro: simulate a deploy where `game` was renamed to `match` in the
   registry while instances persist the old kind (test
   `PROBE: renamed kind in the registry orphans existing instances` writes a
   stale kind into storage via the exported `KIND_STORAGE_KEY`).
   Observed, verbatim, for instances whose stored kind is missing from the
   registry:
   > `generic-durable-objects: unknown kind 'match'. Registered kinds: lobby, game.`
   That is decent. But the *other* half is silent: `kind(ns, "match").get("x")`
   hashes the name `match:x`, which is a different DO id than `game:x`, so
   every named instance quietly becomes a fresh empty instance — no error, no
   data, and the old instance still exists unreachable. A user who renames a
   kind sees a mix of "unknown kind" errors (for `unique()`/`fromId` paths)
   and mysteriously blank state (for `get(name)` paths). The README does say
   "Kind renames are breaking. …Treat kind names as permanent identifiers",
   which is honest, but the silent-blank-state mode will burn people anyway.
   Suggested change: (a) extend the unknown-kind message with a hint like
   "If you renamed a kind, register the old name too — kind names are
   permanent identifiers." (b) Document an aliasing recipe
   (`union({ game: Game, match: Game })` does NOT alias — the two names hash
   to different instances — so an explicit `aliases` option may be worth it).

3. **`import.meta.url` is not typed under the recommended workers-types setup.**
   Severity: minor. Category: types (test harness).
   Repro: the vitest plugin config `new URL("./wrangler.jsonc", import.meta.url)`
   inside a tsconfig using `"types": ["@cloudflare/workers-types/experimental", ...]`.
   Observed, verbatim: `examples/game-lobby/vitest.config.ts(8,61): error TS2339: Property 'url' does not exist on type 'ImportMeta'.`
   Worked around with an `interface ImportMeta { readonly url: string }`
   augmentation in `env.d.ts`. Not the library's bug, but the library's README
   "Testing" section stops at `npm test` and leaves downstream users to
   discover the whole vitest-pool-workers setup (plugin API, `Cloudflare.Env`
   global augmentation, this ImportMeta gap) themselves.
   Suggested change: a short "testing your worker" README subsection or an
   examples folder with one wired-up harness.

4. **TS diagnostic quality for a wrong kind name depends on registry size.**
   Severity: minor. Category: types.
   Repro: `kind(env.METRICS_DO, "game")` (single-kind registry) vs
   `kind(env.APP_DO, "wishlist")` (multi-kind registry, shop example).
   Observed, verbatim:
   > `error TS2345: Argument of type '"game"' is not assignable to parameter of type '"metrics"'.`
   (great) versus
   > `error TS2345: Argument of type '"wishlist"' is not assignable to parameter of type 'KindNames<DurableObjectNamespace<ShopDO>>'.`
   The second one never tells you the valid names; you must go read the
   registry. Expected: the diagnostic lists the union of kind names.
   Suggested change: force eager evaluation of `KindNames` in the `kind()`
   signature (e.g. distribute it into a plain literal union) so TS prints
   `'"lobby" | "game"'` instead of the alias.

5. **Storage is shared across tests in a file; the README's testing story doesn't mention isolation.**
   Severity: minor. Category: docs/debugging.
   Repro: two tests both using `lobby.get("main")`; `listMatches()` in test 2
   returned test 1's match as well:
   > `AssertionError: expected [ …(3) ] to deeply equal [ …(2) ]`
   Expected: with the classic `defineWorkersConfig` API, `isolatedStorage`
   defaults to true; with the new `cloudflareTest` plugin API used here,
   writes visibly persist across tests. Whatever the intended default is, an
   example-library whose whole pitch is stateful objects should tell test
   authors what to expect. (Worked around with per-test id prefixes / order-
   tolerant assertions; arguably that produced *more* realistic tests.)

6. **The best pattern in the library — DO-to-DO cross-kind calls — is undocumented.**
   Severity: minor. Category: docs.
   The README only ever calls `kind()` from a Worker handler. Both of my
   examples' core logic (`lobby → game`, `cart → inventory`) calls `kind()`
   from *inside* a kind implementation via `this.env`. It works perfectly and
   is clearly a designed use case (the client helper is pure). One README
   paragraph plus an example would sell the library much better.

7. **Invalid kind names fail at module-evaluation time — which in production is after deploy.**
   Severity: nit. Category: runtime-errors.
   Repro: `union({ "bad:kind": Game })`.
   Observed, verbatim:
   > `Error: generic-durable-objects: invalid kind name 'bad:kind'. Kind names must be non-empty, must not contain ':' and must not start with '__'.`
   Surfaces when `union()` runs, i.e. at worker module evaluation: instantly
   in vitest/`wrangler dev`, but a `wrangler deploy` uploads successfully and
   the worker then throws on startup for every request. The message itself is
   excellent. A docs note ("this throws on startup, not at build time") or a
   wrangler-buildable lint would close the gap; low priority since local dev
   catches it immediately.

8. **Typo'd method names: great in TS, fine at runtime, could be one notch better.**
   Severity: nit. Category: types/runtime-errors.
   Without `as any`, verbatim: `error TS2551: Property 'resreve' does not exist on type 'KindStub<Inventory>'. Did you mean 'reserve'?` — as good as it gets.
   With `as any`, verbatim: `generic-durable-objects: kind 'game' has no method 'moev'.` — correct and prefixed, but unlike the unknown-kind error it does not list the available methods. Listing them (they're one `Object.getOwnPropertyNames(proto)` away) would make untyped/JS callers' lives easier.

## 4. Debugging experience

Building the happy paths, I almost never opened the library source: the error
messages are consistently prefixed with `generic-durable-objects:` and state
both what the host expected and what it found. The kind-mismatch probe is the
best example — using a game's id with the lobby accessor produced, verbatim:

> `Error: generic-durable-objects: this instance is kind 'game', but the caller expected kind 'lobby'.`

That message let me confirm the failure was mine in seconds. Same for the
uninitialized-instance probe (HTTP 400 with
`generic-durable-objects: this instance has no kind yet. Access it through kind() from a Worker, or use a name with a '<kind>:' prefix.`)
— it even tells you the two ways to fix it.

Where debugging degraded was anything involving errors *thrown by my own kind
code*: every rejection reaching the test carries a stack that starts at
`src/client.ts:142` (the library's proxy) and contains zero frames from the DO
that actually threw. For this example that was tolerable because my error
messages embedded the context (`not your turn: it is 'alice' to move`), but I
was effectively forced into "put everything in the message" as a coping
strategy. The shop report quantifies this properly.

The other information gap: nothing tells you which behaviors run in-instance
versus through RPC. When my spectator WebSocket test initially raced the
broadcast, I had to reason about whether `#broadcast` happens synchronously
inside `move()` (it does — the fix was just letting the event loop tick in the
test). A one-line docs note that lifecycle forwarding is direct (not enveloped
like RPC) would have saved that.

## 5. Verdict

Would I adopt this over separate DO classes? **Yes, if I'm anywhere near the
namespace limit or add use cases frequently — with one reservation. 7.5/10.**

The core mechanism (kind pinning via storage + name prefix + hint) is sound
and I could not break it: every mismatch I engineered failed loudly, with the
correct message, before touching data. Migration-free kind addition is a real,
felt benefit — I added `game`, then `MetricsDO`, and only wrote wrangler
config for the new *binding*, never a migration for a new kind. The typed
stub is pleasant and the escape hatches (`.stub`, `KIND_STORAGE_KEY` being
exported) were exactly what testing needed.

The reservation is error fidelity across the RPC boundary (flattening to
`{name, message}`, stacks discarded — see the shop report). For a coordination
workload like this one, where cross-kind calls are the architecture, that is
the difference between a 7.5 and a 9. Fix error propagation and enforce the
reserved-name rule at registration, and I'd default to this library for any
multi-use-case worker.

## 6. Post-fix verification

Re-audited after the library update. All 20 tests pass (16 original, updated
where messages changed, plus 4 new probes proving the fixes). Issue-by-issue:

1. **Reserved stub names silently shadow kind methods — FIXED.**
   `union()` now rejects offending kind classes at class-creation time. New
   probe test, verbatim:
   > `generic-durable-objects: kind 'bad' (class BadKind) defines a method named 'name'. The stub reserves 'id', 'name', 'kind', 'stub' for metadata, so this method would not be callable. Rename the method.`
   The `KindStub` type also strips `id`/`name`/`kind`/`stub` from the method
   mapping, so the confused-but-callable intersection type is gone, and the
   README's "Rules and limits" now states the rule with the getter exemption.
   This is exactly the fix I suggested (same timing as the `:` check).

2. **Renamed kind half-fails silently — IMPROVED.**
   The loud half got louder: the unknown-kind error now names the affected
   instance, verbatim from the updated probe:
   > `generic-durable-objects: unknown kind 'match' on instance '8b87a7cc…d85d38'. Registered kinds: lobby, game.`
   The silent half (`get(name)` under the new name reaching a fresh empty
   instance) is inherent to name-hashed identity and still happens — but the
   README now documents both failure modes explicitly under "Kind renames are
   breaking", which is what I asked for at minimum. No aliasing mechanism was
   added; I'll accept "documented and loud where possible".

3. **`import.meta.url` not typed — UNCHANGED.**
   Still needed my `interface ImportMeta { readonly url: string }`
   augmentation. This is a workers-types/harness gap, not the library's, and
   the README's Testing section now carries real downstream tips
   (`stub.stub` for `cloudflare:test`, storage isolation semantics), which
   covers the docs half of my original complaint.

4. **Opaque TS diagnostic for wrong kind names — IMPROVED.**
   The new `kinds()` accessor turns kind selection into property access. The
   actual diagnostic I captured for a typo (asked to quote it):
   > `error TS2339: Property 'gmae' does not exist on type '{ lobby: KindAccessor<Lobby>; game: KindAccessor<Game>; }'.`
   The valid kind names are now readable directly in the diagnostic
   regardless of registry size — a genuine improvement over
   `KindNames<DurableObjectNamespace<ShopDO>>`. Honest caveat: the changelog
   promised a "Did you mean 'game'?" suggestion, but my capture (tsc 5.9,
   this exact probe) did not include one; TypeScript only offers spelling
   suggestions in some contexts. The runtime accessor works end to end (new
   test: `kinds(env.APP_DO).lobby.get("main").createMatch(...)` then
   `app.game.fromId(id).state()`), and `KindNameOf<NS>` types runtime-built
   names. `kind()` itself still produces the alias-shaped diagnostic, so use
   `kinds()` for literals — the README now says exactly that.

5. **Storage isolation undocumented — FIXED (docs).**
   README Testing section now states, verbatim: "Isolated storage is per test
   **file**; tests within one file share DO state. Use distinct instance
   names per test." Matches observed behavior; my per-test prefixes remain
   the right pattern.

6. **DO-to-DO cross-kind pattern undocumented — FIXED.**
   The README now has a "Calling kinds from inside a kind" section with a
   cart/inventory example — the exact pattern both of my examples are built
   on.

7. **Colon kind name fails at module-eval, not build — UNCHANGED.**
   Same message, same timing. Still a nit; local dev catches it immediately.

8. **Missing-method runtime error doesn't list methods — PARTIALLY IMPROVED.**
   `kind 'game' has no method 'moev'` is unchanged (still no method list),
   but the adjacent failure mode got a dedicated message. New probe against a
   plain property, verbatim:
   > `generic-durable-objects: 'version' on kind 'metrics' is a property, not a method (type: number). The stub only proxies methods; add a getter method to read it.`

Also verified, not from my list: `fromId()` no longer initializes instances.
The new refusal is precise and prescriptive — verbatim from the new probe:
> `generic-durable-objects: instance '5a7c14fe…13ed4c5' has no kind yet. It was accessed as kind 'game' through fromId(), which never initializes an instance. Create the instance first with kind(ns, 'game').get(name) or .unique(), then reach it by id.`
`fetch()` through a `fromId()` stub returns the same text as a 400, and the
refusal persists nothing (a later legitimate initialization still works). My
lobby→game flow needed zero changes: instances are always created via
`unique()` before ids circulate, which suggests the new semantics match how
the API is naturally used. Kind-mismatch messages now name the instance too:
> `generic-durable-objects: instance 'acef58cf…e2bfb9' is kind 'game', but the caller expected kind 'lobby'.`

**Updated score: 9/10** (was 7.5). Both majors from this report are fixed or
documented, the diagnostics improved, and the new `fromId()` semantics remove
a footgun I hadn't even filed (hint-initializing an arbitrary id). What keeps
the last point: the rename story is still "don't", diagnostics through
`kind()` remain opaque (mitigated, not fixed, by `kinds()`), and the missing
"Did you mean" suggestion means the diagnostics claim slightly oversells. I
would now adopt this without reservations for any multi-use-case worker.
