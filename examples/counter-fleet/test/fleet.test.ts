import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isClaydoError, kind, kinds } from "../../../src/index";
import type { ClaydoError } from "../../../src/index";
import worker from "../worker";

const app = kinds(env.APP_DO);

// Durable Object storage persists across tests within this suite, so each
// test isolates itself with its own registry instance name.
function registry(testId: string) {
  return app.registry.get(testId);
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe("fleet management through the registry", () => {
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
    const direct = app.counter.fromId(record.id);
    expect(await direct.value()).toBe(3);
  });

  it("rejects duplicate labels; error name and own fields survive the hop", async () => {
    const r = registry("reg-dup");
    await r.createCounter("dup");
    const error = (await caught(r.createCounter("dup"))) as Error & {
      label?: string;
    };
    expect(error.message).toBe("registry: label 'dup' already exists");
    expect(error.name).toBe("DuplicateLabelError");
    expect(error.label).toBe("dup");
    // instanceof custom classes does not survive RPC; match on error.name.
    expect(error).toBeInstanceOf(Error);
    expect(isClaydoError(error)).toBe(false);
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

describe("counter lifecycle", () => {
  it("destroy() wipes the data but keeps the instance serving", async () => {
    const c = app.counter.get("destroy-named");
    await c.increment(3);
    await c.destroy();
    // deleteAll() cleared the data; destroy() re-created the schema, so
    // the same warm instance keeps answering from zero.
    expect(await c.value()).toBe(0);
    expect(await c.increment(2)).toBe(2);
  });

  it("a destroyed unique instance keeps its identity and kind", async () => {
    const c = app.counter.unique();
    const id = c.id.toString();
    await c.increment(5);
    await c.destroy();
    // The kind pin outlives deleteAll(), so fromId() (which never
    // initializes) still reaches the instance.
    const fresh = app.counter.fromId(id);
    expect(await fresh.value()).toBe(0);
    expect(await fresh.increment(2)).toBe(2);
  });
});

describe("stub identity", () => {
  it("get() stubs know their name; unique() and fromId() stubs do not", async () => {
    const named = app.counter.get("named");
    expect(named.name).toBe("named");
    expect(named.kind).toBe("counter");

    const unique = app.counter.unique();
    expect(unique.name).toBeUndefined();

    // Even when the target instance has a logical name, a fromId() stub
    // reports `name: undefined`: `name` reflects how the stub was created,
    // not the instance's identity.
    const roundTripped = app.counter.fromId(named.id);
    expect(roundTripped.name).toBeUndefined();
    expect(roundTripped.id.toString()).toBe(named.id.toString());
  });

  it("the id string is the only handle to a unique() instance", async () => {
    // unique() mints an id; the library offers no enumeration or lookup.
    // That is why the registry persists ids: recovery works if and only if
    // the caller kept the id.
    const stub = app.counter.unique();
    await stub.increment(41);
    const id = stub.id.toString();
    expect(await app.counter.fromId(id).value()).toBe(41);
  });
});

describe("kind routing errors", () => {
  it("rejects fromId() access under the wrong kind", async () => {
    const r = registry("reg-wrong-kind");
    const record = await r.createCounter("wrong-kind");

    // The counter instance is pinned to kind 'counter'. Reaching it
    // through the 'registry' accessor fails with a mismatch code.
    const wrong = app.registry.fromId(record.id);
    const error = (await caught(wrong.listCounters())) as ClaydoError & {
      actualKind?: string;
      expectedKind?: string;
    };
    expect(isClaydoError(error)).toBe(true);
    expect(error.code).toBe("CLAYDO_KIND_MISMATCH");
    expect(error.actualKind).toBe("counter");
    expect(error.expectedKind).toBe("registry");
  });

  it("fromId() never initializes an untouched id", async () => {
    // Mint a unique id under 'counter' but never touch the instance.
    const minted = app.counter.unique();
    const id = minted.id.toString();

    // fromId() cannot first-contact the instance, under any kind.
    for (const accessor of [app.tally, app.counter]) {
      const error = (await caught(accessor.fromId(id).value())) as ClaydoError;
      expect(error.code).toBe("CLAYDO_UNINITIALIZED");
      expect(error.message).toContain("fromId()");
    }

    // The original unique() stub may initialize: it pins 'counter', and
    // only then fromId() works — for the right kind.
    expect(await minted.increment(1)).toBe(1);
    expect(await app.counter.fromId(id).value()).toBe(1);
    const mismatch = (await caught(
      app.tally.fromId(id).value(),
    )) as ClaydoError;
    expect(mismatch.code).toBe("CLAYDO_KIND_MISMATCH");
  });

  it("reports a typo'd method name at runtime", async () => {
    const c = app.counter.get("typo");
    // Without `as any` TypeScript rejects this at compile time:
    //   error TS2339: Property 'incremnt' does not exist on type
    //   'KindStub<Counter>'.
    const error = (await caught((c as any).incremnt(1))) as ClaydoError;
    expect(error.code).toBe("CLAYDO_NO_METHOD");
    expect(error.message).toContain("incremnt");
    // Property access on a missing member returns an async function rather
    // than undefined, so `typeof` checks cannot detect the typo.
    expect(typeof (c as any).incremnt).toBe("function");
  });

  it("reports a plain property accessed as a method", async () => {
    const c = app.counter.get("prop");
    await c.increment(0);
    const error = (await caught((c as any).flavor())) as ClaydoError;
    expect(error.code).toBe("CLAYDO_NO_METHOD");
    expect(error.message).toContain("property, not a method");
  });

  it("keeps the same class under two kind names fully disjoint", async () => {
    const c = app.counter.get("shared-name");
    const t = app.tally.get("shared-name");
    expect(c.id.toString()).not.toBe(t.id.toString());
    await c.increment(7);
    expect(await t.value()).toBe(0); // no bleed-through
    await t.increment(1);
    expect(await c.value()).toBe(7);
    // Cross-kind access to each other's instances is rejected.
    const error = (await caught(
      app.tally.fromId(c.id).value(),
    )) as ClaydoError;
    expect(error.code).toBe("CLAYDO_KIND_MISMATCH");
  });

  it("surfaces a throwing kind constructor on every call", async () => {
    const b = app.broken.get("boom");
    const first = await caught(b.ping());
    expect(first.message).toContain(
      "BrokenKind constructor exploded: missing config",
    );
    // Every retry re-runs the constructor and fails the same way.
    const second = await caught(b.ping());
    expect(second.message).toContain(
      "BrokenKind constructor exploded: missing config",
    );
  });

  it("the kind() function works like the kinds() accessor", async () => {
    expect(await kind(env.APP_DO, "counter").get("via-kind").increment(2)).toBe(
      2,
    );
    expect(await app.counter.get("via-kind").value()).toBe(2);
  });
});
