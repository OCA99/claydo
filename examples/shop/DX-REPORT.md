# DX report: shop example — historical pre-facet audit

> **Facet-native update (2026-08-31).** This example now imports `DurableObject`
> from claydo and runs every kind in an isolated Durable Object facet. The
> supervisor keeps routing, kind identity, migration state, and virtualized
> alarms outside user storage. The tests were updated for the new lifecycle:
> `deleteAll()` cannot erase kind identity, post-delete writes and alarms are
> preserved, and stable public stubs survive facet eviction. The detailed report
> below is the original build-time audit; findings about shared host storage,
> `__claydo:kind` in user data, or kind-less husks are historical and are
> resolved by this refactor.

Audit of `generic-durable-objects` v0.1.0, written while building this example.
This report owns the **cross-kind error propagation** findings; structural and
type-level findings live in `../game-lobby/DX-REPORT.md`.

## 1. What I built

A commerce worker with two kinds in one host class: per-product `inventory`
instances (`get(productId)`) holding stock in SQLite with `stock()` /
`restock()` / `reserve()` / `release()`, and per-user `cart` instances whose
`checkout()` reserves stock on each product's inventory instance from inside
the cart DO and, when any product is short, releases the already-reserved
items (saga-style compensation) before rethrowing. `reserve()` throws a custom
`OutOfStockError extends Error` carrying `productId`, `requested` and
`available` fields — deliberately, as the key probe. 9 tests, all passing.

## 2. What worked well

- **The compensation flow was easy to write and easy to test.** Sequential
  `reserve()` calls with a `reserved[]` undo list, releases in the catch,
  rethrow. The failed-checkout test asserts both stocks byte-identical to
  their pre-checkout values and it passed first try. Cross-kind fan-out from
  inside a DO (`kind(this.env.APP_DO, "inventory").get(line.productId)`) reads
  like ordinary code.
- **Per-product instances via `get(productId)` are the natural unit.** The
  `<kind>:<name>` scheme meant product ids double as instance names with no
  registry of my own, and `instanceName(this.ctx)` let `reserve()` include the
  product id in its error message without storing it — a genuinely nice touch.
- **Error *messages* survive any number of hops intact.** After
  test → cart → inventory (two RPC boundaries), the caller still sees exactly
  `out of stock: product 't8-widget' has 1 left, cannot reserve 4`, and
  `error.name` is still `OutOfStockError`. Message-and-name fidelity is 100%.
- **The error envelope keeps rejections clean.** Failures arrive as ordinary
  promise rejections that `expect(...).rejects.toThrow(...)` matches — no
  wrapping in opaque internal errors, no "network"-flavored noise.
- **Argument typing across the boundary is real.** `inv.reserve("three")`
  is caught at compile time, verbatim: `error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`

## 3. Papercuts and issues

1. **KEY FINDING: custom error classes are flattened to `{ name, message }` at every RPC hop.**
   Severity: major. Category: runtime-errors/debugging.
   Repro: `inventory.reserve()` throws `OutOfStockError` (an `Error` subclass
   with `productId`, `requested`, `available` fields); catch it one hop away
   (test → inventory) or inside `cart.checkout()` (DO → DO).
   Observed (both hops identical; verbatim from the in-DO probe
   `Cart.probeReserveFailure`, which caught the error inside the cart DO):
   ```json
   {
     "instanceofOutOfStock": false,
     "instanceofError": true,
     "constructorName": "Error",
     "name": "OutOfStockError",
     "message": "out of stock: product 'cap-widget' has 1 left, cannot reserve 5",
     "stackHead": "OutOfStockError: out of stock: product 'cap-widget' has 1 left, cannot reserve 5\n    at Proxy.<anonymous> (/workspace/src/client.ts:142:23)"
   }
   ```
   (`productIdField`/`availableField` are absent from the JSON because they
   are `undefined`.) So: `instanceof OutOfStockError` is `false`, the typed
   fields are gone, and the compensation code in `checkout()` cannot branch on
   error class or read `error.productId` — it must string-match `error.name`
   or parse the message. This is caused by `__gdoCall`'s envelope
   (`host.ts`: `error: { name: cause.name, message: cause.message }`) plus the
   client reconstructing with `new Error(message); error.name = name`.
   Expected: at minimum, own enumerable properties of the error travel with
   it; ideally a documented error-revival story.
   Suggested change: serialize `{ name, message, stack, ...ownEnumerableProps }`
   (they are structured-cloneable in practice or can be best-effort cloned),
   re-attach props on the client, and document that `instanceof` cannot work
   across the boundary — or accept a per-union error registry that revives
   real classes. Also worth noting: native workerd RPC *does* preserve `Error`
   subtypes' own properties for registered error types, so users migrating
   from plain DO RPC will experience this as a regression.

