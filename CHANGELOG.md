# Changelog

## 0.3.0

Driven by a twelve-application developer-experience study: twelve agents at
varied capability levels built real applications against 0.2.0 with no
guidance, and their full session traces were analyzed for friction.

### Fixed

- A kind error delivered to a caller no longer prints per-hop
  `uncaught exception` log events: thrown kind errors cross claydo's
  internal facet-to-supervisor hop as values and are rethrown exactly
  once, with the original stack, name, fields, `cause`, and built-in
  class reconstruction preserved. Error-path tests now log at most one
  runtime event per delivered error — the same as a native Durable
  Object.
- The intermittent `An RPC result was not disposed properly` runtime
  warning under bulk calls is gone: every internal capability handle
  (facet stubs, alarm-bridge loopback stubs, configured class handles)
  is released deterministically after use, and the internal error
  envelope removed the rejected-RPC-promise path that leaked under load.

### Added

- `kind(...).has(name)` — pure existence read: true when the named
  instance was created, without initializing anything.
- `kind(...).getExisting(name)` — a stub that never initializes:
  calls on uncreated names fail with `CLAYDO_UNINITIALIZED`, and
  `fetch()` answers 404. Serves caller-supplied lookups without
  materializing storage. Requests without claydo headers (third-party
  routers such as `routePartykitRequest`) keep creating on first
  contact.
- `claydo/test` with `fireScheduledAlarm(stub)`: fires a pending kind
  alarm immediately inside a `@cloudflare/vitest-pool-workers` suite,
  replacing hand-written test-only trigger methods on production kinds.
- Documentation from the study: existence semantics, a worked custom
  error class, the sync-method/async-stub gotcha, cross-kind call
  atomicity and topology guidance, alarm-test margins, the `sql.exec`
  type-alias requirement, reserved-name scope, and expected error-path
  log lines. Example conventions unified (one vitest config style, one
  worker handler signature).

## 0.2.0

A ground-up rebuild on [Durable Object facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/). Each kind now runs in its own facet with an isolated SQLite database, and every library invariant lives inside one Durable Object. The `union()` API and the typed `kind()`/`kinds()` client keep their shape; most of the surrounding machinery changed.

### Breaking: storage layout

- 0.2.0 cannot serve instances written by 0.1.x. An instance holding 0.1.x data fails every access with `CLAYDO_CONFIG` instead of serving an empty instance. Keep the 0.1.x dependency for bindings with live data, or move the data before upgrading.
- Kind data lives in the kind's facet. Claydo keeps exactly one reserved key in the kind's key-value store (`__claydo`); writes to it are rejected.

### Breaking: removed API

- `resetStorage(ctx)` — call `ctx.storage.deleteAll()` inside the kind and re-create the schema; identity and pending alarms survive it.
- `KIND_HEADER`, `NO_INIT_HEADER`, `KIND_STORAGE_KEY` — transport and layout internals with no facet-era equivalent. The stub manages its own internal headers and removes them before requests reach the kind.
- `WireError`, `ClaydoCallResult` — the result envelope is gone; kind errors propagate natively over Workers RPC (name, message, stack, own fields, and `cause` survive; non-cloneable fields are dropped rather than failing the call; non-Error throwables arrive as plain Errors).
- `GenericDurableObjectClass` / `GenericDurableObjectInstance` — replaced by `SupervisorClass` / `SupervisorInstance`.
- `claydo/migrate` — cross-binding migration is out of scope for the core library.

### Breaking: behavior

- Claydo's own errors carry a stable `code` (`ClaydoErrorCode`); messages are not a contract. On the fetch path, claydo errors become structured responses with an `x-claydo-code` header.
- The reserved-name set for kind methods grew: `ctx`, `env`, and `then` join `id`, `name`, `kind`, and `stub`. `union()` rejects kinds that define these as prototype methods, at module evaluation.
- Alarms are supervisor-multiplexed with documented at-least-once delivery: entries are consumed only after the handler returns, failures retry (native retry first, a paced supervisor re-fire after), `getAlarm()` inside the handler reads `null`, and a schedule set during a failed delivery's retry window is preserved alongside the retry. An explicit `deleteAlarm()` cancels everything, including a pending retry of a failed delivery.
- `fromId()` never initializes an instance and fails with `CLAYDO_UNINITIALIZED` on untouched IDs.
- `union()` reserves the `__claydo` field of `ctx.props`; all other configured props pass through to the kind.

### Added

- `isClaydoError()` / `claydoError()` and the `ClaydoErrorCode` union.
- `instanceName(ctx)` for the logical name inside kinds.
- `UnionOptions.name` (export-name override) and `UnionOptions.onStart` (framework setup hook; the default covers PartyServer and the Agents SDK).
- WebSockets, alarms, and plain `(ctx, env)` classes work inside kinds with the normal platform APIs.

## 0.1.0

Initial release: kind routing inside one Durable Object class, with kind
data in the instance's root storage.
