# claydo

One Durable Object class, many isolated use cases.

Register each use case as a **kind**. Claydo runs every kind instance in its
own [Durable Object facet](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/):
an isolated SQLite database supervised by one exported Durable Object class.
You configure one binding and one migration, then add kinds in TypeScript.

```ts
import { DurableObject, kinds, union } from "claydo";

class Counter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS counter (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL
      )`,
    );
  }

  increment(): number {
    return this.ctx.storage.sql
      .exec<{ value: number }>(
        `INSERT INTO counter (id, value) VALUES (1, 1)
         ON CONFLICT(id) DO UPDATE SET value = value + 1
         RETURNING value`,
      )
      .one().value;
  }
}

export class AppDO extends union({ counter: Counter }) {}

const counter = kinds(env.APP_DO).counter.get("user-42");
await counter.increment();
```

## Why facets

Claydo's supervisor and each kind facet have separate databases:

- A kind owns its full SQL schema and KV keyspace. Library metadata never
  appears in user storage.
- `ctx.storage.deleteAll()` cannot erase kind identity. Claydo atomically
  clears only facet-local user storage; post-delete writes remain intact.
- Equal table names and KV keys in different kinds never collide.
- A kind can use SQL, KV, hibernating WebSockets, RPC, and alarms as it would
  in a regular Durable Object.
- Migration imports can fill or discard one target facet without touching the
  supervisor or another kind.

Facets currently do not implement native alarms. Claydo virtualizes the normal
`this.ctx.storage.setAlarm()`, `getAlarm()`, and `deleteAlarm()` API through the
supervisor's alarm. Kind code does not need a separate scheduler API.

## Install

```sh
npm install claydo
```

Version 0.2 is a greenfield facet architecture. It does not adopt data in
place from the experimental pre-facet 0.1 design; see `CHANGELOG.md`.

Use a current Workers compatibility date. Facets and `ctx.exports` must be
available in the runtime; the examples use `2026-08-01`.

## Quickstart

### 1. Write kinds

Import `DurableObject` from **claydo**, not `cloudflare:workers`. It extends the
platform class and supplies the supervisor-backed alarm API inside facets.

```ts
// src/kinds.ts
import { DurableObject, instanceName, kinds } from "claydo";

export class Counter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )`,
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

  logicalName(): string | undefined {
    return instanceName(this.ctx);
  }
}

export class Cart extends DurableObject<Env> {
  async checkout(productId: string, qty: number): Promise<void> {
    await kinds(this.env.APP_DO).inventory.get(productId).reserve(qty);
  }
}
```

Use `this.ctx`, especially for alarm calls. The raw constructor `ctx` is the
platform facet state; claydo installs its alarm adapter on `this.ctx` after
`super(ctx, env)`.

Ordinary classes with a `(ctx, env)` constructor also work. Platform
`DurableObject` and framework subclasses are adapted after construction, but
they cannot schedule an alarm from their constructor because native facet
alarms are not implemented. The claydo base class is the fully supported path.

### 2. Export one host

```ts
import { union } from "claydo";
import { Cart, Counter, Inventory } from "./kinds";

export class AppDO extends union({
  counter: Counter,
  cart: Cart,
  inventory: Inventory,
}) {}
```

The exported subclass name is how the supervisor finds its own facet class in
`ctx.exports`. If a build tool changes that name, set it explicitly:

```ts
export class AppDO extends union(kinds, { exportName: "AppDO" }) {}
```

Kind names are permanent identifiers. They must be non-empty, cannot contain
`:`, and cannot start with `__`.

