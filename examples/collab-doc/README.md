# collab-doc

A collaborative text document built on claydo. WebSocket clients send
insert/delete ops; the document appends them to a SQLite op log, applies
them to the text, and broadcasts them to the other clients. An alarm
periodically compacts the op log into a snapshot row, and RPC methods
(`getText`, `getStats`, `applyOp`) work alongside the WebSocket protocol.

## Kinds

- `doc` — one collaborative document per instance, with its own isolated
  SQLite database holding the op log and snapshot.

## Running the tests

From the repository root:

```sh
npx vitest run --config examples/collab-doc/vitest.config.ts
```

Typecheck:

```sh
npx tsc --noEmit -p examples/collab-doc/tsconfig.json
```
