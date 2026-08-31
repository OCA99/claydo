# DX Report: rate-limiter example (`generic-durable-objects`) — historical pre-facet audit

> **Facet-native update (2026-08-31).** This example now imports `DurableObject`
> from claydo and runs every kind in an isolated Durable Object facet. The
> supervisor keeps routing, kind identity, migration state, and virtualized
> alarms outside user storage. The tests were updated for the new lifecycle:
> `deleteAll()` cannot erase kind identity, post-delete writes and alarms are
> preserved, and stable public stubs survive facet eviction. The detailed report
> below is the original build-time audit; findings about shared host storage,
> `__claydo:kind` in user data, or kind-less husks are historical and are
> resolved by this refactor.

## 1. What I built

A classic token-bucket rate limiter with a single `bucket` kind: `take(n?)`
returns `{ allowed, remaining, retryAfterMs }`, refill is computed on demand
from elapsed time (no alarms), and `configure(capacity, refillPerSec)` stores
config in the instance's SQLite database. One bucket instance per API key
(`kind(ns, "bucket").get(apiKey)`), plus a Worker exposing
`PUT /limits/:key/config` and `POST /limits/:key/take` (429 + `Retry-After`
when denied). 11 tests, all passing (`test/rate-limiter.test.ts`).

## 2. What worked well

- **A single-kind union is zero-ceremony.** `union({ bucket: Bucket })` +
  one binding + one migration, and the example was running. This is the
  "start small, add kinds later" on-ramp working as intended — I could add a
  `quota` or `audit` kind tomorrow with no wrangler change.
- **Instance-per-key is the natural spelling.** `buckets().get(apiKey)` reads
  exactly like the mental model. Exhausting `key-a` had zero effect on
  `key-b`, sequence-free and coordination-free.
- **SQLite persistence is genuinely per-instance.** Config written through one
  stub was visible through a fresh stub of the same key, and
  `__gdoKind()` on a raw stub confirmed the kind pin persisted alongside it.
- **On-demand refill needs nothing from the library.** The kind is a plain
  class doing plain SQL; the library never got in the way of the domain
  logic. A test-only `advanceClock(ms)` method (persisted skew in KV storage)
  made refill tests deterministic with no real timers.
- **Concurrency did not over-issue.** 10 concurrent `take()` calls as the very
  first contact with a fresh instance issued exactly 10 tokens (default
  capacity) and the 11th was denied — the host's init-promise dedupe plus DO
  input gates held up.
- **Application errors keep their `name` and `message`.** A `RangeError`
  thrown inside `configure()` arrived client-side with `name === "RangeError"`
  and the exact message — enough for user-facing mapping.

## 3. Papercuts and issues

1. **Application errors lose their class, stack, and custom properties.**
   - Severity: minor (major if you rely on typed errors). Category:
     runtime-errors / debugging.
   - Repro: `Bucket.configure` throws
     `new RangeError("configure(capacity, refillPerSec) requires positive numbers, got (-1, 0)")`;
     catch it client-side.
   - Observed: the caught error has `name: "RangeError"` and the exact
     message, but `err instanceof RangeError` is **false** (it is a plain
     `Error` rebuilt by the client), the stack ends at the library's
     `makeStub` re-throw (no `Bucket.configure` frame anywhere), and any
     custom fields (e.g. `error.code`) would be dropped — the envelope only
     carries `{ name, message }`.
   - Desired: document this contract prominently; consider carrying
     `cause`-style structured data (own enumerable properties that survive
     structured clone) and, in dev, the server stack.

2. **`take()` before `configure()` forces the kind author to invent a policy — the library can't help.**
   - Severity: nit. Category: API-shape (really a docs opportunity).
   - Repro: call `take()` on a never-configured key.
   - Observed: nothing wrong — my kind falls back to defaults (capacity 10,
     1/sec) — but note the shape of the problem: with instance-per-key there
     is no "create" moment, so *every* kind needs a first-contact story. The
     README's counter example quietly has one (CREATE TABLE in the
     constructor) but never calls out the pattern.
   - Desired: a README paragraph on first-contact initialization patterns for
     kinds (constructor DDL, lazy defaults, explicit `configure`-or-throw).

