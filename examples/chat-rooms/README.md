# chat-rooms

WebSocket chat rooms built on claydo, with a PartyServer `Server` and a plain
`DurableObject` living side by side in one union class. Each room persists its
message history in its own SQLite facet and replays it to new connections, and
every message consults a per-user rate limiter through a cross-kind RPC call
made from inside the Durable Object.

## Kinds

- `chat` — a PartyServer `Server` (hibernation enabled). Handles WebSocket
  connections, presence (join/leave), broadcasting, and per-room message
  history in SQLite. Also answers plain RPC (`roomInfo()`, `history()`,
  `broadcast()`) through the typed stub.
- `limiter` — a plain `DurableObject` implementing a fixed-window rate limit,
  one instance per user id.

## Running

From the repository root:

```sh
npx vitest run --config examples/chat-rooms/vitest.config.ts
npx tsc --noEmit -p examples/chat-rooms/tsconfig.json
```
