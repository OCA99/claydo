# generic-durable-objects

One Durable Object class, many use cases.

Register each use case as a **kind**. The library binds every Durable Object
instance to one fixed kind, forever. You deploy one DO class, one binding, and
one migration. You never touch migrations again when you add a kind.

```ts
import { union, kind } from "generic-durable-objects";

// One exported DO class hosts all kinds.
export class AppDO extends union({
  counter: Counter,
  chat: ChatRoom,
  billing: BillingAgent,
}) {}

// Typed access from your Worker.
const counter = kind(env.APP_DO, "counter").get("user-42");
await counter.increment(2);
```

## Why

Cloudflare recommends one DO class per use case. Each class needs a binding
and a migration. An account has a limit of 500 Durable Object namespaces.
Teams with many services and many use cases reach this limit.

This library inverts the pattern. One DO class is the **host**. Your use cases
are plain classes. The host loads the correct class for each instance at
runtime. This is safe because the kind of an instance never changes:

- Instance names carry the kind as a prefix: `counter:user-42`.
- The host persists the kind in the instance storage on first contact.
- A different kind can never attach to the same instance. The host rejects
  mismatched access with an error.

Because one instance always runs one kind, each kind owns the full SQLite
database, alarms, and WebSockets of its instances. Kinds do not share
instances, so they need no schema coordination and no cross-kind migrations.

## Install

```sh
npm install generic-durable-objects
```

## Quickstart

### 1. Write kinds as plain Durable Object classes

A kind is any class with a `(ctx, env)` constructor. Extend `DurableObject`
to get `this.ctx` and `this.env`:

```ts
// src/kinds.ts
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
    );
  }

  increment(by = 1): number {
    return this.ctx.storage.sql
      .exec<{ value: number }>(
        `INSERT INTO counters (name, value) VALUES ('default', ?)
         ON CONFLICT(name) DO UPDATE SET value = value + excluded.value
         RETURNING value`,
        by,
      )
      .one().value;
  }
}

export class ChatRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    for (const socket of this.ctx.getWebSockets()) socket.send(message);
  }
}
```

### 2. Export one host class

```ts
// src/index.ts
import { union } from "generic-durable-objects";
import { Counter, ChatRoom } from "./kinds";

export class AppDO extends union({
  counter: Counter,
  chat: ChatRoom,
}) {}
```

### 3. Configure one binding and one migration

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "APP_DO", "class_name": "AppDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["AppDO"] }]
}
```

This is the only migration you will ever write. New kinds are code changes,
not migrations.

### 4. Call kinds from your Worker

```ts
import { kind } from "generic-durable-objects";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // RPC, fully typed from the registry.
    const value = await kind(env.APP_DO, "counter").get("user-42").increment();

    // fetch() and WebSockets forward to the kind implementation.
    const room = kind(env.APP_DO, "chat").get("lobby");
    if (request.headers.get("Upgrade") === "websocket") {
      return room.fetch(request);
    }

    return Response.json({ value });
  },
} satisfies ExportedHandler<Env>;
```

TypeScript infers the kind names and the method signatures from the registry.
`kind(env.APP_DO, "counter")` only accepts registered kind names. The stub
only exposes the methods of `Counter`, with awaited return types.

## How the host resolves the kind

The host resolves the kind of an instance from three sources, in this order:

1. **Storage.** The host persists the kind on first contact. Storage is the
   source of truth after that.
2. **The name prefix.** `kind(ns, "counter").get("user-42")` names the
   instance `counter:user-42`. The host reads the prefix from `ctx.id.name`.
3. **The call hint.** The client helper sends the kind with every RPC call
   and with a `x-gdo-kind` header on every `fetch()`. This initializes
   instances that have no readable name, such as `newUniqueId()` instances.

If a caller expects one kind and the instance has another, the call fails
with a clear error. An instance never changes its kind.

## Identity

- `get(name)` maps to the Durable Object name `<kind>:<name>`. Equal names
  under different kinds map to different instances.
- `unique()` creates a `newUniqueId()` instance. Store `stub.id.toString()`
  to reach it again with `fromId()`.
- `instanceName(this.ctx)` returns the logical name without the kind prefix,
  from inside a kind implementation.

## Third-party Durable Object libraries

A kind is any class with a `(ctx, env)` constructor. Durable Object framework
classes match this shape. Register them directly:

```ts
import { Server, type Connection, type WSMessage } from "partyserver";
import { union, kind } from "generic-durable-objects";

class GameRoom extends Server<Env> {
  onMessage(connection: Connection, message: WSMessage): void {
    this.broadcast(message);
  }
}

export class AppDO extends union({
  counter: Counter,
  game: GameRoom, // PartyServer, injected as a kind
}) {}

// In the Worker:
const room = kind(env.APP_DO, "game").get("match-1");
return room.fetch(request); // upgrade requests reach Server.fetch()
```

PartyServer reads its server name from `ctx.id.name`, so `this.name` inside
the `Server` is the full name, for example `game:match-1`.

The integration test suite runs a real PartyServer `Server` as a kind. See
`test/fixtures/worker.ts`.

## API

### `union(kinds)`

Creates the host Durable Object class. `kinds` maps kind names to classes.
Kind names must not contain `:` and must not start with `__`. Export the
returned class and point your binding and migration at it.

### `kind(namespace, kindName)`

Returns a typed accessor for one kind:

| Method | Description |
| --- | --- |
| `get(name, options?)` | Stub for the named instance (`<kind>:<name>`). |
| `unique(options?)` | Stub for a new `newUniqueId()` instance. |
| `fromId(id)` | Stub from a stored ID string or `DurableObjectId`. |
| `idFromName(name)` | The `DurableObjectId` that `get(name)` resolves to. |

Each stub exposes the public methods of the kind class as async functions,
plus:

| Property | Description |
| --- | --- |
| `fetch(input, init?)` | Sends a request to the kind's `fetch()` handler. |
| `id` | The `DurableObjectId`. |
| `name` | The logical name, when created with `get(name)`. |
| `kind` | The kind name. |
| `stub` | The raw `DurableObjectStub`, as an escape hatch. |

### `instanceName(ctx)`

Returns the logical instance name without the `<kind>:` prefix. Returns
`undefined` for unique-ID instances. Do not call it in the constructor;
`ctx.id.name` is not available there.

### Forwarded handlers

The host forwards these handlers to the kind implementation when the kind
defines them: `fetch`, `alarm`, `webSocketMessage`, `webSocketClose`,
`webSocketError`. Hibernated WebSockets wake the correct kind, because the
host reads the persisted kind from storage.

## Rules and limits

- **RPC covers methods only.** The stub does not proxy property access. Add a
  getter method when you need a value.
- **These method names are reserved on stubs:** `fetch`, `id`, `name`,
  `kind`, `stub`, and the lifecycle handlers. Names that start with `__` are
  reserved too.
- **One namespace, one billing and metrics bucket.** All kinds share the DO
  namespace, so per-kind analytics need your own labels.
- **Kind renames are breaking.** The kind name is part of the instance name
  and of the persisted state. Treat kind names as permanent identifiers.
- **Do not register the same instance name across raw and helper access.**
  Always go through `kind()` so the hint and the prefix stay consistent.

## Testing

The repository tests run inside the Workers runtime with
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/):

```sh
npm install
npm test
```

## License

MIT
