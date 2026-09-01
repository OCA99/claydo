# game-lobby

A multi-kind game app on one claydo Durable Object class. A singleton `lobby`
creates matches and tracks them in its own SQLite database; each `game` is a
unique-ID instance running turn-based tic-tac-toe with a turn-timeout alarm
and WebSocket spectators. It shows cross-kind calls (the lobby creates games
with `kind(env.APP_DO, "game").unique()`), per-kind isolated storage, alarms,
and `fetch()` routing through the typed stub.

## Kinds

- `lobby` — one named instance (`get("main")`). Creates games and lists them
  from SQLite.
- `game` — one `unique()` instance per match. Enforces the rules, forfeits
  slow players via an alarm, and broadcasts events to spectator WebSockets.

## Running the tests

From the repo root:

```sh
npx vitest run --config examples/game-lobby/vitest.config.ts
```

Typecheck:

```sh
npx tsc --noEmit -p examples/game-lobby/tsconfig.json
```
