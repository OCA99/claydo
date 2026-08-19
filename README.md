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
to get `this.ctx` and `this.env`. (Typing tip for SQLite rows: the
`sql.exec<T>()` generic requires `T extends Record<string, SqlStorageValue>`,
so type rows with a dedicated query-row interface — or an inline shape as
below — rather than reusing a domain interface that has optional or
non-SQL fields.)

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

When the kind name is a union of several literals, the accessor's stub is a
union too, and TypeScript only lets you call methods that exist on every
member. Narrow the name (or pass a literal such as `"counter" as const`)
before you call kind-specific methods.

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
  with `get()` or `unique()` first. It is also the place kind mismatches
  surface: `kind(ns, "order").fromId(productStub.id)` fails with an error
  naming both kinds. (`get("same-name")` under two kinds is NOT a
  mismatch — the names map to two different instances by design.)
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
For errors your callers must branch on, attach a stable discriminator field
(for example `error.code = "RATE_LIMITED"`): fields survive the hop, and
matching on `code` is sturdier than matching on message text. Under strict
TypeScript the caught value is `unknown`, so narrow it with a real guard:

```ts
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
if (errorCode(error) === "RATE_LIMITED") { ... }
```

The library's own kind-mismatch error carries structured fields too:
`code: "CLAYDO_KIND_MISMATCH"` plus `expectedKind` and `actualKind`.

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

`resetStorage()` (like the `deleteAll()` it wraps) also drops every SQLite
table. The already-running instance stays in memory, so its constructor —
where `CREATE TABLE IF NOT EXISTS` usually lives — does not run again, and
the next query fails with `no such table`. Put schema setup in an idempotent
method and call it from both places:

```ts
#ensureSchema(): void {
  this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS items (...)`);
}

constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  this.#ensureSchema();
}

async destroy(): Promise<void> {
  await resetStorage(this.ctx);
  await this.ctx.storage.deleteAlarm();
  this.#ensureSchema(); // the instance keeps serving after the wipe
}
```

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
- The host runs the framework's startup hook automatically. PartyServer and
  the Agents SDK initialize themselves (`onStart`) from `fetch()` or their
  own routing helpers; claydo calls the same hook
  (`__unsafe_ensureInitialized`) when it constructs the kind, so RPC-first
  access works without a warm-up `fetch()`.
- `getServerByName()` is **not supported**: it addresses instances without
  the kind prefix and drives them through a `setName` RPC. The host rejects
  the call with an error that points you to the replacement:
  `kinds(env.APP_DO).game.get(name)` — it serves the same purpose.
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

### Cloudflare Agents SDK and Think

Agents SDK classes (`Agent` from `agents`, `Think` from `@cloudflare/think`)
are Durable Objects built on PartyServer, and they register as kinds the same
way. Everything above applies, plus:

- Add `"compatibility_flags": ["nodejs_compat"]` to wrangler — the Agents
  SDK requires it.
- Drive the agent through the claydo stub: RPC methods such as `runTurn()`
  work directly on a cold instance (the host runs the agent's startup hook
  first, so the session exists). `fetch()` through the stub reaches the
  agent's own router.
- A minimal Think kind, wrapper included:

```ts
import { Think } from "@cloudflare/think";

class Assistant extends Think {
  getModel() { return myModel(this.env); }
  // The typed stub keeps only the LAST overload of an overloaded method
  // (a TypeScript mapped-type limit), so runTurn's "wait" mode fails to
  // type-check remotely. The runtime accepts every mode — this wrapper is
  // a TypeScript shim, not a runtime requirement.
  ask(input: string) {
    return this.runTurn({ input, mode: "wait" });
  }
}

