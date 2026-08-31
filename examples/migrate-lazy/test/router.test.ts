/**
 * The transitional router in its intended, happy configuration: lazy bucket
 * migration and draining sessions, driven through the Worker's fetch routes
 * exactly as production traffic would arrive. Plus two DX probes that need
 * no failure injection: facade metadata, and the cost of oldRouteTtlMs: 0.
 */
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import { migrated } from "../../../src/migrate";
import worker, { type TakeResult } from "../worker";

const newBuckets = () => kind(env.LIMITER_DO, "bucket");
const newSessions = () => kind(env.LIMITER_DO, "session");
const oldBucket = (name: string) =>
  env.OLD_BUCKETS.get(env.OLD_BUCKETS.idFromName(name));
const oldSession = (name: string) =>
  env.OLD_SESSIONS.get(env.OLD_SESSIONS.idFromName(name));

async function call(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://example.com${path}`, init),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("lazy strategy through the worker routes", () => {
  it("migrates an old bucket on first touch, then serves the new instance", async () => {
    // The legacy fleet: an API key with a configured bucket and some usage.
    await oldBucket("api-alpha").configure(10, 0);
    await oldBucket("api-alpha").take(3); // 7 tokens left on the old side

    // First production request through the facade: migrates inline.
    const first = await call("/limit/api-alpha", { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ allowed: true, remaining: 6 });

    // The old instance is sealed; the data lives on the new side.
    expect((await oldBucket("api-alpha").__claydoSealed()).sealed).toBe(true);
    expect(await newBuckets().get("api-alpha").remaining()).toBe(6);

    // Subsequent requests serve the new instance.
    const second = await call("/limit/api-alpha", { method: "POST" });
    expect(await second.json()).toEqual({ allowed: true, remaining: 5 });
  });

  it("routes keys with no old data straight to the kind", async () => {
    const put = await call("/limit/fresh-key/config", {
      method: "PUT",
      body: JSON.stringify({ capacity: 5, refillPerSec: 0 }),
    });
    expect(put.status).toBe(200);
    const taken = await call("/limit/fresh-key", { method: "POST" });
    expect((await taken.json()) as TakeResult).toEqual({
      allowed: true,
      remaining: 4,
    });
    // Nothing ever touched the old namespace's instance.
    expect(await oldBucket("fresh-key").__claydoHasData()).toBe(false);
    expect(await newBuckets().get("fresh-key").remaining()).toBe(4);
  });

  it("answers 429 through the facade when the bucket is exhausted", async () => {
    await call("/limit/tight-key/config", {
      method: "PUT",
      body: JSON.stringify({ capacity: 2, refillPerSec: 0 }),
    });
    expect((await call("/limit/tight-key", { method: "POST" })).status).toBe(200);
    expect((await call("/limit/tight-key", { method: "POST" })).status).toBe(200);
    const denied = await call("/limit/tight-key", { method: "POST" });
    expect(denied.status).toBe(429);
    expect(((await denied.json()) as TakeResult).allowed).toBe(false);
  });
});

describe("drain strategy through the worker routes", () => {
  it("old sessions keep serving on the old binding; writes land there", async () => {
    await oldSession("sess-old").setValue("theme", "dark");

    const got = await call("/session/sess-old?key=theme");
    expect(await got.json()).toEqual({ value: "dark" });

    const wrote = await call("/session/sess-old", {
      method: "POST",
      body: JSON.stringify({ key: "lang", value: "de" }),
    });
    expect(wrote.status).toBe(200);

    // The write landed on the OLD instance, which is still unsealed.
    expect(await oldSession("sess-old").getValue("lang")).toBe("de");
    expect((await oldSession("sess-old").__claydoSealed()).sealed).toBe(false);
    // The new-side instance was never initialized (checked without
    // initializing it — a kind-accessor read would pin the kind!).
    // NOTE: __claydoKind() is NOT usable for this check: it answers
    // "session" for a completely untouched instance, because it falls back
    // to the name prefix. __claydoImportStatus().kind reads storage only.
    const rawNew = env.LIMITER_DO.get(newSessions().idFromName("sess-old"));
    expect(await rawNew.__claydoKind()).toBe("session"); // misleading!
    expect((await rawNew.__claydoImportStatus()).kind).toBeUndefined();
  });

  it("new session names go straight to the kind", async () => {
    const wrote = await call("/session/sess-new", {
      method: "POST",
      body: JSON.stringify({ key: "cart", value: "42" }),
    });
    expect(wrote.status).toBe(200);
    expect(await newSessions().get("sess-new").getValue("cart")).toBe("42");
    expect(await oldSession("sess-new").__claydoHasData()).toBe(false);
  });
});

