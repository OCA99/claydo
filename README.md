# claydo

One Durable Object class, many use cases.

Register each use case as a **kind**. The library binds every Durable Object
instance to one fixed kind, forever. You deploy one DO class, one binding, and
one migration. You never touch migrations again when you add a kind.

```ts
import { union, kinds } from "claydo";

// One exported DO class hosts all kinds.
export class AppDO extends union({
  counter: Counter,
  chat: ChatRoom,
  billing: BillingAgent,
}) {}

// Typed access from your Worker.
const app = kinds(env.APP_DO);
await app.counter.get("user-42").increment(2);
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
  mismatched access with an error that names the instance and both kinds.

Because one instance always runs one kind, each kind owns the full SQLite
database, alarms, and WebSockets of its instances. Kinds do not share
instances, so they need no schema coordination and no cross-kind migrations.

## Install

```sh
npm install claydo
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
import { union } from "claydo";
import { Counter, ChatRoom } from "./kinds";

export class AppDO extends union({
  counter: Counter,
  chat: ChatRoom,
}) {}
```

`union()` validates the registry when the module loads: kind names must not
contain `:` or start with `__`, and kind classes must not define methods named
`id`, `name`, `kind`, or `stub` (the stub reserves those for metadata).
Validation failures throw at startup, so `wrangler deploy` and local dev
catch them before any traffic does.

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
import { kinds } from "claydo";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const app = kinds(env.APP_DO);

    // RPC, fully typed from the registry.
    const value = await app.counter.get("user-42").increment();

    // fetch() and WebSockets forward to the kind implementation.
    if (request.headers.get("Upgrade") === "websocket") {
      return app.chat.get("lobby").fetch(request);
    }

    return Response.json({ value });
  },
} satisfies ExportedHandler<Env>;
```

TypeScript infers the kind names and the method signatures from the registry.
`kinds(env.APP_DO)` only exposes registered kind names, and a typo produces a
"Did you mean ...?" diagnostic. The stub only exposes the methods of the kind
class, with awaited return types.

`kind(env.APP_DO, "counter")` is the two-argument equivalent. Use it when the
kind name is a runtime value; type that value with `KindNameOf`:

```ts
import { kind, type KindNameOf } from "claydo";

const name = pickKind() as KindNameOf<typeof env.APP_DO>;
const accessor = kind(env.APP_DO, name);
```

### Calling kinds from inside a kind

Kinds receive `env`, so cross-kind calls work the same inside a Durable
Object as in a Worker. This is the pattern for coordination between use
cases:

```ts
export class Cart extends DurableObject<Env> {
  async checkout(): Promise<void> {
    const inventory = kinds(this.env.APP_DO).inventory;
    await inventory.get(productId).reserve(qty);
  }
}
```

## How the host resolves the kind

The host resolves the kind of an instance from three sources, in this order:

1. **Storage.** The host persists the kind on first contact. Storage is the
   source of truth after that.
2. **The name prefix.** `app.counter.get("user-42")` names the instance
   `counter:user-42`. The host reads the prefix from `ctx.id.name`.
3. **The call hint.** The client helper sends the kind with every RPC call
   and with a `x-claydo-kind` header on every `fetch()`. The hint initializes
   instances reached through `get()` and `unique()`. `fromId()` sends the
   hint for validation only and **never initializes** an instance.

If a caller expects one kind and the instance has another, the call fails
with an error that names the instance and both kinds. An instance never
changes its kind.

## Identity

- `get(name)` maps to the Durable Object name `<kind>:<name>`. Equal names
  under different kinds map to different instances. Logical names may
  themselves contain `:`; only the first segment routes, and only when it
  matches a registered kind.
- `unique()` creates a `newUniqueId()` instance. The first call pins the
  kind. Store `stub.id.toString()` to reach it again with `fromId()`.
- `fromId(id)` reaches an existing instance. It never initializes: if the
  instance has no kind yet, calls fail and tell you to create the instance
  with `get()` or `unique()` first.
