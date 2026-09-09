# counter-fleet

An actors-style fleet: a `registry` kind creates unique `counter` instances
from inside the Durable Object, stores their ids with labels in its own
SQLite database, and exposes create / list / increment / delete over RPC and
a small HTTP facade. It shows how one claydo union hosts several kinds with
isolated storage, how `unique()` ids are persisted and resolved with
`fromId()`, and how a best-effort `destroy()` works with `deleteAll()`.

## Kinds

- `registry` — a singleton by convention (`get("main")`); tracks counters by
  label and manages their lifecycle.
- `counter` — a per-instance counter with `increment` / `value` / `destroy`.
- `tally` — the same class as `counter` under a second kind name; its
  instances are fully disjoint.
- `broken` — a kind whose constructor throws, showing how constructor
  failures surface to callers.

## A note on the registry shape

The registry is a coordinator for lifecycle operations (create, list,
delete), not a router: high-volume operations like `increment` should go
from the Worker straight to the counter instance (`fromId()`), not through
the registry. Routing every request through one singleton instance
serializes the whole fleet on it.

## Running the tests

From the repository root:

```sh
npx vitest run --config examples/counter-fleet/vitest.config.ts
npx tsc --noEmit -p examples/counter-fleet/tsconfig.json
```