describe("facade metadata while the route is old", () => {
  it("reports the NEW instance's id and stub even though traffic goes old", async () => {
    await oldBucket("meta-1").configure(10, 0);
    const facade = migrated(env.OLD_BUCKETS, newBuckets(), {
      strategy: "manual",
    });
    const stub = facade.get("meta-1");

    expect(stub.kind).toBe("bucket");
    expect(stub.name).toBe("meta-1");
    // .id is the NEW instance's id...
    expect(stub.id.toString()).toBe(
      newBuckets().idFromName("meta-1").toString(),
    );
    expect(stub.id.toString()).not.toBe(
      env.OLD_BUCKETS.idFromName("meta-1").toString(),
    );
    // ...and .stub is the raw NEW stub...
    expect(stub.stub.id.toString()).toBe(
      newBuckets().idFromName("meta-1").toString(),
    );
    // ...while every actual call serves the OLD instance.
    expect(await stub.remaining()).toBe(10);
    expect((await oldBucket("meta-1").__claydoSealed()).sealed).toBe(false);
    const rawNew = env.LIMITER_DO.get(newBuckets().idFromName("meta-1"));
    expect((await rawNew.__claydoImportStatus()).kind).toBeUndefined();
  });
});

describe("oldRouteTtlMs: 0 cost probe", () => {
  /**
   * Wraps the old namespace so every migration probe the facade sends to the
   * old side is counted. The facade only touches get/idFromName and the
   * listed stub methods.
   */
  function countingNamespace(
    ns: typeof env.OLD_BUCKETS,
    counts: Record<string, number>,
  ): typeof env.OLD_BUCKETS {
    const track =
      (stub: Record<string, (...a: unknown[]) => unknown>, method: string) =>
      (...args: unknown[]) => {
        counts[method] = (counts[method] ?? 0) + 1;
        return stub[method]!(...args);
      };
    return {
      idFromName: (name: string) => ns.idFromName(name),
      get: (id: DurableObjectId) => {
        const stub = ns.get(id) as unknown as Record<
          string,
          (...a: unknown[]) => unknown
        >;
        return {
          fetch: track(stub, "fetch"),
          __claydoSeal: track(stub, "__claydoSeal"),
          __claydoUnseal: track(stub, "__claydoUnseal"),
          __claydoSealed: track(stub, "__claydoSealed"),
          __claydoHasData: track(stub, "__claydoHasData"),
          __claydoExport: track(stub, "__claydoExport"),
          configure: track(stub, "configure"),
          take: track(stub, "take"),
          remaining: track(stub, "remaining"),
        };
      },
    } as unknown as typeof env.OLD_BUCKETS;
  }

  it("re-resolves the route on every call: 2 extra old-side RPCs each time", async () => {
    await oldBucket("ttl-zero").configure(10, 0);

    const counts: Record<string, number> = {};
    const facade = migrated(
      countingNamespace(env.OLD_BUCKETS, counts),
      newBuckets(),
      { strategy: "manual", oldRouteTtlMs: 0 },
    );

    const started = Date.now();
    const calls = 10;
    for (let i = 0; i < calls; i++) {
      expect(await facade.get("ttl-zero").remaining()).toBe(10);
      // Guarantee the 0ms TTL has visibly elapsed between calls.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const elapsedMs = Date.now() - started;
    console.log(
      `[probe ttl=0] ${calls} calls -> old-side RPC counts: ` +
        `${JSON.stringify(counts)} (plus ${counts["__claydoSealed"]} host ` +
        `__claydoImportStatus calls, per source), elapsed ~${elapsedMs}ms`,
    );

    // Every call re-resolved: one __claydoSealed + one __claydoHasData
    // (plus one host-side __claydoImportStatus) per user call.
    expect(counts["remaining"]).toBe(calls);
    expect(counts["__claydoSealed"]).toBeGreaterThanOrEqual(calls - 1);
    expect(counts["__claydoHasData"]).toBeGreaterThanOrEqual(calls - 1);

    // Contrast: the default TTL resolves once for the same traffic.
    const counts30: Record<string, number> = {};
    const cached = migrated(
      countingNamespace(env.OLD_BUCKETS, counts30),
      newBuckets(),
      { strategy: "manual" },
    );
    for (let i = 0; i < calls; i++) {
      expect(await cached.get("ttl-zero").remaining()).toBe(10);
    }
    console.log(
      `[probe ttl=default] ${calls} calls -> old-side RPC counts: ` +
        JSON.stringify(counts30),
    );
    expect(counts30["__claydoSealed"]).toBe(1);
    expect(counts30["__claydoHasData"]).toBe(1);
  });
});