- `instanceName(this.ctx)` returns the logical name without the kind prefix,
  from inside a kind implementation. It is safe everywhere in a kind,
  including its constructor, because kinds construct lazily on first contact.
  It returns `undefined` for unique-ID instances.
- Do not mix helper access with raw namespace access. `getByName("room-1")`
  reaches a *different* instance than `app.chat.get("room-1")` (which maps to
  `chat:room-1`). If you fetch such an unprefixed instance, the host answers
  400 with an explanation of this exact mistake.

## Error propagation

When a kind method throws, the stub rethrows an `Error` to the caller with:

- the original `name` and `message`;
- the original **stack**, pointing into your kind code, followed by a marker
  line `at [remote call <kind>.<method>() via claydo]` and
  the local frames;
- all own enumerable fields of the error that survive structured clone
  (for example `error.code` or `error.productId`).

What does not survive: the prototype. `instanceof MyError` is `false` after
the hop — match on `error.name` instead. Non-cloneable fields are dropped.

Errors thrown in `alarm()` and `webSocket*` handlers have no caller to reach.
The host logs them with `console.error`, including the kind and the instance
identity, then rethrows so the runtime semantics (such as alarm retries) stay
intact.

## Serialization rules

RPC arguments and return values travel over Workers RPC:

- Structured-cloneable values work: plain objects, arrays, strings, numbers,
  `Map`, `Set`, `Date`, `ArrayBuffer`, typed arrays.
- Functions and `RpcTarget` instances become live RPC stubs (a Workers RPC
  feature — be deliberate about returning them).
- Custom class instances do **not** serialize. The call fails and the stub
  wraps the failure with context:
  `claydo: call to <kind>.<method>() failed: Could not serialize object ...`.
  Return plain objects instead.

## Storage lifecycle

`ctx.storage.deleteAll()` inside a kind also deletes the kind marker the
library persists. Named instances re-pin from the name prefix, but unique-ID
instances become kind-less husks. Use the provided helper instead:

```ts
import { resetStorage } from "claydo";

async destroy(): Promise<void> {
  await resetStorage(this.ctx); // deleteAll, but the kind stays pinned
  await this.ctx.storage.deleteAlarm();
}
```

Durable Object instances cannot be deleted, only emptied; any later access
revives them. Design "delete" flows as `resetStorage()` plus removal of the
id from wherever you track instances.

## Migrating existing bindings

`claydo/migrate` moves instances of an existing Durable Object binding into
a kind, so you can delete the old binding and reclaim its namespace slot.
There is no platform way to merge namespaces, so a migration is an
application-level data copy plus a routing cutover — gradual, per instance,
and reversible until cutover.

### 1. Wrap the old class and redeploy the old Worker

```ts
import { exportable } from "claydo/migrate";

class TallyImpl extends DurableObject<Env> { /* unchanged */ }
export class Tally extends exportable(TallyImpl) {}
```

Behavior is unchanged until an instance is sealed: the seal guards are
synchronous, so sync methods, internal self-calls, and framework helpers
keep working. Wrap the finished class: the seal guard covers the wrapped
class and its ancestors, not methods that later subclasses add.

### 2. Enable imports on the host

```ts
export class AppDO extends union(
  { tally: TallyImpl, ...otherKinds },
  { importable: ["tally"] },
) {}
```

The old class usually becomes the kind implementation as-is.

### 3. Move instances

