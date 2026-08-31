# DX Report: counter-fleet example — historical pre-facet audit

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

An Actors-style "manage instances" fleet with two kinds in one host class: a
`registry` singleton that creates `counter` instances via
`kind(this.env.APP_DO, "counter").unique()` *from inside the Durable Object*,
persists their ids + labels in its own SQLite, and exposes
`createCounter(label)` / `listCounters()` / `incrementCounter(label)` /
`deleteCounter(label)`; counters expose `increment()` / `value()` and a
best-effort `destroy()`. 15 tests cover fleet CRUD, an HTTP facade, and
adversarial probes (wrong-kind access, constructor throws, deletion
semantics, duplicate class registration).

## 2. What worked well

- **DO-to-DO usage is first-class.** `kind(this.env.APP_DO, "counter")`
  inside the registry worked exactly like in a Worker, including the
  TypeScript circularity `Env → AppDO → union({registry: Registry}) →
  Registry.env: Env` — I expected `tsc` to choke on that loop and it didn't.
- **Cross-kind isolation is real and loudly enforced.** Same logical name
  under two kinds → different ids; reaching an initialized instance through
  the wrong accessor fails with a precise message (see below). Registering
  the same class under two kind names (`counter` and `tally`) just works and
  produces disjoint fleets.
- **Type-level DX is the best part.** A typo'd method gives
  `error TS2551: Property 'incremnt' does not exist on type
  'KindStub<Counter>'. Did you mean 'increment'?` — with the fix suggested.
  `r.ctx` is correctly rejected (`TS2339 ... does not exist on type
  'KindStub<Registry>'`), so internals don't leak through the stub type.
- **Kind-authored errors propagate with their message intact**: the
  registry's own `throw new Error("registry: label 'dup' already exists")`
  arrived verbatim at the test through two RPC hops.

## 3. Papercuts and issues

