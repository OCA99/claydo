# DX report: collab-doc (WebSocket ops + SQLite op log + alarm compaction + RPC)

Audit of `generic-durable-objects` v0.1.0, written while building this
example. Environment: Node 22, vitest 4.1.11, `@cloudflare/vitest-pool-workers`
0.22, workers-types v5, compatibility date 2026-08-01. Result: 13/13 tests
passing (`test/doc.test.ts`, `test/probes.test.ts`), `tsc` clean. This report
focuses on what this example uniquely exercised; cross-cutting issues found
in both examples (stub proxy behavior, TS diagnostics, harness setup) are
detailed in `../chat-rooms/DX-REPORT.md` and only referenced here.

## 1. What I built

A collaborative text document as a single `doc` kind: WebSocket clients send
insert/delete ops, the DO validates and appends each op to a SQLite op log,
applies it to the current text, and broadcasts it to the other clients. An
alarm compacts the op log into a versioned snapshot row. RPC methods
(`getText()`, `getStats()`, `applyOp()`) work alongside the WebSocket
protocol, and RPC-applied ops are pushed to connected WebSocket clients.

## 2. What worked well

- **Everything on one instance coexists cleanly.** Hibernating WebSockets,
  a SQLite op log, a compaction alarm, and RPC all live on the same kind
  instance with no interference from the host layer. `runDurableObjectAlarm`
  woke the *kind's* `alarm()` correctly through the host's storage-based
  kind resolution.
- **RPC → WebSocket push.** `applyOp()` called over the stub broadcasts to
  live WebSocket clients of the same instance. Test-driving a realtime doc
  from plain RPC calls is a great workflow.
- **State really persists per-instance.** New accessors/stubs observe the
  same op log and text; equal names under other kinds would be different
  instances (verified in the chat-rooms example).
- **`Awaited` return types on the stub are correct.**
  `doc.getText()` is `Promise<string>`, `getStats()` unwraps its promise —
  no double-`await` gymnastics.
- **The error envelope forwards clean domain errors.** My validation error
  thrown inside `applyOp` arrived at the caller with the exact message
  (§3.1) — message fidelity is 100%, it's only the stack that dies.

## 3. Papercuts and issues

### 3.1 An `Error` thrown in an RPC method arrives with no stack, no cause

- **Severity:** major
- **Category:** debugging / runtime-errors
- **Repro:** `applyOp({ type: "insert", pos: 999, text: "x" })` — the kind
  throws `new Error("collab-doc: insert position 999 out of range 0..0")`.
- **Observed:** the caller's rejection has `name: "Error"` and the exact
  message, but the stack is fabricated where the client helper re-creates
  the error, e.g. (captured from the test):

  ```
  Error: collab-doc: insert position 999 out of range 0..0
      at Proxy.<anonymous> (/workspace/src/client.ts:142:23)
      at /workspace/examples/collab-doc/test/probes.test.ts:14:18
      ...
  ```

  `error.stack` contains `src/client.ts` and does **not** contain
  `worker.ts` where the throw happened (asserted in `probes.test.ts`).
  Custom error subclasses would also collapse: only `name`/`message` are
  serialized in `GdoCallResult`, so `instanceof MyError` and any extra
  fields are lost.
- **Expected:** at minimum the remote stack attached as `cause` or in a
  well-known property; ideally optional structured data passthrough.
- **Suggested change:** extend the envelope to
  `{ name, message, stack, data? }` and rehydrate as
  `new Error(message, { cause: remote })`.

### 3.2 A throw inside `webSocketMessage` is completely invisible to the client

