# claydo

One Durable Object class, many use cases.

Cloudflare Workers accounts have a hard limit on Durable Object namespaces, and every new stateful use case normally costs one: a class, a binding, a migration, and a deploy. `claydo` multiplexes instead. You register each use case as a **kind** — a plain Durable Object class — and `union()` returns one class that hosts all of them. Each instance belongs to exactly one kind, and each kind implementation runs inside a [Durable Object facet](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/) with its own isolated SQLite database.

```ts
import { union, kinds } from "claydo";

export class AppDO extends union({ counter: Counter, chat: ChatRoom }) {}

// In your Worker:
const app = kinds(env.APP_DO);
await app.counter.get("user-42").increment();
const room = app.chat.get("lobby");
```

## Design

The class that `union()` returns plays one of two roles, selected once at construction. Addressed through the binding, it is a thin **supervisor**: it owns the instance's identity and its single native alarm. Started by that supervisor as a facet of the same instance, it is the kind's **facet host**: it runs the kind implementation against the facet's own database. One export covers both roles:

- **Identity is the address.** A named instance is `<kind>:<name>`, so the supervisor derives the kind from the name, which stays authoritative on every request. The kind is also pinned once at first contact — for named instances as a cache that lets ID-based access resolve after a nameless cold start, for unique-ID instances (which have no name to parse) as the identity itself. A pin is written once and is immutable.
- **Storage is the kind's alone.** The facet's SQLite database and key-value store belong to the kind. `claydo` keeps exactly one reserved key-value key (`__claydo`, the facet's identity) and touches nothing else. `deleteAll()`, schema, and key naming are all yours.
- **One consistency domain per instance.** The supervisor, its bookkeeping, and the kind's facet live inside one Durable Object. There is no cross-instance protocol anywhere in the library.
- **Errors are native.** Kind methods throw across the stub exactly like Workers RPC: `name`, `message`, `stack`, and own fields such as `code` survive. `claydo`'s own errors carry a stable `code` for programmatic handling.

## Requirements

- `compatibility_date` of `2026-08-01` or later (Durable Object facets).
- SQLite-backed Durable Object classes (`new_sqlite_classes`).
- `@cloudflare/workers-types` `>= 5.20260815.0` for development.

## Install

```sh
npm install claydo
```

## Quickstart

### 1. Write kinds as plain Durable Object classes

A kind is any class with a `(ctx, env)` constructor. Extending `DurableObject` from `cloudflare:workers` gives you the usual typed base; it is not required.

```ts
// kinds/counter.ts
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counter (n INTEGER NOT NULL)",
    );
  }

  async increment(by = 1): Promise<number> {
    // this.ctx.storage is this kind's own isolated database.
    /* ... */
  }
}
```

Kinds can use the full Durable Object surface: SQL and key-value storage, transactions, alarms, WebSockets with the hibernation API, and a `fetch()` handler.

### 2. Export one union class

```ts
// index.ts
import { union } from "claydo";
import { Counter } from "./kinds/counter";
import { ChatRoom } from "./kinds/chat";

export class AppDO extends union({
  counter: Counter,
  chat: ChatRoom,
}) {}
```

The supervisor starts each kind facet from this same top-level export, which it finds in `ctx.exports` by name. If your bundler renames classes, pass the export name explicitly: `union(kinds, { name: "AppDO" })`.

### 3. Configure one binding and one migration

```jsonc
// wrangler.jsonc
{
  "compatibility_date": "2026-08-01",
  "durable_objects": {
    "bindings": [{ "name": "APP_DO", "class_name": "AppDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["AppDO"] }]
}
```

### 4. Call kinds from your Worker

```ts
import { kinds } from "claydo";

const app = kinds(env.APP_DO);

// Named instances: full name is "<kind>:<name>".
await app.counter.get("user-42").increment(2);

// Unique instances: keep the id to find them again.
const created = app.counter.unique();
await created.increment();
const id = created.id.toString();
await app.counter.fromId(id).increment();

// fetch() routes to the kind's fetch() handler, including WebSocket upgrades.
const response = await app.chat.get("lobby").fetch(request);
```

Every accessor is fully typed from the registry: `app.counter.get(...)` returns a stub whose methods mirror `Counter`'s public prototype methods, with return values wrapped in promises.

### Calling kinds from inside a kind

Kinds call other kinds the same way the Worker does:

```ts
import { kind } from "claydo";

export class Checkout extends DurableObject<Env> {
  async placeOrder(items: Item[]) {
    const inventory = kind(this.env.APP_DO, "inventory").get("main");
    await inventory.reserve(items);
  }
}
```

## Identity

| Access | Instance | Kind resolution |
| --- | --- | --- |
| `app.counter.get("a")` | named `counter:a` | derived from the name, every request; pinned once as a cache for ID access |
| `app.counter.unique()` | unique ID | pinned in storage at first contact, immutable |
| `app.counter.fromId(id)` | existing instance | must already have a kind; never initializes |

- Equal names under different kinds are different instances: `counter:a` and `chat:a` share nothing.
- `instanceName(ctx)` inside a kind returns the logical name without the kind prefix (`"a"`, not `"counter:a"`), or `undefined` for unique-ID instances.
- Raw namespace access with an un-prefixed name (for example `env.APP_DO.getByName("a")`) reaches a different instance than `app.counter.get("a")` and fails with `CLAYDO_UNINITIALIZED` and guidance. Reach instances through `kind()`/`kinds()`.
- Accessing an instance under the wrong kind fails with `CLAYDO_KIND_MISMATCH`; the error carries `actualKind` and `expectedKind`.

## Storage

Each kind instance owns a private SQLite database and key-value store, isolated by the facet. No other kind can reach it, and `claydo` keeps exactly one reserved key in it: the key-value key `__claydo` holds the facet's identity, so the runtime can restart the facet in the right role even without its startup props. `deleteAll()` preserves it; treat the `__claydo` key name as reserved.

`ctx.storage.deleteAll()` inside a kind clears the kind's tables, views, and key-value data in one synchronous transaction. As with native Durable Objects, it does not delete a pending alarm, and it does not re-run your constructor: if the instance keeps serving, re-create your schema after the call.

```ts
async reset(): Promise<void> {
  await this.ctx.storage.deleteAll();
  this.#ensureSchema();
}
```

The supervisor keeps its own bookkeeping in the instance's root storage: the kind pin of unique-ID instances and one `alarm:<kind>` entry per scheduled alarm. This layout is versioned with the package; a change to it is a semver-major release.

## Alarms

Facets have no native alarm, so the supervisor multiplexes the instance's single native alarm across its kinds. Your kind uses the normal API:

```ts
await this.ctx.storage.setAlarm(Date.now() + 60_000);

async alarm(info?: AlarmInvocationInfo): Promise<void> {
  // info.scheduledTime is this kind's own scheduled time.
}
```

The contract:

- **At-least-once, not exactly-once.** The alarm entry is consumed only after your `alarm()` handler returns. A handler failure keeps the entry and retries through the platform's native retry (`info.isRetry`, `info.retryCount`). Write handlers to tolerate replay.
- **Native in-handler semantics.** Inside `alarm()`, `getAlarm()` reads `null` — the fired alarm is already consumed, exactly like a native Durable Object — so guard-based periodic chains (`if (await getAlarm() === null) setAlarm(next)`) work unchanged. Between the retries of a failed delivery, `getAlarm()` reads the pending time; a `setAlarm()` made while a delivery is in flight rides alongside it and becomes the scheduled alarm once the delivery consumes, so neither the retry nor the new schedule is ever lost. After the platform's native retries exhaust, the supervisor re-fires failed deliveries itself, with a growing backoff.
- **A kind that schedules alarms must define `alarm()`.** An alarm delivered to a kind without a handler is dropped with a loud log line.
- **Re-scheduling inside the handler works.** A handler that calls `setAlarm()` keeps the new time.
- **Scheduling is not atomic with your data writes.** Alarm state lives with the instance, outside the kind's database. The safe pattern is: persist the job first, then schedule; on fire, read the job and tolerate a replay. Alarm calls inside `storage.transaction()` or `storage.transactionSync()` throw `CLAYDO_ALARM_IN_TRANSACTION` instead of losing atomicity silently. The guard tracks open transactions, not call scope: an alarm call issued concurrently with an open transaction (for example through `Promise.all`) is also rejected — sequence the alarm call after the transaction commits.

## WebSockets

Kinds accept WebSockets with the hibernation API, and the handlers arrive on the kind:

```ts
async fetch(request: Request): Promise<Response> {
  const pair = new WebSocketPair();
  this.ctx.acceptWebSocket(pair[1]);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) { /* ... */ }
```

`stub.fetch()` forwards upgrade requests to the kind, so clients connect through the same address they use for everything else.

## Errors

Kind errors propagate natively. A custom error's `name`, `message`, `stack`, and own enumerable fields survive the stub. Built-in error classes such as `TypeError` and `RangeError` are reconstructed, so `instanceof` holds for them; custom classes are not, so match those on `error.name` or `error.code`.

`claydo`'s own errors have `name: "ClaydoError"` and a stable `code`. Match on the code — messages can change in any release.

| Code | Meaning |
| --- | --- |
| `CLAYDO_CONFIG` | The worker exports or the wrangler configuration are incomplete. |
| `CLAYDO_UNKNOWN_KIND` | The requested kind is not in the registry. |
| `CLAYDO_KIND_MISMATCH` | The instance belongs to one kind; the caller expected another. |
| `CLAYDO_UNINITIALIZED` | The instance has no kind yet, and the access cannot set one. |
| `CLAYDO_NO_METHOD` | The called name is not a callable method on the kind. |
| `CLAYDO_ALARM_IN_TRANSACTION` | An alarm operation ran inside a storage transaction. |

```ts
import { isClaydoError } from "claydo";

try {
  await app.counter.fromId(id).value();
} catch (error) {
  if (isClaydoError(error) && error.code === "CLAYDO_UNINITIALIZED") {
    // The id was never created through get() or unique().
  }
}
```

On the `fetch()` path, claydo's own errors become structured responses: the status is `404` when the instance cannot resolve a kind, `409` when the stub's expected kind does not match the instance, and `500` for configuration errors; the `x-claydo-code` response header carries the error code, and kinds without a `fetch()` handler answer `501`. The kind's own errors stay native rejections. The typed stub asserts its expected kind through one internal request header, which the supervisor removes before the request reaches the kind, so a wrong-kind `fetch()` fails like a wrong-kind RPC call instead of reaching the other kind.

Errors that carry non-cloneable own fields (an open socket, a function) still arrive: claydo drops only the fields that cannot cross the RPC hop and keeps the error's `name`, `message`, `stack`, and every cloneable field.

## Third-party Durable Object classes

Any class with a `(ctx, env)` constructor registers as a kind, including PartyServer servers and Agents SDK agents. `claydo` runs a class's `__unsafe_ensureInitialized()` hook at construction when it exists, which covers these frameworks' deferred setup.

Two caveats, both from the kind-prefixed naming scheme:

- `getServerByName()` / `getAgentByName()` address instances without a kind prefix, so they cannot reach a claydo instance. The supervisor answers their `setName()` call with a guiding error. Use `kind(ns, "<kind>").get(name)` instead.
- URL-based routers such as `routePartykitRequest()` work only when the room name in the URL is the full `<kind>:<name>` instance name.

## API

### `union(kinds, options?)`

Creates the union class from a registry of kind names to classes. Kind names must be non-empty, must not contain `:`, and must not start with `__`. Options: `name` overrides the class's export name; `onStart` runs once after a kind instance is constructed (the default runs the `__unsafe_ensureInitialized()` hook that PartyServer and the Agents SDK use). The class reserves the `__claydo` field of `ctx.props` for its role selection; all other configured props pass through to the kind.

### `kinds(namespace)` / `kind(namespace, kindName)`

Typed accessors over the union's binding. Each accessor has `get(name)`, `unique()`, `fromId(id)`, and `idFromName(name)`. Stubs expose the kind's prototype methods plus the metadata fields `id`, `name`, `kind`, `stub` (the raw Durable Object stub), and `fetch()`.

### `instanceName(ctx)`

The logical instance name without the kind prefix, usable inside kind implementations.

### `isClaydoError(error)` / `claydoError(code, message, extra?)`

Type guard for claydo errors, and the constructor claydo uses internally (exported for tests and tooling).

### Types

`KindRegistry`, `KindClass`, `KindStub<T>`, `KindAccessor<T>`, `KindNameOf<NS>`, `RegistryOf<NS>`, `SupervisorClass<R>`, `SupervisorInstance<R>`, `UnionOptions`, `ClaydoError`, `ClaydoErrorCode`, `KindHandlers`.

## Rules and limits

- **Prototype methods only.** The stub proxies public prototype methods. Plain properties, accessor properties, and function-valued instance fields are not callable; all fail with `CLAYDO_NO_METHOD` and an explanation. Note that arrow-function fields (`increment = async () => {...}`) type-check as stub methods — TypeScript cannot distinguish them from prototype methods — but fail at the first call. Declare methods as regular class methods.
- **Reserved names.** `ctx`, `env`, `id`, `name`, `kind`, `stub`, and `then` are stub metadata; `union()` rejects kinds that define them as methods. `fetch`, `alarm`, and the `webSocket*` handlers are lifecycle methods, invoked by the platform rather than the stub. Names starting with `__` are internal.
- **Arguments and return values** must serialize under Workers RPC rules (structured clone plus RPC extensions).
- **One kind per instance.** An instance's kind is fixed by its name or its first contact and never changes.
- **One storage layout per major version.** An instance holding data written by the claydo 0.1.x layout fails with `CLAYDO_CONFIG` instead of serving an empty instance.

## Testing

`claydo` unions work with `@cloudflare/vitest-pool-workers`:

```ts
// vitest.config.ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/**/*.test.ts"] },
});
```

Alarms fire naturally in the pool: schedule a near-future alarm and poll for its effect. `runInDurableObject()` on a raw stub opens the supervisor, not the kind's facet; read kind data through kind methods.

## Examples

The [`examples/`](./examples/CATALOG.md) directory contains complete, tested applications: counters and registries, WebSocket chat, alarm scheduling, rate limiting, collaborative state, and a multi-kind shop.

## License

MIT