2. **KEY FINDING: the original stack trace is destroyed — and never logged anywhere.**
   Severity: major. Category: debugging.
   Repro: let the `OutOfStockError` propagate uncaught from
   `test → cart.checkout() → inventory.reserve()` (two hops).
   Observed final stack, verbatim:
   ```text
   OutOfStockError: out of stock: product 'cap-widget' has 1 left, cannot reserve 4
       at Proxy.<anonymous> (/workspace/src/client.ts:142:23)
       at /workspace/examples/shop/test/capture-scratch.test.ts:25:5
       at workspace/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20
   ```
   And this is how vitest renders the failure:
   ```text
   OutOfStockError: out of stock: product 'cap-widget' has 1 left, cannot reserve 4
    ❯ Proxy.<anonymous> src/client.ts:142:23
       140|         )) as GdoCallResult;
       141|         if (result.ok) return result.value;
       142|         const error = new Error(result.error.message);
          |                       ^
       143|         error.name = result.error.name;
       144|         throw error;
    ❯ examples/shop/test/capture-scratch.test.ts:31:3
   ```
   Not one frame from `checkout()` or `reserve()` survives; the test runner
   points its caret at the *library's* proxy line, which reads like a library
   bug to anyone triaging. Worse: because `__gdoCall` catches the error and
   returns an envelope, the real exception never becomes an unhandled error in
   the DO either — so in production there is no `wrangler tail` / observability
   record of the true throw site at all. The stack is not degraded; it is
   deleted. Every intermediate hop (the cart's catch-release-rethrow) is
   likewise invisible.
   Expected: the throwing frame should be recoverable somewhere — appended to
   the client error (`error.cause`, `error.remoteStack`, or a
   `Caused by (kind 'inventory' … ):` suffix) and/or `console.error`'d host-side.
   Suggested change: put `stack` in the `GdoCallResult` envelope and attach it
   as `cause` on the reconstructed error; chain it across hops so a two-hop
   failure reads like a causal chain. This is the single highest-leverage fix
   in the library.

3. **Error propagation semantics are completely undocumented.**
   Severity: major. Category: docs.
   Repro: search the README for "error", "throw", "stack".
   Observed: "Rules and limits" covers reserved names, billing, renames — but
   nothing says "errors are re-created client-side as plain `Error` with only
   `name` and `message`". I discovered the envelope by reading `host.ts`. For
   a library whose pitch includes cross-kind architectures, error semantics
   are load-bearing API surface and belong in the README next to
   "RPC covers methods only."
   Suggested change: a "Errors" section documenting exactly what survives a
   hop, with the `error.name` branching idiom as the blessed pattern until
   issue 1 is fixed.

4. **The blessed workaround (branch on `error.name`) is stringly-typed and unassisted.**
   Severity: minor. Category: API-shape.
   Repro: in `checkout()` I can only distinguish "out of stock" from, say, a
   storage failure by `error.name === "OutOfStockError"` — a string with no
   compile-time link to the class, silently broken by a rename of the error
   class (`Error.name` defaults to the runtime class name unless set manually;
   minifiers change it). The worker's HTTP handler does the same to choose 409
   vs 500.
   Suggested change: ship a tiny helper (`isKindError(error, OutOfStockError)`
   comparing names, or codes) plus a documented convention, even before full
   revival exists.

5. **A worker-visible artifact of the envelope: even *library* errors of nested calls arrive re-minted.**
   Severity: nit. Category: debugging.
   Observed: when the nested `inventory` call fails, the worker caller cannot
   tell whether `cart.checkout` itself threw or something it called did — the
   stack (issue 2) is identical either way and there is no hop metadata (no
   "thrown by kind 'inventory', instance 'inventory:t8-widget'"). While the
   *message* I wrote happens to carry the product id, that is my discipline,
   not the library's. Judging the cross-kind chain honestly: with my own
   highly descriptive messages it was debuggable; with terse messages
   (`throw new Error("insufficient")`) it would be a guessing game across
   three files.
   Suggested change: include `kind` (and instance name when known) in the
   envelope and prefix or attach it on the client error.

6. **`.one()` SQLite results + the stub's `Awaited` mapping compose fine — but sync methods silently become async, and nothing flags a forgotten `await` on state-changing calls.**
   Severity: nit. Category: types.
   Observed: `Inventory.stock()` is synchronous in the class, `Promise<number>`
   on the stub — correct and expected, but `cart.addItem(...)` (sync `void` in
   the class, `Promise<void>` on the stub) is easy to call without `await`
   from a worker and TS won't complain (`no-floating-promises` isn't on in the
   template tsconfig). Pure footgun-adjacent observation; a README nudge to
   enable that lint rule in consumers would be cheap.

