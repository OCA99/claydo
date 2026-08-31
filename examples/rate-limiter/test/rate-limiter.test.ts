import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import worker, { type TakeResult } from "../worker";

const buckets = () => kind(env.APP_DO, "bucket");

describe("token bucket: exhaustion", () => {
  it("allows until the bucket is empty, then denies with retryAfterMs", async () => {
    const bucket = buckets().get("key-exhaust");
    await bucket.configure(3, 1);

    expect(await bucket.take()).toEqual({
      allowed: true,
      remaining: 2,
      retryAfterMs: 0,
    });
    expect((await bucket.take()).remaining).toBe(1);
    expect((await bucket.take()).remaining).toBe(0);

    const denied = await bucket.take();
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it("supports weighted takes and denies when n exceeds the level", async () => {
    const bucket = buckets().get("key-weighted");
    await bucket.configure(10, 1);
    expect((await bucket.take(7)).remaining).toBe(3);
    const denied = await bucket.take(5);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(1000);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(2000);
  });
});

describe("token bucket: refill over time", () => {
  it("refills based on elapsed time (simulated clock)", async () => {
    const bucket = buckets().get("key-refill");
    await bucket.configure(2, 1); // 1 token per second, capacity 2
    await bucket.take(2);
    expect((await bucket.take()).allowed).toBe(false);

    await bucket.advanceClock(1_000); // +1s → +1 token
    const afterOneSec = await bucket.take();
    expect(afterOneSec.allowed).toBe(true);
    expect(afterOneSec.remaining).toBe(0);

    await bucket.advanceClock(60_000); // way past capacity
    const afterLong = await bucket.take();
    expect(afterLong.allowed).toBe(true);
    expect(afterLong.remaining).toBe(1);
  });

  it("computes retryAfterMs proportional to the deficit", async () => {
    const bucket = buckets().get("key-retry");
    await bucket.configure(1, 2); // 2 tokens per second
    await bucket.take();
    const denied = await bucket.take();
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(500);
  });
});

describe("token bucket: instance independence", () => {
  it("keeps API keys in independent bucket instances", async () => {
    const a = buckets().get("key-a");
    const b = buckets().get("key-b");
    expect(a.id.toString()).not.toBe(b.id.toString());
    await a.configure(1, 1);
    await b.configure(1, 1);
    await a.take();
    expect((await a.take()).allowed).toBe(false); // a is exhausted
    expect((await b.take()).allowed).toBe(true); // b is untouched
  });

  it("uses defaults when take() runs before configure()", async () => {
    const bucket = buckets().get("key-unconfigured");
    const first = await bucket.take();
    expect(first).toEqual({ allowed: true, remaining: 9, retryAfterMs: 0 });
    expect(await bucket.config()).toEqual({ capacity: 10, refillPerSec: 1 });
  });
});

describe("token bucket: config persistence", () => {
  it("persists config in SQLite and reads it back through a fresh stub", async () => {
    await buckets().get("key-persist").configure(42, 7);
    const again = kind(env.APP_DO, "bucket").get("key-persist");
    expect(await again.config()).toEqual({ capacity: 42, refillPerSec: 7 });
    const raw = env.APP_DO.get(buckets().idFromName("key-persist"));
    expect(await raw.__claydoKind()).toBe("bucket");
  });

  it("reconfigure refills to the new capacity", async () => {
    const bucket = buckets().get("key-reconfig");
    await bucket.configure(2, 1);
    await bucket.take(2);
    expect((await bucket.take()).allowed).toBe(false);
    await bucket.configure(5, 1);
    expect((await bucket.take(5)).allowed).toBe(true);
  });
});

describe("token bucket: concurrency", () => {
  it("handles 10 concurrent first-contact takes without over-issuing", async () => {
    const bucket = buckets().get("key-concurrent");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => bucket.take()),
    );
    expect(results.filter((r: TakeResult) => r.allowed)).toHaveLength(10);
    expect((await bucket.take()).allowed).toBe(false);
  });
});

describe("error propagation through the stub", () => {
  it("keeps name, message, custom fields AND the remote stack; instanceof is lost by design", async () => {
    const bucket = buckets().get("key-bad-config");
    let thrown: unknown;
    try {
      await bucket.configure(-1, 0);
    } catch (error) {
      thrown = error;
    }
    const err = thrown as Error & { code?: string };
    expect(err.name).toBe("RangeError");
    expect(err.message).toBe(
      "configure(capacity, refillPerSec) requires positive numbers, got (-1, 0)",
    );
    expect(err.code).toBe("ERR_BAD_BUCKET_CONFIG");
    expect(err.stack).toContain("Bucket.configure");
    expect(err.stack).toContain(
      "at [remote call bucket.configure() via claydo]",
    );
    expect(err).not.toBeInstanceOf(RangeError);
  });
});

describe("resetStorage keeps the kind pinned", () => {
  it("reset() wipes state but the instance stays kind 'bucket'", async () => {
    const bucket = buckets().get("key-reset");
    await bucket.configure(42, 7);
    expect(await bucket.config()).toEqual({ capacity: 42, refillPerSec: 7 });

    await bucket.reset();
    expect(await bucket.config()).toEqual({ capacity: 10, refillPerSec: 1 });
    expect((await bucket.take()).allowed).toBe(true);
    const raw = env.APP_DO.get(buckets().idFromName("key-reset"));
    expect(await raw.__claydoKind()).toBe("bucket");
  });
});

describe("worker routes end to end", () => {
  async function call(input: string, init?: RequestInit) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://example.com${input}`, init),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  it("PUT config, POST take, then 429 with Retry-After when exhausted", async () => {
    const put = await call("/limits/e2e-key/config", {
      method: "PUT",
      body: JSON.stringify({ capacity: 2, refillPerSec: 1 }),
    });
    expect(put.status).toBe(200);

    expect((await call("/limits/e2e-key/take", { method: "POST" })).status).toBe(200);
    const second = await call("/limits/e2e-key/take?n=1", { method: "POST" });
    expect(second.status).toBe(200);
    expect(((await second.json()) as TakeResult).remaining).toBe(0);

    const denied = await call("/limits/e2e-key/take", { method: "POST" });
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(((await denied.json()) as TakeResult).allowed).toBe(false);
  });
});
