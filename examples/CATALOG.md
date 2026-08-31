# Example catalog

This catalog maps Durable Object use cases to facet-native claydo examples.
Each kind imports claydo's `DurableObject` base and receives an isolated
SQLite database behind one supervisor class, binding, and migration.

## Sources

- **PartyServer** (`partyserver`): room-based routing, connection lifecycle
  hooks (`onConnect`, `onMessage`, `onClose`), broadcast, connection tags,
  hibernation, `onAlarm`.
- **Cloudflare Actors** (`@cloudflare/actors`): request handler entrypoints,
  lifecycle methods (`onInit`, `onAlarm`), persistent properties, RPC between
  actors, instance management (track, list, delete), multiple alarms, SQL
  migrations.
- **Lunora** (`@lunora/*`): sharded SQLite-backed state, live queries over a
  multiplexed WebSocket, mutations that push deltas to subscribers, session
  objects, scheduled jobs (`runAfter` / `runAt`).

## Examples

| Example | Kinds | Inspired by | Exercises |
| --- | --- | --- | --- |
| `chat-rooms` | `chat` (PartyServer `Server`), `limiter` | PartyServer | Third-party kind, broadcast, hibernation, cross-kind RPC (chat consults a per-user rate limiter) |
| `collab-doc` | `doc` | PartyServer, Lunora | WebSocket sync, SQLite op log, alarm-based snapshot compaction |
| `alarm-scheduler` | `scheduler` | Actors (multiple alarms) | One-alarm multiplexing over a SQLite job table, RPC, `runAfter`/`runAt` style API |
| `counter-fleet` | `registry`, `counter` | Actors (manage instances) | Multi-kind coordination, instance tracking, unique IDs, delete |
| `live-table` | `shard`, `session` | Lunora | Live queries over WebSocket, mutations push deltas, per-key sharding across instances of one kind |
| `rate-limiter` | `bucket` | Classic DO pattern | Token bucket, many small instances, strong consistency |
| `game-lobby` | `lobby`, `game` | PartyKit/game servers | Lobby creates unique game instances, turn state in SQLite, turn-timeout alarms |
| `shop` | `cart`, `inventory` | Classic multi-DO commerce | Cross-kind checkout, error propagation across kinds, compensation |
| `migrate-app` | `room`, `match`, `registry` | Binding consolidation | Manual routing cutover, PartyServer, unique-ID remapping |
| `migrate-fleet` | `session` | Fleet consolidation | Bulk preview/progress, secrets, crash resume |
| `migrate-gnarly` | `gnarly` | Data-fidelity audit | FTS5, generated columns, blobs, rowids, sequences |
| `migrate-lazy` | `bucket`, `session` | First-touch migration | Lazy/manual/drain routing, concurrent ownership |

Each example folder contains a worker, a wrangler config, tests that run in
workerd, and a `DX-REPORT.md` with an audit of the developer experience,
written while building the example. Each report has a facet-native update
that distinguishes current behavior from historical pre-facet findings.
