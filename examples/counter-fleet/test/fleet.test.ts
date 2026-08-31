import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind, kinds, union, type KindNameOf } from "../../../src/index";
import worker from "../worker";

// GUARD: the repository's root vitest config has no `include` filter, so a
// bare `npx vitest run` from the repo root sweeps up this file and runs it
// against the WRONG worker (test/fixtures/worker.ts, which has no
// `registry` kind). Detect that and skip. Run this suite with:
//   npx vitest run --config examples/counter-fleet/vitest.config.ts
const hostedHere =
  (await env.APP_DO.get(
    env.APP_DO.idFromName("registry:__config-probe"),
  ).__claydoKind()) === "registry";
const describeHosted = describe.skipIf(!hostedHere);

// NOTE: one registry instance PER TEST. Durable Object storage persisted
// across tests within this suite (writes in one test were visible in the
// next), so tests isolate themselves by instance name instead — the same
// pattern the library's own test suite uses.
function registry(testId: string) {
  return kind(env.APP_DO, "registry").get(testId);
}

describeHosted("fleet management through the registry", () => {
  it("creates counters from inside the DO and tracks them", async () => {
    const r = registry("reg-create");
    const a = await r.createCounter("alpha");
    const b = await r.createCounter("beta");
    const c = await r.createCounter("gamma");

    // unique() ids are opaque 64-hex strings, disjoint per counter.
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);

    const listed = await r.listCounters();
    expect(listed.map((x) => x.label)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("increments counters via their stored unique ids", async () => {
    const r = registry("reg-increment");
    await r.createCounter("alpha");
    await r.createCounter("beta");

    expect(await r.incrementCounter("alpha", 2)).toBe(2);
    expect(await r.incrementCounter("alpha")).toBe(3);
    expect(await r.incrementCounter("beta", 10)).toBe(10);
    expect(await r.counterValue("alpha")).toBe(3);
    expect(await r.counterValue("beta")).toBe(10);

    // The Worker can also reach a counter directly with the stored id.
    const record = (await r.listCounters()).find((x) => x.label === "alpha")!;
    const direct = kind(env.APP_DO, "counter").fromId(record.id);
    expect(await direct.value()).toBe(3);
  });

  it("rejects duplicate labels; error name, fields, and remote stack survive the hop", async () => {
    const r = registry("reg-dup");
    await r.createCounter("dup");
    let caught: unknown;
    try {
      await r.createCounter("dup");
    } catch (error) {
      caught = error;
    }
    const error = caught as Error & { label?: string };
    expect(error.message).toBe("registry: label 'dup' already exists");
    // POST-FIX: the envelope now preserves the error name and own
    // enumerable fields...
    expect(error.name).toBe("DuplicateLabelError");
    expect(error.label).toBe("dup");
    // ...and the stack starts with the REMOTE frames (where the throw
    // happened, inside the kind), followed by the marker line, then local
    // frames. instanceof custom classes still does not survive (by design).
    expect(error.stack).toContain("at Registry.createCounter");
    expect(error.stack).toContain(
      "at [remote call registry.createCounter() via claydo]",
    );
    expect(error).toBeInstanceOf(Error);
  });

  it("deletes one counter; the others keep working", async () => {
    const r = registry("reg-delete");
    await r.createCounter("keep-1");
    await r.createCounter("victim");
    await r.createCounter("keep-2");
    await r.incrementCounter("keep-1", 5);
    await r.incrementCounter("victim", 99);

    expect(await r.deleteCounter("victim")).toBe(true);
    expect(await r.deleteCounter("victim")).toBe(false); // already gone

    expect((await r.listCounters()).map((x) => x.label)).toEqual([
      "keep-1",
      "keep-2",
    ]);
    expect(await r.counterValue("keep-1")).toBe(5);
    expect(await r.incrementCounter("keep-2")).toBe(1);
    // The label can be reused; it maps to a brand new instance.
    const again = await r.createCounter("victim");
    expect(await r.counterValue("victim")).toBe(0);
    expect(again.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serves the HTTP facade end to end", async () => {
    const ctx = createExecutionContext();
    const post = (path: string) =>
      worker.fetch(
        new Request(`https://example.com${path}`, { method: "POST" }),
        env,
        ctx,
      );
    await post("/counters/http-a");
    await post("/increment/http-a");
    await post("/increment/http-a");
    const list = await worker.fetch(
      new Request("https://example.com/counters"),
      env,
      ctx,
    );
    const records = (await list.json()) as Array<{ label: string }>;
    await waitOnExecutionContext(ctx);
    expect(records.map((r) => r.label)).toContain("http-a");
    expect(await registry("main").counterValue("http-a")).toBe(2);
  });
});

describeHosted("stub identity", () => {
  it("get() stubs know their name; unique() and fromId() stubs do not", async () => {
    const named = kind(env.APP_DO, "counter").get("named");
    expect(named.name).toBe("named");
    expect(named.kind).toBe("counter");

    const unique = kind(env.APP_DO, "counter").unique();
    expect(unique.name).toBeUndefined();

    // GOTCHA: even when the target instance HAS a logical name, a fromId()
    // stub reports `name: undefined`. `name` reflects how the stub was
    // created, not the instance's identity.
    const roundTripped = kind(env.APP_DO, "counter").fromId(named.id);
    expect(roundTripped.name).toBeUndefined();
    expect(roundTripped.id.toString()).toBe(named.id.toString());
  });

  it("a forgotten unique() id is unrecoverable through the library", async () => {
    // unique() mints an id; if the caller drops it, the library offers no
    // enumeration or lookup. This test documents that the ONLY handle is
    // the id string, which is why the registry persists it.
    const stub = kind(env.APP_DO, "counter").unique();
    await stub.increment(41);
    const id = stub.id.toString();
    // Recovery works if and only if you kept the id.
    expect(await kind(env.APP_DO, "counter").fromId(id).value()).toBe(41);
    // There is no list(), no idFromLabel, nothing else to find it again.
    const accessor = kind(env.APP_DO, "counter");
    expect(Object.keys(accessor).sort()).toEqual([
      "fromId",
      "get",
      "idFromName",
      "unique",
    ]);
  });
});

describeHosted("DX probes (adversarial)", () => {
  it("PROBE: fromId() with an id of the WRONG kind fails with the instance id in the message", async () => {
    const r = registry("reg-wrong-kind");
    const record = await r.createCounter("wrong-kind-probe");

    // The counter instance already has kind 'counter' pinned in storage.
    // Reaching it through the 'registry' accessor fails with the mismatch
    // error, which now names the instance (verbatim):
    const wrong = kind(env.APP_DO, "registry").fromId(record.id);
    await expect(wrong.listCounters()).rejects.toThrow(
      `claydo: instance '${record.id}' is kind 'counter', ` +
        "but the caller expected kind 'registry'.",
    );
  });

  it("PROBE (fixed): fromId() with a NEVER-USED id refuses to initialize — no silent pinning", async () => {
    // Mint a unique id under 'counter' but never touch the instance...
    const minted = kind(env.APP_DO, "counter").unique();
    const id = minted.id.toString();

    // ...then access it through the WRONG kind accessor. PRE-FIX this
    // silently pinned the instance as 'tally'. POST-FIX it fails (verbatim):
    const impostor = kind(env.APP_DO, "tally").fromId(id);
    await expect(impostor.increment(1)).rejects.toThrow(
      `claydo: instance '${id}' has no kind yet. ` +
        "It was accessed as kind 'tally' through fromId(), which never " +
        "initializes an instance. Create the instance first with " +
        "kind(ns, 'tally').get(name) or .unique(), then reach it by id.",
    );

    // fromId() is now uniformly non-initializing: even the CORRECT kind
    // cannot first-contact an instance through it.
    await expect(kind(env.APP_DO, "counter").fromId(id).value()).rejects.toThrow(
      `claydo: instance '${id}' has no kind yet. ` +
        "It was accessed as kind 'counter' through fromId(), which never " +
        "initializes an instance.",
    );
    // fetch() through a fromId() stub refuses too (400, not initialization).
    const fetched = await kind(env.APP_DO, "counter").fromId(id).fetch("https://do/");
    expect(fetched.status).toBe(400);
    expect(await fetched.text()).toMatch(/through fromId\(\), which never/);

    // The instance is still unpinned: the ORIGINAL unique() stub (which may
    // initialize) touches it, pins 'counter', and only then fromId() works.
    expect(await minted.increment(1)).toBe(1);
    expect(await kind(env.APP_DO, "counter").fromId(id).value()).toBe(1);
    await expect(kind(env.APP_DO, "tally").fromId(id).value()).rejects.toThrow(
      `claydo: instance '${id}' is kind 'counter', ` +
        "but the caller expected kind 'tally'.",
    );
  });

  it("PROBE: a typo'd method name fails at runtime with the library's error", async () => {
    const c = kind(env.APP_DO, "counter").get("typo");
    // Without `as any` TypeScript rejects this at compile time:
    //   error TS2339: Property 'incremnt' does not exist on type
    //   'KindStub<Counter>'.
    // (kept as a comment so the suite stays green; verified with tsc)
    await expect((c as any).incremnt(1)).rejects.toThrow(
      "claydo: kind 'counter' has no method 'incremnt'.",
    );
    // Property access on a missing member returns an async function rather
    // than undefined, so `typeof` checks lie:
    expect(typeof (c as any).incremnt).toBe("function");
  });

  it("PROBE: same class under two kind names creates disjoint fleets", async () => {
    const c = kind(env.APP_DO, "counter").get("shared-name");
    const t = kind(env.APP_DO, "tally").get("shared-name");
    expect(c.id.toString()).not.toBe(t.id.toString());
    await c.increment(7);
    expect(await t.value()).toBe(0); // no bleed-through
    await t.increment(1);
    expect(await c.value()).toBe(7);
    // Cross-kind access to each other's instances is rejected; for named
    // instances the error now shows the full prefixed name (verbatim):
    await expect(
      kind(env.APP_DO, "tally").fromId(c.id).value(),
    ).rejects.toThrow(
      "claydo: instance 'counter:shared-name' is kind " +
        "'counter', but the caller expected kind 'tally'.",
    );
  });

  it("PROBE: a throwing kind constructor surfaces on the first RPC", async () => {
    const b = kind(env.APP_DO, "broken").get("boom");
    await expect(b.ping()).rejects.toThrow(
      "BrokenKind constructor exploded: missing config",
    );
    // The kind was already pinned in storage BEFORE the constructor ran,
    // so the instance reports a kind it has never successfully been.
    const raw = env.APP_DO.get(env.APP_DO.idFromName("broken:boom"));
    expect(await raw.__claydoKind()).toBe("broken");
    // Every retry re-runs the constructor and fails the same way.
    await expect(b.ping()).rejects.toThrow(
      "BrokenKind constructor exploded: missing config",
    );
  });

  it("PROBE: destroy() [resetStorage] restarts a clean facet automatically", async () => {
    const c = kind(env.APP_DO, "counter").get("half-dead");
    await c.increment(3);
    await c.destroy();

    // User data is gone, supervisor identity remains, and the supervisor
    // restarted the facet so its constructor recreated the schema before
    // the next call.
    expect(await c.value()).toBe(0);
    expect(await c.increment(1)).toBe(1);
    expect(
      await kind(env.APP_DO, "counter").get("half-dead").value(),
    ).toBe(1);
  });

  it("PROBE: resetStorage() cannot erase a UNIQUE supervisor's kind", async () => {
    const c = kind(env.APP_DO, "counter").unique();
    const id = c.id.toString();
    await c.increment(5);
    await c.destroy(); // resetStorage()
    // Evict the instance so the next access is a true cold start.
    await expect(c.crash()).rejects.toThrow("counter crashed on purpose");

    // The isolated supervisor still knows this is a counter, even without a
    // name prefix. fromId() works because identity is separate from user data.
    const raw = env.APP_DO.get(env.APP_DO.idFromString(id));
    expect(await raw.__claydoKind()).toBe("counter");
    const fresh = kind(env.APP_DO, "counter").fromId(id);
    expect(await fresh.value()).toBe(0); // data gone, identity intact
    expect(await fresh.increment(2)).toBe(2);
  });

  it("PROBE: nuke() (deleteAll + ctx.abort) kills the in-flight call but heals named instances", async () => {
    const c = kind(env.APP_DO, "counter").get("phoenix");
    await c.increment(9);
    // The caller of nuke() always sees an error: abort() breaks the RPC.
    await expect(c.nuke()).rejects.toThrow("counter nuked");
    // The public stub addresses the stable supervisor, so only the in-flight
    // facet call dies. Its next call transparently creates a fresh facet.
    expect(await c.value()).toBe(0);
    // A separately-created stub sees the same empty replacement facet.
    const fresh = kind(env.APP_DO, "counter").get("phoenix");
    expect(await fresh.value()).toBe(0);
  });

  it("PROBE: nuke() on a UNIQUE facet keeps supervisor identity intact", async () => {
    const r = registry("reg-husk");
    const record = await r.createCounter("husk");
    const c = kind(env.APP_DO, "counter").fromId(record.id);
    await expect(c.nuke()).rejects.toThrow("counter nuked");

    // User data and kind identity live in separate databases. Even
    // deleteAll()+abort inside the facet cannot erase the supervisor pin.
    const raw = env.APP_DO.get(env.APP_DO.idFromString(record.id));
    expect(await raw.__claydoKind()).toBe("counter");
    expect(await kind(env.APP_DO, "counter").fromId(record.id).value()).toBe(0);
    expect(await r.counterValue("husk")).toBe(0);
    await r.deleteCounter("husk");
  });
});

describeHosted("post-fix library behaviors", () => {
  it("union() rejects kind classes that define reserved stub methods at class-creation time", () => {
    class Bad {
      name(): string {
        return "x";
      }
    }
    expect(() => union({ bad: Bad })).toThrow(
      "claydo: kind 'bad' (class Bad) defines a method " +
        "named 'name'. The stub reserves 'id', 'name', 'kind', 'stub' for " +
        "metadata, so this method would not be callable. Rename the method.",
    );
    // Getters remain fine.
    class Fine {
      get name(): string {
        return "x";
      }
    }
    expect(() => union({ fine: Fine })).not.toThrow();
  });

  it("calling a plain property through the stub explains itself", async () => {
    const c = kind(env.APP_DO, "counter").get("prop-probe");
    await c.increment(0); // initialize
    await expect((c as any).flavor()).rejects.toThrow(
      "claydo: 'flavor' on kind 'counter' is a property, " +
        "not a method (type: string). The stub only proxies methods; add a " +
        "getter method to read it.",
    );
  });

  it("unserializable return values fail with call context and a cause", async () => {
    const c = kind(env.APP_DO, "counter").get("weird-probe");
    let caught: Error | undefined;
    try {
      await c.weird();
    } catch (error) {
      caught = error as Error;
    }
    expect(caught!.message).toMatch(
      /^claydo: call to counter\.weird\(\) failed: /,
    );
    expect(caught!.cause).toBeDefined();
  });

  it("the kinds() accessor works like kind() with property access", async () => {
    const app = kinds(env.APP_DO);
    expect(await app.counter.get("via-kinds").increment(2)).toBe(2);
    expect(await app.counter.get("via-kinds").value()).toBe(2);
    // KindNameOf types runtime-built kind names.
    const dynamic: KindNameOf<typeof env.APP_DO> = "tally";
    expect(await kind(env.APP_DO, dynamic).get("via-kinds").value()).toBe(0);
  });
});
