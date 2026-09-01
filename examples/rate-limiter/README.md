# Rate limiter

A token-bucket rate limiter built on claydo. One `bucket` kind holds the
config and token level for one API key in its own isolated SQLite database;
refill is computed on demand from elapsed time, so no alarms are needed. The
worker exposes an HTTP layer that answers `429` with a `Retry-After` header
when a bucket is exhausted.

## Kinds

- `bucket` — a token bucket with `configure(capacity, refillPerSec)`,
  `take(n)` (returns `allowed`, `remaining`, and `retryAfterMs`), `config()`,
  and `reset()`. Buckets that were never configured use defaults
  (capacity 10, 1 token/sec).

## HTTP routes

- `PUT /limits/:key/config` — set `{ capacity, refillPerSec }` for a key.
- `POST /limits/:key/take?n=1` — take tokens; `200` when allowed, `429` with
  `Retry-After` when not.

## Running the tests

From the repo root:

```sh
npx vitest run --config examples/rate-limiter/vitest.config.ts
```

Typecheck:

```sh
npx tsc --noEmit -p examples/rate-limiter/tsconfig.json
```