- **Severity:** major
- **Category:** debugging
- **Repro:** client sends `{"type":"boom"}`; `Doc.webSocketMessage` throws.
- **Observed:** the client receives **nothing** — no error frame, no close
  event (`client.events === []`), and the connection keeps working (the
  next op gets `{type:"ack",seq:1}`). The only trace is in the server/test
  log, verbatim:

  ```
  uncaught exception; source = Uncaught (in promise); stack = Error: doc kind: deliberate failure inside webSocketMessage
      at Doc.webSocketMessage (/workspace/examples/collab-doc/worker.ts:151:13)
      at AppDO.webSocketMessage (/workspace/src/host.ts:218:18)
  uncaught exception; exception = workerd/jsg/_virtual_includes/iterator/workerd/jsg/value.h:1477: failed: jsg.Error: doc kind: deliberate failure inside webSocketMessage
  ```

  The stack is genuinely useful (real file/line, host frame visible), but
  nothing tells the *client* its op was dropped — in a collab editor that's
  a silent divergence bug. This is workerd behavior, but the host forwards
  handler rejections without any hook to react.
- **Suggested change:** an optional error hook on `union()`
  (e.g. `union(kinds, { onError })`) so an app can send an error frame or
  close the socket with a code; document the default behavior loudly.

### 3.3 Non-serializable RPC returns: class instances explode late, functions silently become stubs

- **Severity:** major (for the inconsistency and the late failure point)
- **Category:** runtime-errors / API-shape
- **Repro A:** `getHandle()` returns `new SnapshotHandle(version)` (a class
  instance with a method).
- **Observed A (verbatim, caught by the caller):**

  > `DataCloneError: Could not serialize object of type "SnapshotHandle". This type does not support serialization.`

  Two problems: (1) the host's own try/catch in `__gdoCall` can't catch it
  — serialization happens *after* the envelope is returned — so it bypasses
  the library's clean-error design and *also* fires a server-side
  `uncaught exception` log; (2) the error names the type but not the kind
  or method, so in a larger app you'd grep for `SnapshotHandle` and hope.
- **Repro B:** `getCallback()` returns `() => {}`.
- **Observed B:** no error at all. The caller receives a workerd
  `JsRpcStub`; `typeof result === "function"` and *calling it works across
  the boundary* (asserted in `probes.test.ts`). Neat, but completely
  undocumented, inconsistent with A, and the stub presumably has lifetime
  (disposal) semantics that the library's `KindStub` types don't model —
  the declared return type is `() => void`, a lie.