1. **`fromId()` on a never-touched id silently pins whatever kind the caller
   claims** — severity: **major** (worst issue I found), category:
   runtime-errors / API-shape.
   - Repro: `const id = kind(ns, "counter").unique().id.toString()` but never
     call anything (mint-only — exactly what `unique()` encourages, since the
     docs say "Store `stub.id.toString()`"). Later, by bug or stale data, do
     `kind(ns, "tally").fromId(id).increment(1)`.
   - Observed: **no error.** The instance has no stored kind and no name
     prefix, so the wrong caller's hint wins and the instance is permanently
     pinned as `tally`. The *correct* accessor then becomes the one that
     fails:
     ```
     Error: generic-durable-objects: this instance is kind 'tally', but the caller expected kind 'counter'.
     ```
     So a mis-routed id doesn't just fail — it corrupts the instance's
     identity and blames the innocent caller afterwards.
   - Expected/desired: `fromId()` should not have first-contact
     initialization power; only the accessor that minted the id (or an
     explicit opt-in) should.
   - Suggested change: differentiate "initialize" from "attach": `unique()`
     stubs send an init-allowed hint, `fromId()` stubs send a verify-only
     hint that errors on an unpinned instance (message like "this id was
     never initialized; call through the accessor that created it"). At
     minimum, document this in "Identity".

2. **There is no deletion story, and `deleteAll()` makes the obvious one a
   trap** — severity: **major**, category: API-shape / docs.
   - What a real user tries for `deleteCounter`: (a) `storage.deleteAll()` —
     works, but wipes `__gdo:kind` too. The warm instance keeps serving with
     its tables dropped (`Error: no such table: counter: SQLITE_ERROR` on the
     next call, from an instance state that a fresh boot can never produce);
     after eviction, a unique-id instance is a kindless husk: raw access
     yields `__gdoKind() → undefined` and fetch → 400 `has no kind yet`,
     while *any* hinted call resurrects it as an empty counter of whatever
     kind the caller claims (see issue 1). (b) `ctx.abort()` on top — evicts
     the instance but always kills the in-flight RPC, so `deleteCounter`
     cannot both abort the counter and return a value; the caller of my
     `nuke()` probe always sees `Error: counter nuked`, and workerd logs
     `broken.outputGateBroken` for each subsequent use of the old stub.
     (c) True deletion doesn't exist on the platform. My registry settled on
     deleteAll-then-forget-the-id, which means "deleted" counters are
     trivially resurrected by anyone still holding the id.
   - Observed (deterministic in tests): named instances self-heal after
     restart via the name prefix — data gone, identity intact ("phoenix"
     probe); unique instances stay amnesiac until re-hinted ("husk" probe).
   - Suggested change: ship a supported `destroy()` on the host (deleteAll +
     tombstone key + reject subsequent calls with "this instance was
     destroyed"), and a README section on instance lifecycle/deletion. This
     is table stakes for the "manage instances" pattern the library enables.

3. **A throwing kind constructor pins the kind before ever succeeding**
   — severity: **minor**, category: runtime-errors.
   - Repro: register a kind whose constructor throws; call any method.
   - Observed: first RPC rejects with the constructor's own error, verbatim:
     ```
     Error: BrokenKind constructor exploded: missing config
     ```
     Good: the message is the real one, and retries re-run the constructor
     (transient failures can recover; `#loading` reset works). Bad: storage
     already has `__gdo:kind = "broken"` even though no instance ever
     completed construction — the pin happens *before* `new Kind(...)`. Also
     nothing identifies which instance or kind threw; for a fleet of
     hundreds of unique-id counters, the id matters.
   - Suggested change: persist the kind *after* the constructor succeeds
     (or accept and document the current order), and wrap constructor errors
     with kind + instance id context.

4. **`stub.name` reflects how the stub was made, not what the instance is**
   — severity: **minor**, category: API-shape.
   - Repro: `const named = kind(ns, "counter").get("named");
     kind(ns, "counter").fromId(named.id).name`.
   - Observed: `undefined` — even though the target instance *has* a logical
     name and the id round-trips (`roundTripped.id.toString() ===
     named.id.toString()`). For `unique()` stubs `name` is `undefined` as
     expected. The README table says "The logical name, when created with
     `get(name)`", which is accurate but easy to read as "the instance's
     name".
   - Suggested change: either derive the name lazily (id → name is not
     possible client-side, so probably not) or rename/document it as
     "the name this stub was created with".

5. **Forgotten `unique()` ids are unrecoverable, and the library is silent
   about it** — severity: **minor**, category: docs.
   - The accessor's whole surface is `get / unique / fromId / idFromName`
     (asserted in a test). There is no enumeration, and nothing warns that
     dropping the id string loses the instance (and strands its storage
     forever, invisibly billed). The registry-kind pattern in this example is
     the correct answer — the README should show it, since "manage many
     unique instances" is precisely what a 500-namespace-constrained team
     will do. One line ("Store `stub.id.toString()` to reach it again") is
     not enough guidance for a durable-data system.

6. **Unknown kind name: the TS error names an unhelpful type** —
   severity: **nit**, category: types.
   - Repro: `kind(env.APP_DO, "not-a-kind")`.
   - Observed, verbatim:
     ```
     error TS2345: Argument of type '"not-a-kind"' is not assignable to parameter of type 'KindNames<DurableObjectNamespace<AppDO>>'.
     ```
     It errors (good — invalid kinds can't compile) but doesn't list the
     valid kind names the way a union type would ('"registry" | "counter" |
     "tally" | "broken"').
   - Suggested change: shape `KindNames` so the diagnostic prints the literal
     union of registered names.

7. **The stub proxy turns every property into a function** — severity:
   **nit**, category: API-shape.
   - `typeof (c as any).anything === "function"` — feature detection lies,
     and a typo'd call only fails when awaited (runtime message is good:
     `generic-durable-objects: kind 'counter' has no method 'incremnt'.`).
     Unavoidable with the proxy design (the client can't know the method set
     without importing the kind class), but worth a README sentence.

8. **Test harness: storage is shared across tests in a file (new plugin
   API)** — severity: **minor**, category: docs/debugging (adjacent, not the
   library's code).
   - `@cloudflare/vitest-pool-workers` 0.22's `cloudflareTest()` plugin has
     no `isolatedStorage` option (checked the shipped `WorkersPoolOptions`
     schema), so my second test saw the first test's registry rows
     (`Error: registry: label 'alpha' already exists`). The library's own
     test suite quietly avoids this with unique instance names per test —
     that convention belongs in the README's Testing section, because every
     adopter will hit it within the first hour. Related repo hygiene: the
     root vitest config has no `test.include`, so the repo's own `npm test`
     sweeps up `examples/**/*.test.ts` and runs them against the fixture
     worker; my test files guard against that with a `__gdoKind()` probe and
     `describe.skipIf`.

## 4. Debugging experience

Most failures in this example were *good* failures: the wrong-kind error
names both kinds, the missing-method error names the method, and the
registry's own errors travel through two RPC hops (test → registry →
counter) unmangled. What cost me time: (1) cross-test state bleed — the
symptom was a domain error ("label 'alpha' already exists") pointing at my
code, and only after suspecting the harness and reading the shipped plugin
types did I confirm storage isolation doesn't exist in this pool version;
(2) every remote failure's stack terminates at `Proxy.<anonymous>
src/client.ts:142:23`, so "which kind method threw" always required reading
workerd's stderr instead of the assertion output; (3) the silent wrong-kind
pinning (issue 1) produced no failure at the moment of the actual bug — I
only knew because I wrote a test looking for it, which is exactly how it
would slip into production. The information I most wished for: instance ids
in host error messages, and remote stacks on client-thrown errors.

## 5. Verdict

**7.5/10 — adopt, with two guardrails.** For the fleet pattern, the library
beats separate DO classes decisively: the registry + unique counters design
needs exactly one binding and one migration, DO-internal `kind()` calls are
fully typed, and cross-kind isolation held under every attack I tried
*except one*. That one — `fromId()` silently pinning an unpinned instance to
the wrong kind — is the reason this isn't an 8.5: it converts a stale-id bug
into permanent identity corruption with no error at the point of fault. The
second gap is the missing deletion/lifecycle story, which the "manage
instances" pattern makes unavoidable. Fix those (one code change, one docs
section) and I'd default to this library for any multi-use-case Workers
project.

## 6. Post-fix verification

Re-audited after the library update. Status of each issue from section 3,
with new verbatim evidence from the re-run suite (20/20 passing, including
5 new tests that prove the fixes):

1. **`fromId()` silently pins the wrong kind — FIXED.** `fromId()` (and
   `fetch()` through a fromId stub) never initializes anymore. The impostor
   access on a never-touched id now fails, verbatim:
   ```
   generic-durable-objects: instance '<64-hex id>' has no kind yet. It was accessed as kind 'tally' through fromId(), which never initializes an instance. Create the instance first with kind(ns, 'tally').get(name) or .unique(), then reach it by id.
   ```
   Proven end to end in the updated probe: after the impostor attempt the
   instance is *still unpinned* (`__gdoKind()` → `undefined`), the original
   `unique()` stub initializes it as `counter`, and the cross-kind accessor
   then fails with the mismatch error. The uniform rule (fromId can never
   first-contact, even for the correct kind) is a small ergonomic cost —
   my registry has to touch each counter once at creation — and exactly the
   right trade.

2. **No deletion story / deleteAll trap — IMPROVED (mostly fixed).** The new
   `resetStorage(ctx)` helper wipes storage but re-pins the kind. I switched
   the fleet's `destroy()` to it and proved the husk is gone: a unique
   counter survives destroy + `ctx.abort()` with `__gdoKind()` still
   `"counter"`, and `fromId()` reaches the empty instance afterwards. The
   README's new "Storage lifecycle" section documents the recipe and states
   plainly that instances can only be emptied, never deleted. Remaining
   sharp edges: a warm instance is still broken until restart after any
   wipe (`no such table: counter: SQLITE_ERROR` — constructor doesn't
   re-run), and a *raw* `deleteAll()` on a unique instance is now
   permanently fatal (my `nuke()` probe: `fromId()` refuses forever, and
   the registry's own internal `fromId()` calls fail on the dead record —
   a robust registry must tolerate that in its delete path).

3. **Constructor throws pin the kind before ever succeeding — UNCHANGED
   (order), IMPROVED (debuggability).** The host still persists
   `__gdo:kind` before running the constructor, so `broken:boom` reports
   kind `broken` despite never constructing. But the error now arrives with
   the real remote stack pointing into the constructor, which addresses the
   "which instance/kind threw" half of the complaint.

4. **`stub.name` reflects stub creation, not instance identity —
   UNCHANGED.** `fromId(named.id).name` is still `undefined`. Documented
   behavior; still mildly surprising.

5. **Forgotten unique() ids unrecoverable / thin guidance — IMPROVED
   (docs).** The README's Identity section now spells out the contract
   (`unique()` pins on first call; store the id; `fromId()` never
   initializes). No enumeration API — that is a platform limit — but the
   fromId error message itself now teaches the recovery model.

6. **Unknown-kind TS diagnostic is opaque — IMPROVED.** The new `kinds()`
   accessor turns kind selection into property access; a typo now yields,
   verbatim:
   ```
   error TS2551: Property 'countr' does not exist on type '{ registry: KindAccessor<Registry>; counter: KindAccessor<Counter>; tally: KindAccessor<Counter>; broken: KindAccessor<...>; }'. Did you mean 'counter'?
   ```
   — the full kind list plus a suggestion. `kind()` itself still produces
   the opaque `...not assignable to parameter of type
   'KindNameOf<DurableObjectNamespace<AppDO>>'`, but it is now positioned
   as the runtime-name escape hatch (with the exported `KindNameOf` type,
   which I exercised in a test).

7. **Proxy turns every property into a function — IMPROVED.** `typeof`
   still lies (inherent to the proxy), but calling a plain property now
   explains itself, verbatim:
   ```
   generic-durable-objects: 'flavor' on kind 'counter' is a property, not a method (type: string). The stub only proxies methods; add a getter method to read it.
   ```
   And the reserved-name shadowing corner is closed: `union()` now throws at
   class-creation time if a kind defines a method named `id`/`name`/`kind`/
   `stub` (verified verbatim in a new test), while getters stay allowed.

8. **Harness: shared storage per test file, root config sweep — FIXED
   (root) / DOCUMENTED (storage).** The root vitest config now has an
   include filter (`npm test` runs only the library's 24 tests;
   `npm run test:examples` exists for examples), and the README Testing
   section documents both the `stub.stub` requirement and the
   distinct-instance-names-per-test convention.

Bonus verified beyond my original list: transport-level failures are now
wrapped with call context —
`generic-durable-objects: call to counter.weird() failed: Could not
serialize object of type "Unserializable". This type does not support
serialization.` with the original error as `cause` — and error `name` plus
own enumerable fields (`DuplicateLabelError`, `.label`) survive the RPC hop
along with the remote stack and the
`at [remote call registry.createCounter() via generic-durable-objects]`
marker.

**Updated score: 9/10** (up from 7.5). Both majors are resolved: silent
kind pinning is gone (replaced by the best error message in the library),
and the lifecycle story exists with a helper, docs, and honest platform
caveats. The remaining half-point gaps: warm instances still serve with
wiped tables until restart (the library could invalidate its cached impl
after `resetStorage`), and constructor failures still pin the kind before
first success.