### 3. Configure one binding and one migration

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "compatibility_date": "2026-08-01",
  "durable_objects": {
    "bindings": [{ "name": "APP_DO", "class_name": "AppDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["AppDO"] }]
}
```

Do not add kind classes to `new_sqlite_classes`. `AppDO` is both supervisor
and the props-configured facet runtime; all facets use that one class export.

### 4. Call kinds

```ts
import { kinds } from "claydo";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const app = kinds(env.APP_DO);
    const value = await app.counter.get("user-42").increment();

    if (request.headers.get("Upgrade") === "websocket") {
      return app.chat.get("lobby").fetch(request);
    }
    return Response.json({ value });
  },
} satisfies ExportedHandler<Env>;
```

Every stub call is async, including methods that are synchronous in the kind.

## Identity and accessors

`kinds(namespace)` returns one typed accessor per registered kind.
`kind(namespace, kindName)` is the dynamic-name form.

| Accessor | Result |
| --- | --- |
| `get(name)` | Named instance at parent DO name `<kind>:<name>`. |
| `unique()` | New unique parent DO. The first call pins its kind. |
| `fromId(id)` | Existing instance. Never initializes an untouched ID. |
| `idFromName(name)` | ID used by `get(name)`. |

Each kind stub exposes:

- typed public methods from the kind;
- `fetch(input, init?)`;
- `id`, `name`, and `kind`;
- `stub`, the raw **supervisor** Durable Object stub (for test helpers and
  migration internals). User SQL/KV is in the child facet, not on this stub.

`instanceName(this.ctx)` removes the `<kind>:` prefix. It returns `undefined`
for unique IDs.

Raw `getByName("room")` reaches a different parent than
`kinds(env.APP_DO).chat.get("room")` (`chat:room`). Use the helpers.

## Storage lifecycle

Inside a claydo kind:

```ts
async clear(): Promise<void> {
  await this.ctx.storage.deleteAll();
}
```

Claydo atomically drops the facet's user tables and KV entries and clears the
supervisor alarm. Like native `deleteAll()`, execution then continues in the
same object: writes and alarms created after the awaited call are preserved.
Kind identity remains in supervisor storage, including for unique-ID
instances.

`resetStorage(this.ctx)` is an equivalent convenience helper.

SQLite-backed kinds must recreate their schema after deletion:

```ts
async clear(): Promise<void> {
  await this.ctx.storage.deleteAll();
  this.ensureSchema();
  await this.ctx.storage.put("epoch", 2); // preserved
}
```

Calling `this.ctx.abort()` aborts only the facet. The in-flight call fails, but
the public claydo stub still points to the stable supervisor and reaches a new
facet on its next call.

## Alarms

Use the regular API:

```ts
async remindAt(timestamp: number): Promise<void> {
  await this.ctx.storage.setAlarm(timestamp);
}

async alarm(info?: AlarmInvocationInfo): Promise<void> {
  await this.ctx.storage.put("fired", info?.scheduledTime ?? Date.now());
}
```

Claydo stores the alarm in the supervisor. When it fires, the supervisor sends
a plain snapshot of `AlarmInvocationInfo` to the kind facet. A reschedule from
inside `alarm()` uses the same API.

This means one alarm per **kind instance**, as with regular Durable Objects.
Different logical instances already have different supervisors.

Alarm operations inside `storage.transaction()` are rejected with an
explanation: facet data and the supervisor alarm cannot commit in one storage
transaction. Commit facet data first, then call `this.ctx.storage.setAlarm()`;
the awaited call preserves that ordering.

## WebSockets

`fetch()` and hibernating WebSocket handlers are forwarded to the facet. The
facet owns accepted sockets, so hibernation, tags, broadcasts, and framework
helpers continue to work.

```ts
export class Echo extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    ws.send(message);
  }
}
```

## Errors and serialization

Thrown kind errors preserve name, message, stack, and structured-cloneable
enumerable fields. The local stack includes:

```text
at [remote call <kind>.<method>() via claydo]
```

Custom prototypes do not cross RPC (`instanceof MyError` is false). Branch on
a stable `error.code` field. Kind-mismatch errors use
`CLAYDO_KIND_MISMATCH` with `expectedKind` and `actualKind`.

Arguments and return values follow Workers RPC serialization. A value that
cannot cross the facet→supervisor or supervisor→caller boundary fails with
kind and method context.

Only prototype methods are proxied, matching Workers RPC. Add a getter
**method** for public properties; arrow/function class fields are not remote
methods (TypeScript cannot distinguish the two in the mapped stub type, so the
runtime gives a direct explanation). Method overloads collapse to their final
TypeScript overload on mapped stubs; expose a non-overloaded wrapper when
needed.

## Third-party Durable Object frameworks

PartyServer, Agents SDK, and Think classes can register directly:

```ts
import { Think } from "@cloudflare/think";
import { union } from "claydo";

