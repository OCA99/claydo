# live-table

A live, collaborative table built on claydo. Rooms are sharded across
Durable Object instances by name: each room's shard stores messages in its
own SQLite database and pushes a JSON delta to every WebSocket subscriber on
each insert. A worker in front exposes a small HTTP API over both kinds.

## Kinds

- `shard` — one instance per room. Owns a `messages` table, serves inserts
  and reads over RPC, and streams insert deltas to WebSocket subscribers.
- `session` — one instance per user. Tracks when the user last touched each
  room, in its own schema, fully isolated from the shards.

Both kinds live in one Durable Object class (`LiveTableDO`) with a single
binding; each instance runs its kind in an isolated storage facet.

## Running the tests

From the repository root:

```sh
npx vitest run --config examples/live-table/vitest.config.ts
npx tsc --noEmit -p examples/live-table/tsconfig.json
```
