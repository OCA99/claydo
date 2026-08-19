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

## Migrating existing bindings

`claydo/migrate` moves instances of an existing Durable Object binding into
a kind, so you can delete the old binding and reclaim its namespace slot.
There is no platform way to merge namespaces, so a migration is an
application-level data copy plus a routing cutover — gradual, per instance,
and reversible until cutover.

Working example: `examples/migrate-app` is a complete transitional app
(old bindings, host, driver endpoint, router, tests) — start there.

### 1. Wrap the old class and redeploy the old Worker

```ts
import { exportable } from "claydo/migrate";

class TallyImpl extends DurableObject<Env> { /* unchanged */ }
export class Tally extends exportable(TallyImpl) {}
```

Behavior is unchanged until an instance is sealed. The wrapper does not
rewrite the class's methods or prototype chain (framework base classes such
as the Agents SDK inspect both); instead it guards `ctx.storage`. While
sealed: every storage read and write fails with a "sealed" error, `fetch()`
answers 410 (even when the class never defined a `fetch()`), alarms defer,
and WebSocket handlers go quiet. The guards are synchronous, so sync
methods, internal self-calls, and framework helpers keep working while
unsealed. One caveat: storage references captured inside the wrapped
class's own constructor (for example `this.db = ctx.storage.sql`) reach the
real storage — the seal covers `this.ctx.storage` access after
construction, which is the normal pattern.

### 2. Enable imports on the host

```ts
export class AppDO extends union(
  { tally: TallyImpl, ...otherKinds },
  { importable: ["tally"] },
) {}
```

The old class usually becomes the kind implementation as-is.

During the transition, wrangler carries BOTH Durable Object classes, and
the Worker entry must export both:

```jsonc
// wrangler.jsonc (transitional)
{
  "durable_objects": {
    "bindings": [
      { "name": "OLD_TALLY", "class_name": "Tally" },
      { "name": "APP_DO", "class_name": "AppDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Tally", "AppDO"] }
  ]
}
```

```ts
// index.ts — wrangler resolves class_name against the entry's exports
export { Tally, AppDO };
export default { fetch: ... };
```

### 3. Move instances

Bulk, from a Worker, cron, or Workflow — you supply the instance names (from
your own registry; Cloudflare cannot list a namespace's names — a small SQL
or KV table of names, maintained where you create instances, is enough):

```ts
import { migrateInstance, previewInstance } from "claydo/migrate";

// Optional dry run: sizes, alarm, seal state, and blockers. Changes nothing.
const preview = await previewInstance({ from: env.OLD_TALLY.getByName(name) });
// preview: { sealed, movedTo?, hasData, kv, rows, alarm, blockers }

const summary = await migrateInstance({
  from: env.OLD_TALLY.getByName(name),
  to: kinds(env.APP_DO).tally,
  name,
  onProgress: (p) => console.log(`chunk ${p.chunk} (seq ${p.seq})`, p.applied),
});
// summary: { skipped, reason?, resumed, chunks, kv, rows, alarm }
```

A skipped run's `reason` is one of: `"already migrated"`, `"old instance
has no data (pass allowEmpty to migrate schema-only instances)"`, `"old
instance is empty and the target is live"`, or `"completed by a concurrent
driver"`.

A minimal admin driver, wired end to end:

```ts
if (url.pathname.startsWith("/admin/preview/")) {
  const name = url.pathname.split("/")[3]!;
  return Response.json(
    await previewInstance({ from: env.OLD_TALLY.getByName(name) }),
  );
}
if (url.pathname.startsWith("/admin/migrate/")) {
  const name = url.pathname.split("/")[3]!;
  const summary = await migrateInstance({
    from: env.OLD_TALLY.getByName(name),
    to: kinds(env.APP_DO).tally,
    name,
    onProgress: (p) => console.log(`[migrate ${name}] chunk ${p.chunk}`, p.applied),
  });
  return Response.json(summary);
}
```

The importer replays data as-is; it does not validate that the destination
kind's class understands the imported schema. Registering the old class as
the kind (as above) guarantees compatibility. Mapping data into a different
kind is your responsibility.

Or lazily, on first touch, through the transitional router:

```ts
import { migrated, type MigratedAccessor } from "claydo/migrate";

let tally: MigratedAccessor<TallyImpl> | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Create the facade ONCE per isolate: its route cache lives on the
    // object, so a facade built per request caches nothing.
    tally ??= migrated(env.OLD_TALLY, kinds(env.APP_DO).tally, {
      strategy: "lazy",
    });
    await tally.get("user-42").bump(); // migrates on first touch, serves new
    // ...
  },
};
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

Route decisions cache per facade: "new" decisions are final, "old"
decisions expire after `oldRouteTtlMs` (default 30000 ms) so external
migrations are noticed. Each cache miss costs a few extra RPC round trips,
so avoid very low TTL values on hot paths. Requests that reach a target
mid-import receive 503 with a `Retry-After` header.

What the facade does and does not give you:

- It exposes `get(name)` and `resolve(name)` only. `unique()` and
  `fromId()` have no migration story (old `newUniqueId()` instances cannot
  keep their IDs across namespaces — give them names, for example
  `migrated:<oldId>`), and `idFromName()` would leak the new side's ID
  while the old side may still be authoritative.
- The stubs' `id` and `kind` metadata always describe the NEW side, even
  while the old instance still serves the traffic. For observability
  during the window, ask `await facade.resolve(name)` — it returns
  `"new"` or `"old"`, is read-only under EVERY strategy (a `resolve()`
  sweep over your fleet registry never migrates anything, unlike `get()`
  under `lazy`), and does not touch the route cache.
- Migrating several old bindings at once? Create one facade per kind pair
  (`migrated()` maps exactly one old namespace to one kind) and keep each
  in its own module-scope singleton.
- Route ALL traffic for migrating names through the facade. One forgotten
  route, debug script, or cross-kind call that touches the plain accessor
  mid-migration initializes the target and the driver refuses with:
  `claydo: both the old instance '<name>' and the new instance
  '<kind>:<name>' are live. Refusing to migrate. ...` — recover with
  `wipeTarget()` as the message says, then re-run.

### 4. Cut over and reclaim the slot

When the old namespace is empty, replace `migrated()` with the plain
accessor and ship a `deleted_classes` migration for the old class. That
deletes the old namespace — the goal of the exercise.

### What moves, and the guarantees

The copy includes SQLite tables (with rowids, rowid-alias primary keys in
any column position, indexes, triggers, views, and AUTOINCREMENT
sequences), FTS5 full-text tables (self-contained ones copy row by row;
external-content ones are recreated and rebuilt on the target after their
content table arrives), KV entries (all user keys, including keys that
start with `__claydo` — only the library's three exact reserved keys stay
behind), and the pending alarm. Generated columns (`STORED` and `VIRTUAL`)
are excluded from the copy and recompute on the target. FTS5 shadow tables
are never copied; the index rebuilds from the real data (a rebuilt index
can be more compact than the original — compare the real tables, not the
shadows, when verifying byte-level fidelity). PartyServer-based classes
overwrite their own stored instance name (`__ps_name`) with the prefixed
name on first contact after the move; everything else copies verbatim.

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
instances), so stale registry entries cannot fabricate sealed husks. One
exception: classes whose constructor writes rows on first contact —
Agents SDK classes write a `cf_agents_state` row — are never "empty" once
probed, so this skip cannot protect them; keep the name registry
authoritative for such classes (see the framework section).

Recovery: if traffic reached the target before the migration ever ran, the
target is "polluted" and the driver refuses with a both-live error. Wipe
the polluted target with `wipeTarget(accessor, name)` and re-run — it
clears storage, alarms, import state, and the in-memory kind pin.

Limits (each fails pre-flight with a clear error, before anything is
sealed; `previewInstance` reports them under `blockers`):

- `WITHOUT ROWID` tables.
- Virtual tables other than FTS5, and contentless FTS5 (`content=''`).
- Tables with a column named `rowid`, `_rowid_`, `oid`, or `__rowid__`
  (they shadow the rowid the exporter pages by).

Live WebSocket connections do not move — sealing closes them with code
1012 and reason `claydo: instance migrating; reconnect`; clients should
watch for that close and re-issue the same request through the router,
which serves the new side. Old `newUniqueId()` instances cannot keep their
IDs; give them names (for example `migrated:<oldId>`).

Operational notes:

- If a driver crashes between the final chunk and the move marker, the old
  instance stays sealed with its alarm deferring every 60 seconds (with a
  `console.warn`) until any re-run of `migrateInstance` records the
  marker — re-runs are always safe, so retry after crashes.
- Methods that touch no storage still answer on a sealed instance (the
  seal freezes the data, not the event loop); the router's retry logic
  keys off storage access and `fetch()`. Beware storage-free heartbeats:
  a `ping()` that never reads storage keeps answering from a sealed old
  instance until the route TTL expires. Make keepalives read something,
  or accept up to `oldRouteTtlMs` of routing lag for them.
- Expect some benign exception noise in logs during the sealed window: a
  request that raced the seal fails once before the router retries it on
  the new side, and framework background bookkeeping (the Agents SDK's
  alarm scheduler) logs sealed-storage errors until cutover. These do not
  indicate data loss; the migration outcome is what the
  `MigrationSummary` says.

### Secrets across Workers

When the old class lives in another Worker, the same secret must be set in
three places — on the wrapper, on the host, and in every driver call. The
wrapper and the host take the secret at module load, before any request
`env` exists — import the module-scope `env` from `cloudflare:workers`:

```ts
import { env } from "cloudflare:workers";

