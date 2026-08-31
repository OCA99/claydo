# Durable Object Facets — verification spike

Empirical verification of the open questions from the facets assessment,
run against `wrangler 4.127.1` / `miniflare 5.20260815.0` /
`workerd 1.20260815.1` / `@cloudflare/workers-types 5.20260831.1` /
`@cloudflare/vitest-pool-workers 0.22.0`. All probes run inside the
Workers runtime via vitest-pool-workers. 15/15 probes conclusive.

To reproduce: copy these four files into a fresh npm package
(`worker.ts` under `src/index.ts`, the test under `test/`), add
`"type": "module"`, install the dev dependencies above, `npx vitest run
--reporter=verbose`.

## Verdicts

| # | Question | Verdict |
| --- | --- | --- |
| 1 | Can statically-bundled classes back facets (no Worker Loader)? | **YES.** `ctx.facets.get(name, () => ({ class: this.ctx.exports.MyClass }))` works. The Worker Loader is only one way to obtain a `DurableObjectClass`; `ctx.exports` is another (undocumented on the facets page). |
| 2 | Does the class need its own wrangler migration entry? | **YES — but it does not matter (see #3).** An exported class with no migration entry appears in `ctx.exports` as a `LoopbackServiceStub`, and `facets.get` rejects it: `Incorrect type for the 'class' field on 'StartupOptions'`. A raw class constructor is rejected the same way. |
| 3 | Can ONE migrated class serve many differently-configured facets? | **YES — the design unlock.** `LoopbackDurableObjectClass` is callable: `ctx.exports.Host({ props: { kind: "chat" } })` returns a class handle whose instances see `ctx.props = { kind: "chat" }`. One namespace entry, any number of facets, per-facet configuration with zero storage markers. |
| 4 | Do alarms work inside facets? | **NO.** `facet ctx.storage.setAlarm()` throws `alarms are not yet implemented for SQLite-backed Durable Objects` (workerd `actor-sqlite.c++`). "Yet" suggests it is coming. The SUPERVISOR's alarm works normally and can relay into facets (verified), so alarm multiplexing in the supervisor is the workaround. |
| 5 | Do hibernating WebSockets work inside facets? | **YES.** `acceptWebSocket` in the facet + `webSocketMessage` delivery through a supervisor-forwarded upgrade both work. (True hibernation eviction/wake not exercised.) |
| 6 | Storage isolation? | **Complete, both directions.** The facet cannot read supervisor KV; the supervisor cannot see facet tables. |
| 7 | Facet identity? | Facet inherits the parent's `ctx.id` INCLUDING `id.name` by default. `FacetStartupOptions.id` accepts an arbitrary string, which becomes `ctx.id.toString()` (name: undefined). |
| 8 | Lifecycle? | `abort(name, reason)` invalidates existing stubs (they throw `reason`); re-`get` with a DIFFERENT class works and storage survives the swap (hot code-swap on live data). `delete(name)` wipes storage. |
| 9 | `clone(src, dst)`? | **Exists and works** (typed but absent from the docs page): copies SQL tables and KV to a new facet name. Directly relevant to staged imports with atomic cutover. |
| 10 | Nested facets? | **YES.** A facet can create its own sub-facets, and `ctx.exports` is visible inside facets. |
| 11 | Local dev / testing support? | **YES.** Everything above ran under vitest-pool-workers 0.22 with zero special configuration — no `worker_loaders` binding, no compatibility flag (`enable_ctx_exports` is default since 2025-11-17 and specifying it is a startup ERROR). |

## Not verifiable locally

- **Production availability and billing.** Local workerd having the API
  does not prove the production runtime enables it on every plan, nor how
  supervisor+facet duration is billed. Needs a one-off `wrangler deploy`
  probe on a real account.
- **True hibernation semantics** (eviction and wake of facet WebSockets,
  facet memory lifecycle vs the parent's).
- **Point-in-time recovery / storage limits** interaction with per-facet
  databases (the 10 GB SQLite limit — per facet or per parent object?).

## What this means for claydo

The claydo-v2 shape that these results support: one `Supervisor` host
class (one binding, one migration entry — the current pitch is intact),
each kind instance served by a facet backed by ONE generic props-configured
class. Per-kind storage becomes truly isolated (no reserved keys, no
`resetStorage` footgun, `deleteAll` safe), `wipeTarget` becomes
`facets.delete`, migration imports can stage into a scratch facet and cut
over atomically (or use `clone` for snapshots), and kind implementations
become hot-swappable via `abort` + re-`get`. The one real gap is facet
alarms: the supervisor must own the alarm and multiplex (verified
workable), with kinds' `setAlarm` proxied — machinery claydo already has
from the seal-guard work.
