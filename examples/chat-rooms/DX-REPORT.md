# DX report: chat-rooms (PartyServer kind + plain DO kind, cross-kind RPC) — historical pre-facet audit

> **Facet-native update (2026-08-31).** This example now imports `DurableObject`
> from claydo and runs every kind in an isolated Durable Object facet. The
> supervisor keeps routing, kind identity, migration state, and virtualized
> alarms outside user storage. The tests were updated for the new lifecycle:
> `deleteAll()` cannot erase kind identity, post-delete writes and alarms are
> preserved, and stable public stubs survive facet eviction. The detailed report
> below is the original build-time audit; findings about shared host storage,
> `__claydo:kind` in user data, or kind-less husks are historical and are
> resolved by this refactor.

Audit of `generic-durable-objects` v0.1.0, written while building this
example. Environment: Node 22, vitest 4.1.11, `@cloudflare/vitest-pool-workers`
0.22, `partyserver` 0.5.10, workers-types v5, compatibility date 2026-08-01.
Result: 20/20 tests passing (`test/chat.test.ts`, `test/probes.test.ts`),
`tsc` clean.

## 1. What I built

A chat room system with two kinds in one host DO class: `chat`, a real
PartyServer `Server` subclass (hibernating WebSockets, join/leave presence,
broadcast), and `limiter`, a plain `DurableObject` implementing a per-user
fixed-window rate limit backed by SQLite. On every chat message, the chat DO
makes a cross-kind call from inside the Durable Object —
`kind(this.env.APP_DO, "limiter").get(userId).consume()` — and rejects
messages over the limit.

## 2. What worked well

- **The core promise holds.** One exported class, one binding, one migration.
  Adding the second kind was a one-line code change, no wrangler edits.
- **A real PartyServer `Server` registers as a kind unchanged.** Connect,
  broadcast, presence, hibernating message delivery, and reconnects all
  worked on the first run. That is genuinely impressive for ~350 lines.
- **Cross-kind calls from inside a DO are exactly the same API as from a
  Worker.** `kind(this.env.APP_DO, "limiter").get(id).consume()` was fully
  typed with no extra ceremony, and the same limiter instance is visible
  from the outside through the same accessor. This is the best part of the
  library.
- **Server-push via stub RPC.** `kind(ns, "chat").get(room).broadcast(msg)`
  from the test/Worker reached live WebSocket clients. Not documented, but a
  very useful emergent property.
- **Runtime error messages carry context.** The wrong-kind and unknown-kind
  errors name both sides and list the registered kinds (see §3.10).
- **The typo diagnostic is best-in-class:** TS2551 with a "Did you mean
  'consume'?" suggestion (§3.9).
- **`stub.stub` escape hatch** made `cloudflare:test` helpers usable without
  fighting the wrapper.

## 3. Papercuts and issues

### 3.1 Silent wrong-kind pinning on `unique()` instances

- **Severity:** blocker (data-integrity footgun)
- **Category:** API-shape / runtime-errors
- **Repro:** create a unique id under one kind, but let the *first* contact
  arrive through another kind's `fromId()`:

  ```ts
  const intendedChat = kind(env.APP_DO, "chat").unique();   // no contact yet
  const impostor = kind(env.APP_DO, "limiter").fromId(intendedChat.id);
  await impostor.consume();          // SUCCEEDS and pins kind 'limiter'
  await intendedChat.roomInfo();     // now fails forever
  ```

- **Observed:** the impostor call succeeds silently; the instance is
  permanently a `limiter`. The original accessor then fails with:

  > `generic-durable-objects: this instance is kind 'limiter', but the caller expected kind 'chat'.`

  — which blames the *chat* caller, i.e. the innocent party. (Test:
  `probes.test.ts` › "FOOTGUN: silently pins the wrong kind…")
- **Expected:** `unique()` should pin the kind eagerly (one RPC at creation),
  or the id should encode the kind so `fromId()` can verify before first
  contact.
- **Suggested change:** make `unique()` immediately call something like
  `__gdoInit(kind)`; document the race until then.