// Old Worker
export class Tally extends exportable(TallyImpl, {
  secret: env.MIGRATION_SECRET,
}) {}

// New Worker
export class AppDO extends union(
  { tally: TallyImpl },
  { importable: ["tally"], secret: env.MIGRATION_SECRET },
) {}

// Driver (and migrated() options): the fetch-handler env works here too.
await migrateInstance({ from, to, name, secret: env.MIGRATION_SECRET });
```

A mismatch fails with a message that names the side that rejected
(`exportable() wrapper` or `union() options`).

### Migrating framework classes (Agents SDK, Think, PartyServer)

`exportable()` wraps framework classes too — it does not touch the
prototype chain their internals inspect, and constructors that call their
own methods work. Framework-specific notes:

- The host initializes framework kinds on first contact (see the
  third-party section), so migrated agents answer RPC immediately — no
  warm-up `fetch()` needed. The OLD binding has no such helper: RPC-first
  access to a cold Agents SDK instance fails inside the framework
  (`Cannot read properties of undefined (reading 'appendMessage')`)
  because `onStart` only runs from `fetch()`. Seed and spot-check old
  instances through `fetch()`, or add a warm-up fetch before old-side RPC.
  The migration driver itself is unaffected.
- Think creates a self-contained FTS5 conversation-search table; it
  migrates with searchability intact.
- Framework constructors write bookkeeping rows on first contact (the
  Agents SDK writes `cf_agents_state`), which has two consequences. The
  empty-instance skip never applies — every probed instance has data — so
  a stale registry name migrates a husk instead of being skipped. And
  `previewInstance`, though it writes nothing itself, constructs the
  instance it probes, so a preview sweep materializes previously
  nonexistent names. Keep the name registry authoritative about which
  instances really exist.
- The Agents SDK's `getAgentByName()` and `routeAgentRequest()` need the
  same workarounds after migration as for any kind (see the third-party
  section).

### API: `claydo/migrate`

| Export | Purpose |
| --- | --- |
| `exportable(Base, { secret? })` | Wraps the old class with seal + export support. |
| `previewInstance({ from, secret? })` | Dry run: sizes, alarm, seal state, blockers. Writes nothing — but contacting an instance constructs it, and framework constructors write their own rows. |
| `migrateInstance({ from, to, name, secret?, allowEmpty?, maxRowsPerChunk?, maxBytesPerChunk?, onProgress? })` | Moves one instance; returns a `MigrationSummary`. |
| `migrated(oldNamespace, accessor, { strategy, secret?, oldRouteTtlMs? })` | Transitional router facade: `get(name)` routes (and under `lazy`, migrates); `resolve(name)` is a read-only probe under every strategy. |
| `wipeTarget(accessor, name, secret?)` | Destructive recovery for polluted targets. |

`union(kinds, options)` accepts `{ importable: true | string[] }` to allow
imports and `{ secret }` for cross-Worker auth.

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

The `examples/` folder contains twelve complete applications: eight kind
apps (chat rooms with rate limiting, collaborative documents, an alarm
scheduler, instance management, a Lunora-style live table, a token-bucket
rate limiter, a game lobby, and a shop with cross-kind checkout) and four
migration apps (`migrate-app`, `migrate-fleet`, `migrate-lazy`,
`migrate-gnarly`), each with tests and a DX audit report.

## License

MIT