## 4. Debugging experience

The build phase was smooth; the break phase was a tale of two layers.

Layer one, the library's own errors: excellent. Every failure the *host*
generates is prefixed, specific, and actionable, and I never had to guess
which of the three kind-resolution sources (storage, prefix, hint) was in
play because the messages name the expectation and the reality.

Layer two, *my* errors crossing hops: this is where I lost time. My first
compensation test failed in an earlier draft because `checkout()` originally
branched on `error instanceof OutOfStockError` — which is always `false`
after a hop, so the compensation path silently never ran... and the test
failure that revealed it was an assertion about *stock counts*, three steps
removed from the cause. The error object itself gave me nothing: the stack
pointed at `src/client.ts:142`, `constructor.name` said `Error`, and the
fields were gone. I found the truth by reading `host.ts`'s catch block, which
a user of the published npm package (shipped as `dist/`) would have a harder
time doing. The information that was missing, concretely: the throw site
(file/line in `worker.ts`), the hop path (cart → inventory), and my error's
own fields. Once I knew the envelope's shape I switched to `error.name`
matching and message-embedded context, and everything was debuggable again —
but the library trained me to stuff diagnostics into message strings, which
is 2010-era error hygiene.

One non-error note: storage persisting across tests in a file (see the
game-lobby report) initially made a stock assertion fail confusingly; unique
per-test product ids fixed it and arguably improved the tests.

## 5. Verdict

Would I adopt this over separate DO classes? **For this workload — yes, but I
would patch or wrap error handling first. 7/10.**

The shop is the architecture the library is *for*: many small single-purpose
instances (one per product, one per cart) under one namespace, talking to each
other. Separate DO classes would have cost me two namespaces plus a migration
per future kind, for zero DX gain — the union was strictly better on
structure, identity, and typing. But commerce code lives and dies on failure
handling, and today the library gives me perfect messages wrapped around
amnesiac errors: no class, no fields, no stack, no hop trail, and no
server-side log of the true throw site. Issues 1–2 are one focused change to
the `GdoCallResult` envelope and the client reconstruction; with those fixed
this is an 8.5–9 and an easy default recommendation. As shipped in v0.1.0,
I'd adopt it with a project convention ("all cross-kind errors carry their
context in the message, branch on `error.name`") and a fast follow on the
envelope.

## 6. Post-fix verification

Re-audited after the library update. All 10 tests pass (9 updated/original
plus 1 new transport-failure probe). Issue-by-issue:

1. **Custom error classes flattened to `{name, message}` — FIXED.**
   The envelope now carries own enumerable structured-cloneable fields, and
   they survive both hops. Verbatim capture after one hop
   (test → inventory):
   ```json
   {"productId":"cap-widget","requested":3,"available":1}
   ```
   The same fields arrive inside the cart DO's catch site (updated
   `probeReserveFailure` output: `"productIdField": "cap-widget",
   "availableField": 1`) and after two hops in the test. `instanceof` still
   does not survive — now explicitly by design and documented in the README's
   new "Error propagation" section ("match on `error.name` instead"), which
   is a defensible line to draw. My worker's 409 handler now returns
   structured `productId`/`available` straight off the error instead of
   parsing the message.