### 3.2 PartyServer's companion helpers don't work (`getServerByName`)

- **Severity:** major
- **Category:** API-shape / docs
- **Repro:** `await getServerByName(env.APP_DO as any, "chat:room")`
- **Observed (verbatim):**

  > `TypeError: The RPC receiver does not implement "setName".`

  It also surfaces a second time as an *uncaught* rejection in the test
  output even though my code caught it (PartyServer's retry wrapper).
- **Expected:** either work, or be documented as unsupported. The README
  advertises PartyServer compatibility ("The integration test suite runs a
  real PartyServer Server as a kind") without mentioning that only
  `Server` itself works — none of `getServerByName`, `setName`/`props`
  delivery, or `onStart`-before-RPC guarantees survive, because the host
  only exposes `__gdoCall` and does not forward arbitrary RPC methods.
- **Suggested change:** a "What doesn't work from PartyServer" README
  section; longer-term, consider forwarding `setName` or providing an
  equivalent `ensureStarted()` on the kind stub.

### 3.3 `routePartykitRequest` only half-works, with a kind-prefixed URL hack

- **Severity:** major
- **Category:** API-shape / docs
- **Repro:** `routePartykitRequest(req, env)` with the standard partysocket
  URL shape `/parties/<binding>/<room>`.
- **Observed:**
  - `/parties/app-do/chat:pk-room` → **works** (101, presence, broadcast),
    because the room segment `chat:pk-room` happens to carry the kind
    prefix, and the host resolves the kind from `ctx.id.name`.
  - `/parties/app-do/pk-room` → **400** with verbatim body:

    > `generic-durable-objects: this instance has no kind yet. Access it through kind() from a Worker, or use a name with a '<kind>:' prefix.`
- **What a real PartyServer user would miss:** the party segment is the
  kebab-cased *binding* name (`app-do`), not the kind, so all kinds share
  one party namespace; clients must smuggle the kind into the room name
  (`room: "chat:lobby"` in PartySocket). `onBeforeConnect` lobbies see the
  mangled name. There is no `x-gdo-kind` hint on this path, so any
  unprefixed name 400s. Multi-party projects (`/parties/chat/...`,
  `/parties/limiter/...`) cannot be expressed at all.
- **Suggested change:** ship a `routeKindRequest(req, env.APP_DO)` helper
  that maps `/parties/<kind>/<name>` onto `kind(ns, k).get(name).fetch()`,
  and document the PartySocket recipe.

### 3.4 `this.name` inside the Server includes the kind prefix

- **Severity:** minor (but it leaks into user-visible data)
- **Category:** API-shape
- **Repro:** `roomInfo()` RPC on room `prefixed` returns
  `{ name: "chat:prefixed", connections: 1 }`; the `welcome` message the
  server naturally builds from `this.name` says `room: "chat:lobby"`.
- **Observed:** every PartyServer API that reflects `this.name` (welcome
  payloads, logs, PartyServer's own error messages like
  `Error in Chat:chat:lobby webSocketMessage`) shows the mangled name.
  `instanceName(this.ctx)` exists but PartyServer code paths don't use it.
- **Expected/desired:** documented prominently; ideally a way to strip the
  prefix at the naming layer (the README does mention this, buried in the
  third-party section).
- **Suggested change:** at minimum add "your kind sees `<kind>:<name>`
  everywhere `ctx.id.name` is used" to the Identity section with the
  `instanceName()` counter-recipe.

### 3.5 RPC errors lose the original stack (and `cause`)

- **Severity:** major
- **Category:** debugging
- **Repro:** any kind method that throws; see also the collab-doc report
  §3.1 for the full verbatim capture.
- **Observed:** the caller receives an `Error` with only `name` and
  `message`; the stack is fabricated client-side and points into
  `src/client.ts` (`makeStub`), never at the kind code that threw. Asserted
  in `probes.test.ts` › "keeps only name+message…".
- **Suggested change:** carry `stack` (and `cause` chain) in the
  `GdoCallResult` error envelope, at least behind a debug flag, and attach
  it as `error.cause` client-side.

### 3.6 Stub type surface is polluted for framework kinds

- **Severity:** minor
- **Category:** types
- **Repro:** autocomplete on `kind(env.APP_DO, "chat").get("x").`
- **Observed:** the stub exposes every public PartyServer method as an async
  RPC: `onConnect`, `onMessage`, `onClose`, `onError`, `onRequest`,
  `onStart`, `onAlarm`, `setName`, `sql`, `getConnection`,
  `getConnections`, `getConnectionTags`, `broadcast`, `_initAndFetch`…
  Most are nonsense to call remotely (`onConnect` from a Worker?), some
  would throw on non-serializable args, and they drown out the one method I
  wrote (`roomInfo`). (`broadcast` being callable is actually useful — see
  §2 — which shows the line is blurry.)
- **Suggested change:** let a kind opt into an explicit RPC surface, e.g.
  `union({ chat: expose(Chat, ["roomInfo", "broadcast"]) })` or a
  `static rpc = [...]` convention.

### 3.7 Reserved stub names are not enforced anywhere

- **Severity:** major (silent breakage)
- **Category:** types
- **Repro:** register a kind with a method named `name`, `kind`, `id`, or
  `stub` (README: "These method names are reserved on stubs"). It compiles
  with no diagnostic. `test/type-probes.ts` shows the resolved types are
  impossible intersections:

  ```
  KindStub<T>["name"] = (() => Promise<string>) & string
  KindStub<T>["stub"] = (() => Promise<number>) & DurableObjectStub
  ```

- **Observed:** `stub.name()` typechecks, but at runtime the proxy's meta
  property shadows the method, so `stub.name` is a string and the call
  crashes with a plain `TypeError`.
- **Suggested change:** make `union()` reject reserved method names at the
  type level (mapped-type constraint) or at runtime like it already does
  for kind names containing `:`.

### 3.8 Any unknown property on the stub is a callable function

- **Severity:** minor
- **Category:** API-shape
- **Repro:** `typeof (stub as any).definitelyNotAMethod` → `"function"`.
- **Observed:** the proxy can't know the kind's methods, so feature
  detection (`if (stub.foo) ...`) always passes and only fails at call
  time. Also `await stub` had to be special-cased (`then` returns
  undefined) — worth documenting.
- **Suggested change:** document; optionally ship the method list to the
  proxy (it's statically known in `union()`) so unknown keys return
  `undefined`.

### 3.9 TypeScript diagnostics: one great, one opaque

- **Severity:** minor
- **Category:** types
- **Verbatim diagnostics** (from `npx tsc -p examples/chat-rooms/tsconfig.json`
  on `test/type-probes.ts` with the suppressions removed):

  ```
  error TS2551: Property 'consme' does not exist on type 'KindStub<Limiter>'. Did you mean 'consume'?
  error TS2345: Argument of type '"mailer"' is not assignable to parameter of type 'KindNames<DurableObjectNamespace<AppDO>>'.
  error TS2339: Property 'windowMs' does not exist on type 'KindStub<Limiter>'.
  ```

- The typo error is excellent. The unknown-kind error is the weak one: it
  names the unresolved alias `KindNames<DurableObjectNamespace<AppDO>>`
  instead of listing `"chat" | "limiter"`. A newcomer has to go read the
  library types to learn what's legal.
- **Suggested change:** define `kind()`'s second parameter so the union of
  literal names appears in the error (e.g. constrain via
  `K extends keyof RegistryOf<NS> & string` at a position TS will expand).

### 3.10 Runtime message for a plain property is misleading

- **Severity:** nit
- **Category:** runtime-errors
- **Repro:** `Limiter` has a public property `windowMs = 60000`;
  `(stub as any).windowMs()` rejects with verbatim:

  > `generic-durable-objects: kind 'limiter' has no method 'windowMs'.`

  The kind *does* have `windowMs` — it's just not a method. Compare the
  (good) unknown-kind and wrong-kind messages:

  > `generic-durable-objects: unknown kind 'mailer'. Registered kinds: chat, limiter.`

  > `generic-durable-objects: this instance is kind 'limiter', but the caller expected kind 'chat'.`

- **Suggested change:** distinguish "exists but is not a function" (say
  "property 'windowMs' exists but is not callable; RPC covers methods
  only") from "no such member".

### 3.11 Throwing inside a WebSocket handler is invisible to everyone but the log reader

- **Severity:** major
- **Category:** debugging
- **Repro:** `Chat.onMessage` throws on the `/throw` message.
- **Observed:** the client receives nothing — no error frame, no close; the
  connection keeps working. Because PartyServer's `webSocketMessage`
  *returns* the `onMessage` promise from inside its try/catch, an async
  rejection escapes its own error handling and surfaces as an uncaught
  rejection in workerd. Verbatim test-runner output:

  ```
  uncaught exception; source = Uncaught (in promise); stack = Error: chat kind: deliberate failure inside onMessage
      at Chat.onMessage (/workspace/examples/chat-rooms/worker.ts:113:13)
      at Chat.webSocketMessage (/workspace/node_modules/partyserver/src/index.ts:774:19)
      at AppDO.webSocketMessage (/workspace/src/host.ts:218:7)
  ```

  Note the stack here is *good* (real file/line, and you can see the host →
  partyserver → kind chain). Partly a PartyServer issue, but the host's
  forwarding adds no protection or reporting either.
- **Suggested change:** an optional `onKindError(kind, handler, error)`
  hook on `union()` so apps can report/close deliberately.

### 3.12 Test-harness papercuts hit before the first test ran

- **Severity:** minor (environment, not the library — but it's the on-ramp)
- **Category:** docs/debugging
- Two failures in a row while wiring vitest:
  1. `configPath: new URL("./wrangler.jsonc", import.meta.url).pathname`
     fails because vitest 4 transpiles the config into
     `node_modules/.vite-temp`. Verbatim:

     > `ParseError: Could not read file: /workspace/node_modules/.vite-temp/wrangler.jsonc`

     Fix: cwd-relative `configPath` and always run vitest from the repo
     root.
  2. `import.meta.url` is a *type* error under workers-types
     (`Property 'url' does not exist on type 'ImportMeta'`) because the
     Node-side config file is checked with the Workers `ImportMeta`.
- **Suggested change:** the library README's Testing section should show a
  complete working example-project config, since every adopter will hit
  this within five minutes.

### 3.13 Example tests break the repo's own `npm test`

- **Severity:** minor
- **Category:** docs (repo layout)
- **Repro:** with example folders present, plain `npx vitest run` at the
  root picks up `examples/**/test/*.test.ts` with the *root* wrangler
  fixture (kinds `counter`/`echo`/…), and 118 tests fail with
  `unknown kind 'chat'`-style errors.
- **Suggested change:** root `vitest.config.ts` should set
  `test.include: ["test/**/*.test.ts"]` (I could not change root files in
  this audit).

## 4. Debugging experience

The first real failure was environmental, not the library's: the documented
`new URL(..., import.meta.url)` pattern for `configPath` exploded with
`ParseError: Could not read file: /workspace/node_modules/.vite-temp/wrangler.jsonc`.
The error at least contained the resolved path, which made the .vite-temp
relocation obvious — but I only knew a cwd-relative path was the fix because
the library's own root config uses one. A newcomer without that reference
would burn time here.

Once tests ran, the library itself was pleasantly boring: the chat kind, the
limiter kind, and the cross-kind call worked first try. My one functional
test failure was PartyServer connection ordering (asserted `["alice","bob"]`,
got `["bob","alice"]`) — the assertion diff made that a 30-second fix.

The debugging story splits sharply by transport. For **WebSocket-path
errors**, the only signal is workerd's `uncaught exception` log — but that
log is honest: real file, real line, and the full host → partyserver → kind
frame chain. If you're watching logs you're fine; if you're watching the
client, you see nothing at all (no close frame, no error frame). For
**RPC-path errors**, it's inverted: the caller gets a clean typed rejection
with a good message, but the stack is manufactured in `src/client.ts` and
the DO-side stack is discarded by the error envelope — `name` and `message`
are all that survive. If `consume()` had failed somewhere deep inside the
limiter, the message would be my only clue; there is no `cause`, no remote
stack, no kind/method breadcrumb on the error object. That's the single
biggest debugging gap.

The wrong-kind error message deserves praise (it names both kinds), but it
attributes blame to whichever caller arrives *second*, which in the
unique-id pinning scenario (§3.1) is exactly backwards, and nothing in
storage tells you when or who pinned the kind.

## 5. Verdict

**7/10 — I would adopt it for RPC-and-WebSocket app kinds, with guardrails.**

The core mechanism is sound and the happy path is genuinely better than
maintaining N migrations: registering a real PartyServer `Server` next to a
plain DO kind and doing typed cross-kind calls from inside a DO worked with
zero friction, and error messages that list registered kinds show real care.
What keeps it from an 8+: the `unique()`/`fromId()` first-contact-wins
pinning footgun (§3.1) is a genuine correctness hazard in multi-team code;
RPC errors arriving without stacks (§3.5) will make production incidents
slower to resolve; and the PartyServer story is oversold — `Server` works,
but `getServerByName`, `routePartykitRequest`, and partysocket URL
conventions all need workarounds or don't work (§3.2–3.3), which a README
following "register them directly" does not prepare you for. All are
fixable without changing the architecture.

## 6. Post-fix verification

Re-audited after the library update (RPC error envelope with stacks,
`fromId()` no-init, `kinds()` accessor, reserved-name enforcement, message
rewrites, README overhaul). Suite green: **22/22 tests** (two new tests
added to prove fixes), `tsc` clean. Verdict per issue:

- **§3.1 wrong-kind pinning on `unique()` — FIXED.** `fromId()` never
  initializes anymore. The impostor call now fails up front, verbatim:

  > `generic-durable-objects: instance '<64-hex id>' has no kind yet. It was accessed as kind 'chat' through fromId(), which never initializes an instance. Create the instance first with kind(ns, 'chat').get(name) or .unique(), then reach it by id.`

  `fetch()` through a `fromId()` stub returns the same message as a 400.
  The intended kind still owns first contact, and `fromId()` under the
  correct kind works after initialization. Proven end-to-end in
  `probes.test.ts` › "FIXED: fromId() never initializes…". This was my
  blocker; the fix is exactly the eager-refusal semantics I asked for.
- **§3.2 `getServerByName` — improved (docs only).** Behavior unchanged
  (still `TypeError: The RPC receiver does not implement "setName".`), but
  the README now states plainly that it is **not supported** and points at
  `kinds(env.APP_DO).game.get(name)` as the equivalent. Honest docs beat a
  silent gap; acceptable resolution.
- **§3.3 `routePartykitRequest` — improved.** Routing semantics unchanged
  (kebab-cased binding as the party, kind smuggled in the room name still
  works; unprefixed rooms still 400). Two real improvements: the README now
  documents a manual-routing recipe instead of implying compatibility, and
  the 400 body now explains the exact mistake, verbatim:

  > `generic-durable-objects: instance 'plain-room' has no kind yet. Its name has no registered '<kind>:' prefix. Raw namespace access (for example getByName('plain-room')) reaches a different instance than kind(ns, '<kind>').get('plain-room'). Access instances through the kind() helper, or use a '<kind>:' prefixed name.`

  My suggested `routeKindRequest()` helper was not built — a PartySocket
  user still writes the route by hand.
- **§3.4 `this.name` kind prefix — improved (docs only).** Still
  `chat:prefixed` (asserted unchanged in `chat.test.ts`); the README now
  calls it out in a prominent "what works, and what to know" list with the
  `instanceName()` counter-recipe, which is what I asked for at minimum.
- **§3.5 RPC errors lose stack/cause — FIXED.** The caught error now
  carries the remote frames, then a marker, then local frames:

  ```
  at AppDO.#load (/workspace/src/host.ts:178:15)
  at AppDO.__gdoCall (/workspace/src/host.ts:251:33)
  at [remote call chat.roomInfo() via generic-durable-objects]
  at Proxy.<anonymous> (/workspace/src/client.ts:206:15)
  at /workspace/examples/chat-rooms/test/probes.test.ts:90:20
  ```

  Own enumerable serializable fields survive too (proven in the collab-doc
  report §6). `instanceof` still does not survive — documented as
  by-design with "match on `error.name`", which I can live with.
- **§3.6 stub type pollution — unchanged.** `KindStub<Chat>` still
  autocompletes `onConnect`, `setName`, `sql`, and the rest of the
  PartyServer surface. No opt-in RPC allowlist was added.
- **§3.7 reserved names unenforced — FIXED, both layers.** `union()` now
  throws at class-creation time, verbatim:

  > `generic-durable-objects: kind 'bad' (class BadKind) defines a method named 'name'. The stub reserves 'id', 'name', 'kind', 'stub' for metadata, so this method would not be callable. Rename the method.`

  Getters pass (PartyServer's `name` getter registers fine — asserted).
  The type side is clean too: `KindStub` strips the metadata keys, so
  `S["name"]` is `string | undefined` (no more
  `(() => Promise<string>) & string`), and calling it is
  `TS2349: This expression is not callable. Type 'String' has no call signatures.`
  New tests in `probes.test.ts` and updated `type-probes.ts`.
- **§3.8 unknown property is a callable function — unchanged.**
  `typeof (stub as any).anything === "function"` still holds; feature
  detection still fails only at call time.
- **§3.9 TS diagnostics — improved via a new API.** `kind()`'s own error
  only got an alias rename
  (`...parameter of type 'KindNameOf<DurableObjectNamespace<AppDO>>'`),
  still without listing valid names. But the new `kinds()` accessor gets it
  right, verbatim:

  > `TS2339: Property 'mailer' does not exist on type '{ chat: KindAccessor<Chat>; limiter: KindAccessor<Limiter>; }'.`

  > `TS2551: Property 'limter' does not exist on type '{ chat: KindAccessor<Chat>; limiter: KindAccessor<Limiter>; }'. Did you mean 'limiter'?`

  Runtime-verified that `kinds()` reaches the same instances as `kind()`.
- **§3.10 misleading plain-property message — FIXED.** Verbatim:

  > `generic-durable-objects: 'windowMs' on kind 'limiter' is a property, not a method (type: number). The stub only proxies methods; add a getter method to read it.`

  Names the property, its type, and the remedy. Exactly what I suggested.
  Bonus: the unknown-kind and kind-mismatch messages now carry instance
  identity (`unknown kind 'mailer' on instance 'mailer:x'`,
  `instance 'limiter:locked-user' is kind 'limiter', but the caller
  expected kind 'chat'`).
- **§3.11 WS handler throws invisible — improved.** The host now
  `console.error`s with kind + instance context and its `#forward` frame
  shows in the rethrown stack. The client still receives nothing (asserted
  unchanged: no error frame, no close, connection survives); the suggested
  error hook was not added.
- **§3.12 harness papercuts — unchanged** (environment issues, out of the
  library's hands), though the README Testing section now documents the
  `stub.stub` escape hatch and per-file isolated storage.
- **§3.13 examples break root `npm test` — FIXED.** Root vitest config now
  scopes `include` to `test/**/*.test.ts`; verified `npx vitest run` at the
  root passes (24 tests) with the examples present.

**Updated score: 8.5/10 — I would adopt this.** The blocker is gone with
exactly the right semantics, the debugging story went from the weakest
point to a strength (remote stacks with an honest boundary marker), reserved
names are enforced at both the type and runtime layers, and the PartyServer
limitations are now documented instead of implied away. What's left is
polish, not hazard: stub type pollution (§3.6), the phantom callable for
unknown properties (§3.8), a still-opaque `kind()` diagnostic that `kinds()`
merely routes around (§3.9), and a missing PartyKit-style routing helper
(§3.3). None of those would stop me from shipping on it.