class Assistant extends Think {
  getModel() {
    return myModel(this.env);
  }

  ask(input: string) {
    return this.runTurn({ input, mode: "wait" });
  }
}

export class AppDO extends union({ assistant: Assistant }) {}
```

Claydo calls `__unsafe_ensureInitialized()` before RPC-first access, so
PartyServer/Agents state is ready without a warm-up fetch.

Framework caveats:

- Their constructors receive native facet state. Constructor-time alarm calls
  need to move to `onStart()` or another method.
- `this.name` is the full `<kind>:<name>`; use `instanceName(this.ctx)` for
  the logical name.
- `getServerByName()` and `getAgentByName()` omit the kind prefix and are not
  supported. Use `kinds(env.APP_DO).<kind>.get(name)`.
- `routePartykitRequest()` and `routeAgentRequest()` also assume one binding
  per class. Route manually to the claydo accessor, or use a kind-prefixed
  room name.
- Think's overloaded `runTurn()` needs a non-overloaded RPC wrapper such as
  `ask()` above.

## Migrating existing bindings

`claydo/migrate` copies existing Durable Object instances into kind facets.
There is no platform API that merges namespaces.

### 1. Wrap the old class

```ts
import { exportable } from "claydo/migrate";

class TallyImpl extends DurableObject<Env> { /* existing implementation */ }
export class OldTally extends exportable(TallyImpl) {}
```

The old binding continues to serve until an instance is sealed.
`exportable()` guards every RPC method defined directly on `TallyImpl` before
it can touch storage, including methods that captured the raw constructor
storage reference. If the finished class exposes inherited business RPC
methods with such a captured reference, list them explicitly:

```ts
export class OldTally extends exportable(TallyImpl, {
  guardMethods: ["inheritedWrite"],
}) {}
```

Function-valued instance fields are not Workers RPC methods; expose remote
operations as prototype methods.

### 2. Enable target imports

```ts
export class AppDO extends union(
  { tally: TallyImpl, ...otherKinds },
  { importable: ["tally"] },
) {}
```

During transition, wrangler carries both classes:

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "OLD_TALLY", "class_name": "OldTally" },
      { "name": "APP_DO", "class_name": "AppDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["OldTally", "AppDO"] }
  ]
}
```

### 3. Preview and move

```ts
import { migrateInstance, previewInstance } from "claydo/migrate";

const from = env.OLD_TALLY.getByName(name);
const preview = await previewInstance({ from });

const summary = await migrateInstance({
  from,
  to: kinds(env.APP_DO).tally,
  name,
  onProgress: ({ phase, chunk, applied }) =>
    console.log({ phase, chunk, applied }),
});
```

Migration ordering:

1. Reserve the supervisor; target traffic gets 503.
2. Seal the old instance.
3. Stream SQL and KV chunks into an isolated staging facet. Every chunk and
   its sequence checkpoint commit in one facet-local SQLite transaction.
4. Rebuild indexes/FTS5, restore AUTOINCREMENT sequences, verify totals, then
   clone the staging facet into the live facet.
5. Atomically pin the target kind, remove import state, and transfer the alarm
   in one supervisor transaction.
6. Record `<kind>:<name>` on the old instance.

On failure, claydo deletes the staging/live target facets and unseals an old
instance that this run sealed. No user tables or partial rows can pollute
supervisor metadata. The old seal also carries an immutable target claim, so
one source cannot race or rerun into two live destinations.