3. **The `n = 1` default parameter is invisible on the stub type — pleasant surprise, worth advertising.**
   - Severity: nit (positive). Category: types / docs.
   - Observed: `take()` with no args typechecks and works, because
     `KindStub` preserves the original parameter tuple (`(n?: number)`).
     Optional/default parameters surviving the mapping is a nice property the
     README never mentions.

4. **Numbers as SQLite `REAL` round-trip fine through RPC, but the stub gives no help on return types vs. reality.**
   - Severity: nit. Category: types.
   - Observed: `config()` is typed to return
     `{ capacity: number; refillPerSec: number }` and does; but this is on the
     honor system — the stub trusts the kind's TS signature, while the actual
     value passed through SQLite (`REAL`) and structured clone. Fine here;
     just noting that the types assert, not verify (same as any RPC system).

(The heavier adversarial findings — serialization failures escaping the error
envelope, unprefixed raw-namespace access, opaque `kind()` type diagnostics,
reserved-name shadowing — reproduce independently of this example and are
written up with verbatim output in
`examples/live-table/DX-REPORT.md` §3, issues 1–5.)

## 4. Debugging experience

This example needed almost no debugging: typecheck and the full test suite
passed on the first run, which for a DO library is remarkable. The one thing I
verified defensively — whether ten concurrent first-contact `take()` calls
could race the host's kind initialization and double-issue tokens — just
worked, and I could confirm *why* by reading `host.ts` (a shared `#loading`
promise) in under a minute; the whole library being ~350 lines is itself a DX
feature. The error-propagation test was written as a probe because the README
says nothing about what happens to thrown errors; I had to read
`__gdoCall`'s envelope code to learn that only `name` and `message` survive.
That's the recurring theme: the *code* answers questions quickly, but the
*docs* leave the failure-mode questions (errors, serialization, raw access)
to source-diving.

## 5. Verdict

**8/10 — adopt.** For this shape of workload (thousands of tiny keyed
instances, one small kind, maybe more later) the library is strictly better
than a dedicated DO class: identical code inside the kind, less wrangler
ceremony, no migration when the next use case lands, and no progress toward
the 500-namespace cliff. The costs I actually felt were the undocumented
error-propagation contract (issue 1) and the shared metrics/billing bucket
(documented, inherent). Nothing in this example ever made me fight the
library.

## 6. Post-fix verification

Re-audited against the updated library. Suite grew from 11 to 12 tests, all
passing; `tsc` clean. Verdict per issue from §3:

1. **Errors lose class, stack, and custom properties — MOSTLY FIXED.**
   Re-proven from the user's perspective: `configure(-1, 0)` now throws a
   `RangeError` carrying an own field `code: "ERR_BAD_BUCKET_CONFIG"`, and the
   caught error client-side has `name === "RangeError"`, the exact message,
   **`code` intact**, and a stack that contains the remote frame
   `Bucket.configure` followed by the marker line
   `at [remote call bucket.configure() via generic-durable-objects]` and then
   local frames. Debugging an application error now points straight into the
   kind. `instanceof RangeError` is still `false` — now explicitly documented
   as by-design in the README's new "Error propagation" section ("match on
   `error.name`"), which is the resolution I asked for.

2. **First-contact initialization patterns undocumented — IMPROVED.** The
   README now states that kinds construct lazily on first contact (and that
   this makes `instanceName()` constructor-safe), and the new "Storage
   lifecycle" section addresses the related wipe-and-reinit story. There is
   still no dedicated "patterns for lazy defaults vs. configure-or-throw"
   paragraph, but the pieces a user needs are now on the page.

3. **Optional/default parameters survive the stub mapping — unchanged** (it
   was a positive observation; still true: `take()` with no args typechecks).

4. **Types assert, not verify, across the RPC boundary — unchanged** and
   inherent to any typed RPC; no action expected.

New surface exercised this round: the `resetStorage(ctx)` helper. A
`bucket.reset()` method that calls it wipes config back to defaults while the
instance verifiably stays kind `bucket` (`__gdoKind()` still returns
`"bucket"` after the `deleteAll`). One practical note for the docs: SQLite
tables die with `deleteAll()` too, so a kind's `reset()` must re-run its DDL —
the helper re-pins the kind, not the schema. Worth a sentence in the Storage
lifecycle section.

**Updated score: 9/10.** The one issue that actually cost this example
something (the error-propagation contract) is now both implemented well and
documented honestly. The remaining friction is generic to the platform
(structured-clone semantics, shared metrics bucket), not to this library.