export class AppDO extends union({ assistant: Assistant, ...others }) {}
// kinds(env.APP_DO).assistant.get("alice").ask("hello")
```

- Do NOT copy the routing setup from the Think quickstart. Its
  `routeAgentRequest()` URLs (`/agents/<agent-class>/<name>`) fail against
  a claydo host with PartyServer's error `...does not match any server
  namespace. Did you forget to add a durable object binding to the class
  Assistant...` — adding that binding is exactly what claydo avoids, so do
  not follow that suggestion. Either route manually (parse
  `/agents/:agent/:name` and call
  `kinds(env.APP_DO).<kind>.get(name).fetch(request)`), or keep
  `routeAgentRequest()` and put your claydo binding plus a kind-prefixed
  room name in the URL: `/agents/app-do/assistant:alice` reaches the
  `assistant` kind instance `alice`. Client helpers such as `useAgent`
  follow the same URL contract.
- `getAgentByName()` is `getServerByName()` and fails the same way, with
  the same redirect to `kinds(ns).<kind>.get(name)`. Its parameter type
  also expects an `Agent` namespace, so the call only compiles against a
  claydo host with a cast (`getAgentByName(env.APP_DO as never, name)`) —
  another sign to use the kind helper instead.
- Inside the agent, `this.name` is the prefixed instance name
  (`assistant:alice`). Use `instanceName(this.ctx)` for the logical name.

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
- **Overloads collapse.** The typed stub maps each method to a single
  signature; TypeScript mapped types keep only the last overload. Wrap
  overloaded methods you call remotely in a non-overloaded method.
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

Tests run inside the Workers runtime with
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/).
Complete setup for your own app (with `@cloudflare/vitest-pool-workers@0.22`
and `vitest@4` — note that the older `defineWorkersConfig` import from
`@cloudflare/vitest-pool-workers/config` no longer exists; the current API
is a Vite plugin):

```ts
// vitest.config.ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
```

```ts
// test/env.d.ts — makes `env` from "cloudflare:test" carry your bindings
import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
```

```jsonc
// tsconfig.json — a complete, tested configuration
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "strict": true,
    "noEmit": true,
    // Workers type packages ship overlapping globals; without this,
    // `tsc` may report TS6200 identifier conflicts from node_modules.
    "skipLibCheck": true,
    "types": [
      "@cloudflare/workers-types",
      // The `/types` subpath declares the "cloudflare:test" module; the
      // bare package name only types the Vite plugin and leaves
      // `tsc --noEmit` failing with TS2307 on "cloudflare:test".
      "@cloudflare/vitest-pool-workers/types"
    ]
  },
  "include": ["src", "test"]
}
```

```ts
// test/app.test.ts
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { kinds } from "claydo";

it("increments", async () => {
  const counter = kinds(env.APP_DO).counter.get("t1");
  expect(await counter.increment()).toBe(1);
});
```

Tips that apply to your own tests:

- Every call through a stub is async, even when the kind method is
  synchronous. Always `await`; using an unawaited call as a value fails
  with `DataCloneError: Could not serialize object of type "RpcPromise"`.
- `runDurableObjectAlarm` and `runInDurableObject` from `cloudflare:test`
  expect a raw `DurableObjectStub`. Pass `stub.stub` (the escape hatch) or a
  raw `env.APP_DO.get(...)` stub. Schedule test alarms in the future: an
  already-due alarm may fire on its own before the helper runs, making the
  helper return `false` even though the alarm work happened.
- vitest's default reporter can swallow `console.log` output from Workers
  and tests. Run with `--reporter=verbose` when you need to see driver or
  kind logs.
- The claydo stub proxies your kind's methods only. Introspection such as
  `stub.storage` or `stub.getAlarm()` is not RPC-reachable — use
  `runInDurableObject(stub.stub, ...)` or add a helper method to the kind.
- `SELF.fetch()` from `cloudflare:test` drives your Worker's routes
  end-to-end, claydo helpers included.
- Isolated storage is per test **file**; tests within one file share DO
  state. Give each test its own instance-name prefix (`t1-room`,
  `t2-room`, ...) — reused names carry state between tests.
- Expected rejections from Durable Object methods (sealed instances, wrong
  secrets, and similar) may additionally print as `uncaught exception`
  lines in vitest-pool-workers output even when your test catches them.
  The tests still pass; the lines are harness noise.

For the library's own suites: `npm test` (library) and
`npm run test:examples` (the example apps under `examples/`).

The `examples/` folder contains eight complete applications (chat rooms with
rate limiting, collaborative documents, an alarm scheduler, instance
management, a Lunora-style live table, a token-bucket rate limiter, a game
lobby, and a shop with cross-kind checkout), each with tests and a DX audit
report.

## License

MIT