2. **Original stack destroyed and never logged — FIXED.**
   The two-hop stack is now a full causal chain, innermost first. Verbatim:
   ```text
   OutOfStockError: out of stock: product 'cap-widget' has 1 left, cannot reserve 4
       at Inventory.reserve (/workspace/examples/shop/worker.ts:65:13)
       at ShopDO.__gdoCall (/workspace/src/host.ts:277:44)
       at [remote call inventory.reserve() via generic-durable-objects]
       at reviveError (/workspace/src/client.ts:219:17)
       at Proxy.<anonymous> (/workspace/src/client.ts:206:15)
       at Cart.checkout (/workspace/examples/shop/worker.ts:134:9)
       at ShopDO.__gdoCall (/workspace/src/host.ts:277:35)
       at [remote call cart.checkout() via generic-durable-objects]
       at reviveError (/workspace/src/client.ts:219:17)
       at Proxy.<anonymous> (/workspace/src/client.ts:206:15)
       at /workspace/examples/shop/test/capture-scratch.test.ts:34:5
   ```
   vitest's caret now points at `Inventory.reserve examples/shop/worker.ts:65`
   — my code, the actual throw site — instead of the library's proxy. The
   marker lines make each hop legible. The intermediate hop (the cart's
   catch-release-rethrow), invisible before, now shows as `Cart.checkout
   worker.ts:134`. For the "never logged" half: RPC errors now ship the stack
   to the caller (the right fix), and errors in `alarm()`/`webSocket*`
   handlers — which have no caller — are `console.error`'d with kind and
   instance context before rethrowing. Residual nit: each hop injects four
   library frames (`__gdoCall`, `reviveError`, `Proxy.<anonymous>` ×2), so a
   deep chain gets noisy; trimming those would polish an already-good trace.

3. **Error semantics undocumented — FIXED.**
   The README now has an "Error propagation" section stating exactly what
   survives (name, message, stack with marker, cloneable fields) and what
   does not (prototype, non-cloneable fields), plus a "Serialization rules"
   section covering the transport-failure wrapping.

4. **Stringly-typed `error.name` branching — IMPROVED, not fixed.**
   Name matching remains the blessed pattern (documented as such), but the
   payload is no longer stringly: my worker reads `e.productId` /
   `e.available` off the error instead of regexing the message. Residual
   papercut: the revived fields are untyped — the worker needs
   `error as Error & Partial<OutOfStockError>` to touch them. A typed helper
   (`matchError(error, OutOfStockError)` narrowing by name) is still worth
   shipping.

5. **No hop metadata on nested failures — FIXED.**
   Each hop now identifies itself in the stack
   (`at [remote call inventory.reserve() via generic-durable-objects]`, then
   `cart.checkout()` for the outer hop), so "who threw, through whom" is
   answerable at a glance. Transport-level failures also gained context — new
   probe returning a non-serializable custom class, verbatim:
   > `generic-durable-objects: call to inventory.snapshot() failed: Could not serialize object of type "StockSnapshot". This type does not support serialization.`
   with the original `DataCloneError` attached as `cause`. One observation:
   the host side also emits an unhandled-rejection noise line
   (`Uncaught (in promise) DataCloneError: …`) because the success envelope's
   value fails to serialize outside `__gdoCall`'s try — harmless, arguably
   useful server-side evidence, but slightly untidy.

6. **Silent floating promises on sync-looking methods — UNCHANGED.**
   Still no README nudge toward `no-floating-promises`. Remains a nit.

Also adopted: the new `kinds()` accessor reads well from inside the DO —
`Cart.checkout` now uses `kinds(this.env.APP_DO).inventory` — and the README
documents this exact cart/inventory pattern. The compensation logic itself
needed no change (it deliberately catches every error, so it never depended
on the stringly matching).

**Updated score: 9/10** (was 7). Both key findings — the amnesiac errors and
the deleted stacks — are fixed the way I asked, verified from a user's seat:
my failing-checkout debugging session that previously dead-ended at
`src/client.ts:142` would now start at `Inventory.reserve worker.ts:65` with
the full cart→inventory chain visible, and the compensation code can carry
typed data end to end. What keeps the last point: revived fields arrive
untyped (cast required), the per-hop frame noise, and `instanceof` remaining
a documented trap rather than a helper-assisted pattern. I would adopt this
for production commerce coordination without the wrapper layer I previously
said I'd need.