Bulk, from a Worker, cron, or Workflow — you supply the instance names (from
your own registry; Cloudflare cannot list a namespace's names):

```ts
import { migrateInstance } from "claydo/migrate";

const summary = await migrateInstance({
  from: env.OLD_TALLY.getByName(name),
  to: kinds(env.APP_DO).tally,
  name,
});
```

Or lazily, on first touch, through the transitional router:

```ts
import { migrated } from "claydo/migrate";

const tally = migrated(env.OLD_TALLY, kinds(env.APP_DO).tally, {
  strategy: "lazy",
});
await tally.get("user-42").bump(); // migrates on first touch, then serves new
```

Router strategies: `lazy` migrates inline on first touch (fleets of small
instances); `manual` routes to the old instance until an external driver
migrates it; `drain` never migrates — old instances stay old until their
data expires, new names go to the kind.

The router notices migrations quickly: RPC calls and `fetch()` requests
(including WebSocket upgrades) that hit a freshly sealed old instance
re-resolve the route once and retry on the new side, concurrent lazy first
touches migrate exactly once, and when another worker is migrating an
instance the facade waits briefly for it to finish instead of failing.

### 4. Cut over and reclaim the slot

When the old namespace is empty, replace `migrated()` with the plain
accessor and ship a `deleted_classes` migration for the old class. That
deletes the old namespace — the goal of the exercise.

### What moves, and the guarantees

The copy includes SQLite tables (with rowids, rowid-alias primary keys in
any column position, indexes, triggers, views, and AUTOINCREMENT
sequences), KV entries (all user keys, including keys that start with
`__claydo` — only the library's three exact reserved keys stay behind), and
the pending alarm.

The order is strict and race-proof:

1. **Reserve the target.** From this moment, traffic to the target blocks
   with a clear "importing" error instead of initializing an empty
   instance. Exactly one driver owns the reservation; concurrent drivers
   fail fast without touching anything, and a crashed driver's reservation
   goes stale after ~30 seconds so the next run adopts and resumes it.
2. **Seal the old instance.** Writes freeze, `fetch()` answers 410 with the
   `x-claydo-sealed` header, open hibernatable WebSockets close with code
   1012 so clients reconnect, and alarms that come due are deferred — not
   lost — until the migration completes.
3. **Stream, verify, go live.** Chunks apply idempotently; totals are
   verified; the kind pins only after the final chunk.
4. **Record the move.** The old instance remembers where it moved and
   deletes its alarm. Only now does a re-run report `{ skipped: true }`.

On failure, the partial import is discarded and the old instance is
unsealed — unless another driver owns the migration, in which case nothing
is touched. Instances with no rows and no KV entries are skipped without
sealing anything (pass `allowEmpty: true` to migrate schema-only
instances), so stale registry entries cannot fabricate sealed husks.

Recovery: if traffic reached the target before the migration ever ran, the
target is "polluted" and the driver refuses with a both-live error. Wipe
the polluted target with `wipeTarget(accessor, name)` and re-run — it
clears storage, alarms, import state, and the in-memory kind pin.

Limits: `WITHOUT ROWID` and virtual tables are not supported (the export
fails with a clear error and rolls back). Live WebSocket connections do not
move — sealing closes them with code 1012 and reconnects land on the new
instance through the router. Old `newUniqueId()` instances cannot keep
their IDs; give them names (for example `migrated:<oldId>`). When the old
class lives in another Worker, set the same `secret` on `exportable()`, on
`union()`, and in the driver options.

## Third-party Durable Object libraries

A kind is any class with a `(ctx, env)` constructor. Durable Object framework
classes match this shape. Register them directly:

```ts
import { Server, type Connection, type WSMessage } from "partyserver";
import { union, kinds } from "claydo";

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
return kinds(env.APP_DO).game.get("match-1").fetch(request);
```

What works, and what to know (verified against `partyserver@0.5`):

- `Server` lifecycle hooks, broadcast, hibernation, and `onAlarm` work. The
  integration test suite runs a real `Server` as a kind.
- `this.name` inside the `Server` is the full instance name, including the
  kind prefix (for example `game:match-1`), because PartyServer reads
  `ctx.id.name`. Use `instanceName(this.ctx)` when you need the logical name.
- `getServerByName()` is **not supported**: it calls a `setName` RPC method
  on the stub, and the host does not expose arbitrary RPC methods. Use
  `kinds(env.APP_DO).game.get(name)` instead — it serves the same purpose.
- `routePartykitRequest()` routes by URL to a binding and passes the room
  name without a kind prefix, so it reaches unprefixed instances. Route
  manually instead:

```ts
// PartyKit-style URLs: /parties/:party/:room
const match = /^\/parties\/([^/]+)\/([^/]+)$/.exec(url.pathname);
if (match) {
  return kinds(env.APP_DO).game.get(match[2]).fetch(request);
}
```

## API

### `union(kinds)`

Creates the host Durable Object class. `kinds` maps kind names to classes.
Export the returned class and point your binding and migration at it.
Validates kind names and reserved method names at module load.

### `kinds(namespace)` / `kind(namespace, kindName)`

`kinds()` returns one typed accessor per registered kind, as properties.
`kind()` returns a single accessor; use it with runtime kind names typed as
`KindNameOf<typeof namespace>`. Each accessor:

| Method | Description |
| --- | --- |
| `get(name, options?)` | Stub for the named instance (`<kind>:<name>`). Initializes on first contact. |
| `unique(options?)` | Stub for a new `newUniqueId()` instance. Initializes on first call. |
| `fromId(id)` | Stub from a stored ID string or `DurableObjectId`. Never initializes. |
| `idFromName(name)` | The `DurableObjectId` that `get(name)` resolves to. |

Each stub exposes the public methods of the kind class as async functions,
plus:

| Property | Description |
| --- | --- |
| `fetch(input, init?)` | Sends a request to the kind's `fetch()` handler. |
| `id` | The `DurableObjectId`. |
| `name` | The logical name, when created with `get(name)`; otherwise `undefined`. |
| `kind` | The kind name. |
| `stub` | The raw `DurableObjectStub`, as an escape hatch (tests, `runDurableObjectAlarm`). |

### `instanceName(ctx)`

Returns the logical instance name without the `<kind>:` prefix, or
`undefined` for unique-ID instances. Safe anywhere in a kind, including the
constructor.

### `resetStorage(ctx)`

`deleteAll()` that re-pins the kind marker. Use it instead of a raw
`ctx.storage.deleteAll()` inside kinds.

### Forwarded handlers

The host forwards these handlers to the kind implementation when the kind
defines them: `fetch`, `alarm`, `webSocketMessage`, `webSocketClose`,
`webSocketError`. Hibernated WebSockets and alarms wake the correct kind,
because the host reads the persisted kind from storage.

## Rules and limits

- **RPC covers methods only.** The stub does not proxy property access.
  Calling a plain property through the stub fails with a message that names
  the property and its type; add a getter method instead.
- **Reserved names.** Kind classes must not define methods named `id`,
  `name`, `kind`, or `stub` — `union()` rejects them at startup. Getters with
  those names are fine. Method names starting with `__` are not callable
  through the stub.
- **One namespace, one billing and metrics bucket.** All kinds share the DO
  namespace, so per-kind analytics need your own labels.
- **Kind renames are breaking.** The kind name is part of the instance name
  and of the persisted state. Renamed kinds fail loudly for initialized
  instances (`unknown kind`) but `get(name)` under the new name reaches
  fresh, empty instances. Treat kind names as permanent identifiers.
- **Always go through the helpers.** Raw namespace access without the
  `<kind>:` prefix reaches different instances (see Identity).

## Testing

The repository tests run inside the Workers runtime with
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/):

```sh
npm install
npm test           # library test suite
npm run test:examples  # the 8 example apps under examples/
```

Tips that apply to your own tests:

- `runDurableObjectAlarm` and `runInDurableObject` from `cloudflare:test`
  expect a raw `DurableObjectStub`. Pass `stub.stub` (the escape hatch) or a
  raw `env.APP_DO.get(...)` stub.
- Isolated storage is per test **file**; tests within one file share DO
  state. Use distinct instance names per test.

The `examples/` folder contains eight complete applications (chat rooms with
rate limiting, collaborative documents, an alarm scheduler, instance
management, a Lunora-style live table, a token-bucket rate limiter, a game
lobby, and a shop with cross-kind checkout), each with tests and a DX audit
report.

## License

MIT
