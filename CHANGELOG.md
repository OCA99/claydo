# Changelog

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
- Alarms are supervisor-multiplexed with documented at-least-once delivery: entries are consumed only after the handler returns, failures retry (native retry first, a paced supervisor re-fire after), `getAlarm()` inside the handler reads `null`, and a schedule set during a failed delivery's retry window is preserved alongside the retry.
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