The copy supports rowids, generated columns (recomputed), indexes, triggers,
views, AUTOINCREMENT sequences, ordinary and external-content FTS5, KV, and
alarms. It rejects `WITHOUT ROWID`, non-FTS virtual tables, contentless FTS5,
rowid-shadowing columns, rowids outside JavaScript's safe integer range, and
the exact staging key `__claydo:import-checkpoint` before sealing.

### Transitional routing

```ts
const tally = migrated(env.OLD_TALLY, kinds(env.APP_DO).tally, {
  strategy: "lazy", // or "manual" / "drain"
});
```

- `lazy`: migrate an old instance on first touch.
- `manual`: route old until an external driver moves it.
- `drain`: never migrate existing data; new names use the kind.
- `resolve(name)`: read-only `"old" | "new"` routing probe.

Create one facade per kind at module scope so its route cache survives requests.
Route all traffic through it during transition.

### Recovery

`wipeTarget(accessor, name)` deletes the target facet plus supervisor import
metadata and alarm. It cannot touch another kind's database.

A completed migration can be rolled back before cutover: stop traffic, unseal
the old instance, wipe the target, then restart Workers holding cached
`migrated()` facades. Reconcile any writes accepted on the new side first.

For fleets, keep your own authoritative instance-name registry. Cloudflare
cannot list names in a namespace.

## Testing

```ts
// vitest.config.ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } }),
  ],
});
```

```ts
// test/env.d.ts
import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
export {};
```

```jsonc
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": [
      "@cloudflare/workers-types/experimental",
      "@cloudflare/vitest-pool-workers/types"
    ]
  }
}
```

Useful helpers:

- `runDurableObjectAlarm(stub.stub)` runs the **supervisor** alarm, which
  forwards to the facet.
- `runInDurableObject(stub.stub, ...)` inspects supervisor metadata, not user
  SQL/KV. Add test-only methods to the kind when you need facet data.
- Isolated test storage is per test file. Use unique instance names.

Repository verification: `npm run test:all` type-checks the library and all
twelve examples, runs every Workers-runtime suite, and builds both package
entry points.

## API

### `claydo`

| Export | Purpose |
| --- | --- |
| `DurableObject` | Recommended kind base; adapts facet alarms. |
| `union(kinds, options?)` | Builds the supervisor/facet runtime class. |
| `kinds(namespace)` / `kind(namespace, name)` | Typed kind accessors. |
| `instanceName(ctx)` | Logical name without kind prefix. |
| `resetStorage(ctx)` | Clears facet user storage and alarm; supervisor identity remains. |

`union` options: `exportName`, `importable`, and migration `secret`.

### `claydo/migrate`

| Export | Purpose |
| --- | --- |
| `exportable(Base, options?)` | Adds seal/export support to an old class. |
| `previewInstance(options)` | Read-only row/KV/alarm/blocker report. |
| `migrateInstance(options)` | Moves one instance with optional progress. |
| `migrated(old, accessor, options)` | Transitional routing facade. |
| `wipeTarget(accessor, name, secret?)` | Deletes a polluted target facet. |

## Examples

`examples/` contains twelve tested applications:

- `alarm-scheduler`, `chat-rooms`, `collab-doc`, `counter-fleet`,
  `game-lobby`, `live-table`, `rate-limiter`, and `shop`;
- `migrate-app`, `migrate-fleet`, `migrate-gnarly`, and `migrate-lazy`.

Every kind example imports `DurableObject` from claydo and runs in facets.
Every folder includes Workers-runtime tests and a DX report.

## Current platform notes

- Facets are available in current workerd, Wrangler, and
  `@cloudflare/vitest-pool-workers`.
- Native facet alarms currently throw "alarms are not yet implemented";
  claydo's supervisor bridge is intentional and tested.
- Native facet `storage.deleteAll()` currently triggers a workerd internal
  assertion. Claydo replaces it with an atomic user-schema/KV teardown that
  preserves native post-delete write semantics.
- Migration finalization uses the typed `facets.clone(src, dst)` API to move a
  verified staging database into its live facet.
- `ctx.exports` is enabled by default on current compatibility dates. Do not
  add the obsolete `enable_ctx_exports` flag.

## License

MIT