- **Suggested change:** document the serialization contract ("structured
  clone + Workers RPC extensions"); consider validating return values in
  `__gdoCall` so failures carry kind+method context and never surface as
  uncaught host exceptions.

### 3.4 README is wrong: `instanceName()` works fine in the constructor

- **Severity:** minor
- **Category:** docs
- **Repro:** the `Doc` constructor stores
  `instanceName(ctx)`; `constructorNameProbe()` returns it.
- **Observed:** for the doc named `ctor-probe`, the constructor captured
  `value: ctor-probe` — no throw, correct value. The README states:
  "Do not call it in the constructor; `ctx.id.name` is not available
  there." Under compatibility date 2026-08-01 in workerd, `ctx.id.name` *is*
  populated in the constructor (PartyServer 0.5.x's docs assert the same).
- **Suggested change:** fix or qualify the README claim (it may be true for
  older runtimes or `unique()` instances — for those, say *that*).

### 3.5 `runDurableObjectAlarm` needs the raw stub — a small trap

- **Severity:** minor
- **Category:** API-shape / docs
- **Repro:** `runDurableObjectAlarm(kind(env.APP_DO, "doc").get("compact"))`
  is a type error (the kind stub is not a `DurableObjectStub`); you must
  pass `stub.stub` or a raw `env.APP_DO.get(...)`.
- **Observed:** once you know, it's fine —
  `env.APP_DO.get(env.APP_DO.idFromName("doc:compact"))` worked, and the
  alarm ran the *kind's* handler. But composing the raw name `"doc:compact"`
  by hand re-introduces exactly the string-mangling the library exists to
  hide (and a typo here silently addresses a different, kindless instance).
- **Suggested change:** README Testing section should show
  `runDurableObjectAlarm(stub.stub as DurableObjectStub)`; the `stub`
  property already exists precisely for this, it's just undocumented in
  context.

### 3.6 First RPC to a fresh instance pays hidden initialization, invisible in types

- **Severity:** nit
- **Category:** API-shape
- **Observed:** every call funnels through `__gdoCall`, which lazily reads
  storage (`get(KIND_STORAGE_KEY)`), possibly writes it, then constructs
  the kind class. My constructor runs three `CREATE TABLE IF NOT EXISTS`
  statements — all fine, but note there is no way to distinguish "first
  contact" from the caller side, and a heavy kind constructor makes the
  first RPC of every instance slow. Not a bug; worth one README sentence
  ("constructors run on first contact per isolate lifetime; keep them
  cheap").

### 3.7 Cross-cutting issues also observed here

Documented with full repros in `../chat-rooms/DX-REPORT.md`:

- Typo'd method at runtime — verbatim:
  `generic-durable-objects: kind 'doc' has no method 'getTxt'.` (good
  message; probes here confirm it).
- Excellent typo diagnostic: `TS2551 ... Did you mean 'getText'?`; opaque
  unknown-kind diagnostic naming `KindNames<...>`; lifecycle methods
  correctly stripped from the stub type
  (`Property 'webSocketMessage' does not exist on type 'KindStub<Doc>'`).
  See `test/type-probes.ts`.
- vitest 4 `configPath`/`import.meta.url` trap; examples breaking root
  `npm test` because the root vitest config lacks an `include` filter.

## 4. Debugging experience

This example mostly *worked*, so the debugging narrative is about the
probes. The pattern that emerged: **the quality of failure information
depends entirely on which transport the failure uses.** RPC failures are
ergonomic (typed rejection, exact message — my out-of-range asserts read
like unit tests) but amputated (no stack, no cause, no kind/method context).
WebSocket-handler failures are the mirror image: rich server-side stacks in
the `uncaught exception` log, absolutely nothing client-side. Serialization
failures are the worst of both: they escape the library's envelope, appear
as *both* a caller-side `DataCloneError` and a server-side uncaught
exception, and name only the offending type — during the audit I knew
`SnapshotHandle` came from `getHandle()`, but in a real codebase the error
gives no kind, method, or instance to start from.

One genuinely confusing discovery moment: I wrote the "returning a function
must fail" probe, and it *passed* the call and handed back something whose
`.name` printed as `RpcProperty {}`. It took reading the vitest-pool-workers
internals in the stack to realize workerd RPC had turned my function into a
live stub. The library's types said `() => void`; the runtime said
"distributed closure". When types and runtime disagree, the audit instinct
says the docs should arbitrate — and the README is silent.

The alarm/compaction path, which I expected to be the flakiest (host alarm
forwarding + storage-resolved kind + test-harness alarm runner), worked on
the first attempt and survived re-scheduling after compaction. Credit where
due: kind resolution from storage is solid.

## 5. Verdict

**7.5/10 for this workload — I would adopt it for a fleet of small
stateful features.** A collab doc is close to the worst case for a "generic"
host (all four surfaces at once: WS, SQL, alarms, RPC), and the host layer
never got in the way; the whole example is one class plus one `union()`
call, and the 500-namespace argument is real if you ship dozens of features
like this. The deductions are the debugging gaps that would hurt at 3 a.m. —
stackless RPC errors (§3.1), silent WebSocket-handler failures (§3.2), and
context-free serialization errors (§3.3) — plus a README that is wrong about
constructors (§3.4) and silent about the serialization contract. Fix the
error envelope and write the missing "failure modes" doc page, and this is
an easy 9 for single-kind workloads like this one.

## 6. Post-fix verification

Re-audited after the library update. Suite green: **13/13 tests** (probes
strengthened, not weakened: the error-propagation tests now assert the new
stack marker, forwarded fields, and wrapped transport errors verbatim),
`tsc` clean. To exercise field forwarding, the doc kind's validation errors
now carry `{ code: "E_RANGE", pos }`. Verdict per issue:

- **§3.1 RPC errors lose stack and fields — FIXED.** The caught error from
  `applyOp({type:"insert", pos:999, ...})` now has the original message,
  `error.code === "E_RANGE"` and `error.pos === 999` forwarded, and a stack
  that starts in my kind code and crosses an explicit boundary marker:

  ```
  Error: collab-doc: insert position 999 out of range 0..0
      at apply (/workspace/examples/collab-doc/worker.ts:29:9)
      at Doc.#append (/workspace/examples/collab-doc/worker.ts:111:18)
      at Doc.applyOp (/workspace/examples/collab-doc/worker.ts:206:28)
      at AppDO.__gdoCall (/workspace/src/host.ts:277:44)
      at [remote call doc.applyOp() via generic-durable-objects]
      at reviveError (/workspace/src/client.ts:219:17)
      at Proxy.<anonymous> (/workspace/src/client.ts:206:15)
      at /workspace/examples/collab-doc/test/probes.test.ts:<caller line>
  ```

  This is the "which transport failed" narrative from §4 resolved: the RPC
  path now tells you the file, the line, and which side of the boundary you
  are on. `instanceof` for custom error classes still does not survive,
  but that is now documented as by-design ("match on `error.name`") in a
  new README "Error propagation" section — my §3.1 asked for exactly this
  envelope, so: fixed as suggested.
- **§3.2 WS-handler throws invisible to the client — improved, not fixed.**
  Asserted unchanged from the client's seat: send `{"type":"boom"}`, receive
  nothing, no close event, next op acks normally. The server side improved:
  the host now `console.error`s with kind + instance context before
  rethrowing, and its `#forward` frame appears in the uncaught-exception
  stack (`at AppDO.#forward (/workspace/src/host.ts:320:15)`). For a collab
  editor the silent-divergence risk remains; an error hook on `union()` is
  still the missing piece.
- **§3.3 serialization failures — improved (class instances fixed, function
  behavior unchanged).** The `SnapshotHandle` return no longer surfaces as a
  bare `DataCloneError`: the caller now gets, verbatim:

  > `generic-durable-objects: call to doc.getHandle() failed: Could not serialize object of type "SnapshotHandle". This type does not support serialization.`

  with the original `DataCloneError` preserved as `error.cause` — kind and
  method context included, which was the core complaint. Two residuals: the
  host-side `uncaught exception` log for the serialization failure still
  fires (noise), and returning a *function* still silently succeeds as a
  callable `JsRpcStub` while the stub type claims `() => void` (asserted
  unchanged). The new README "Serialization rules" section at least
  documents the contract now.
- **§3.4 README wrong about constructors — FIXED.** The docs now read
  "instanceName() is safe anywhere in a kind, including its constructor,
  because kinds construct lazily on first contact" — matching what my
  probe measured (`value: ctor-probe`, still asserted green).
- **§3.5 `runDurableObjectAlarm` needs the raw stub — improved (docs).**
  Behavior necessarily unchanged (the cloudflare:test API wants a real
  `DurableObjectStub`), but the README Testing section now documents
  passing `stub.stub` or a raw namespace stub, plus the per-file isolated
  storage gotcha. That is what I asked for.
- **§3.6 hidden first-contact initialization — unchanged.** Still no
  caller-visible signal for first contact; still only a nit.
- **§3.7 cross-cutting issues** — see the chat-rooms report §6 for the
  full list; highlights relevant here: typo'd-method runtime message
  unchanged (still good), plain-property runtime message fixed, `kinds()`
  accessor added with registry-listing diagnostics, root `npm test` fixed.

**Updated score: 9/10 for this workload.** I wrote in §5 that fixing the
error envelope and writing the failure-modes docs would make this "an easy 9
for single-kind workloads like this one" — both happened, and the envelope
fix is better than I asked for (fields forward, the marker line makes the
boundary legible in one glance). The remaining deductions are the silent
WebSocket failure mode (§3.2, improved but the client still learns nothing)
and the type-level lie about function returns (§3.3 residual). I would ship
a production collab feature on this today.
