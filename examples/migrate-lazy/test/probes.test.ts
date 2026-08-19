/**
 * Adversarial probes against the transitional router. Each test forces a
 * failure mode a production fleet would eventually hit, captures the errors
 * a caller sees verbatim (logged with a [probe] prefix), and asserts the
 * resulting invariants so the suite stays green.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import {
  migrateInstance,
  migrated,
  type ExportChunk,
} from "../../../src/migrate";
import type { TakeResult } from "../worker";

const newBuckets = () => kind(env.LIMITER_DO, "bucket");
const newSessions = () => kind(env.LIMITER_DO, "session");
const oldBucket = (name: string) =>
  env.OLD_BUCKETS.get(env.OLD_BUCKETS.idFromName(name));
const oldSession = (name: string) =>
  env.OLD_SESSIONS.get(env.OLD_SESSIONS.idFromName(name));
const rawNew = (kindName: string, name: string) =>
  env.LIMITER_DO.get(env.LIMITER_DO.idFromName(`${kindName}:${name}`));

const lazyFacade = () =>
  migrated(env.OLD_BUCKETS, newBuckets(), { strategy: "lazy" });

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

describe("first-touch race", () => {
  it("same facade: 5 concurrent calls migrate exactly once, data intact", async () => {
    await oldBucket("race-same").configure(100, 0);
    const facade = lazyFacade();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => facade.get("race-same").take(1)),
    );

    // Every caller succeeded, and each take applied exactly once: the five
    // remaining values are the five distinct steps down from 100.
    expect(results.every((r) => r.allowed)).toBe(true);
    expect(new Set(results.map((r) => r.remaining))).toEqual(
      new Set([95, 96, 97, 98, 99]),
    );
    expect(await newBuckets().get("race-same").remaining()).toBe(95);
    expect((await oldBucket("race-same").__claydoSealed()).sealed).toBe(true);
  });

  it("two facades (two Workers): losers may unseal the old instance and split the fleet", async () => {
    await oldBucket("race-two").configure(50, 0);
    const facadeA = lazyFacade();
    const facadeB = lazyFacade();

    const outcomes = await Promise.allSettled([
      facadeA.get("race-two").take(1),
      facadeB.get("race-two").take(1),
      facadeA.get("race-two").take(1),
      facadeB.get("race-two").take(1),
    ]);
    const rejected = outcomes.filter((o) => o.status === "rejected");
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    for (const loss of rejected) {
      console.log("[probe race-two] loser error:", messageOf(loss.reason));
    }
    console.log(
      `[probe race-two] fulfilled=${fulfilled.length} rejected=${rejected.length}`,
      fulfilled.map((o) => (o as PromiseFulfilledResult<TakeResult>).value),
    );

    // The winner always lands the data on the new side.
    expect(await rawNew("bucket", "race-two").__claydoKind()).toBe("bucket");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // The dangerous part: if a loser's rollback ran after the winner
    // finished, it UNSEALED the old instance — old live with data + new
    // live = the split the library itself warns about.
    const seal = await oldBucket("race-two").__claydoSealed();
    console.log("[probe race-two] old seal state after race:", seal);
    if (!seal.sealed) {
      const fresh = lazyFacade();
      await expect(fresh.get("race-two").remaining()).rejects.toThrow(
        /both the old instance/,
      );
      console.log(
        "[probe race-two] fleet is split: fresh facades now fail with the both-live error",
      );
    }
  });

  it("deterministic loser replay: the rollback unseal creates a both-live split", async () => {
    const name = "race-loser";
    await oldBucket(name).configure(10, 0);
    const raw = rawNew("bucket", name);

    // The loser driver passed its pre-flight status check...
    expect((await raw.__claydoImportStatus()).kind).toBeUndefined();
    // ...then the winner completed the whole migration...
    await migrateInstance({ from: oldBucket(name), to: newBuckets(), name });
    // ...and the loser proceeds exactly as migrateInstance's loop would:
    await oldBucket(name).__claydoSeal();
    const chunk = await oldBucket(name).__claydoExport(undefined, null);
    let loserError = "";
    try {
      await raw.__claydoImport("bucket", chunk, 1);
    } catch (error) {
      loserError = messageOf(error);
    }
    console.log("[probe race-loser] loser import error:", loserError);
    expect(loserError).toMatch(/is already live as kind 'bucket'/);

    // migrateInstance's catch block now "rolls back": abort (a no-op here)
    // and UNSEAL the old instance — even though the winner already cut over.
    expect(await raw.__claydoAbortImport()).toBe(false);
    await oldBucket(name).__claydoUnseal();

    // Result: old unsealed with data, new live. Every fresh route fails.
    const facade = lazyFacade();
    let splitError = "";
    try {
      await facade.get(name).remaining();
    } catch (error) {
      splitError = messageOf(error);
    }
    console.log("[probe race-loser] router error after split:", splitError);
    expect(splitError).toMatch(/both the old instance/);
  });

  it("interleaved drivers hit the out-of-order seq guard", async () => {
    const name = "seq-gap";
    const old = oldSession(name);
    for (let i = 0; i < 6; i++) await old.setValue(`k${i}`, `v${i}`);
    await old.__claydoSeal();
    const first = await old.__claydoExport(undefined, null, { maxBytes: 16 });
    const raw = rawNew("session", name);
    await raw.__claydoImport("session", first, 1);

    let seqError = "";
    try {
      await raw.__claydoImport("session", first, 3);
    } catch (error) {
      seqError = messageOf(error);
    }
    console.log("[probe seq-gap] out-of-order error:", seqError);
    expect(seqError).toMatch(/expected seq 2, got 3/);
    expect(seqError).toMatch(/Another migration driver may be running/);
  });
});

describe("traffic during a slow migration", () => {
  it("callers are hard-failed until the import completes", async () => {
    const name = "slow-1";
    const old = oldSession(name);
    for (let i = 0; i < 8; i++) await old.setValue(`key${i}`, `value${i}`);

    // A slow driver: sealed the old instance, applied one tiny chunk, stalled.
    await old.__claydoSeal();
    // PAPERCUT: the RPC type of __claydoExport collapses to `never` (the
    // wire type contains `unknown`), so the chunk needs a cast to be usable.
    const first = (await old.__claydoExport(undefined, null, {
      maxBytes: 16,
    })) as ExportChunk;
    expect(first.cursor).not.toBeNull(); // genuinely mid-import
    const raw = rawNew("session", name);
    await raw.__claydoImport("session", first, 1);

    // A production caller through the facade, RPC:
    const facade = migrated(env.OLD_SESSIONS, newSessions(), {
      strategy: "drain",
    });
    let blockedError = "";
    try {
      await facade.get(name).getValue("key0");
    } catch (error) {
      blockedError = messageOf(error);
    }
    console.log("[probe slow-import] RPC error:", blockedError);
    expect(blockedError).toMatch(/is importing kind 'session'/);
    expect(blockedError).toMatch(/blocked until the migration completes/);

    // And fetch():
    const response = await facade.get(name).fetch("https://do/");
    const body = await response.text();
    console.log(
      `[probe slow-import] fetch -> ${response.status}: ${body}`,
    );
    expect(response.status).toBe(400);
    expect(body).toMatch(/is importing kind 'session'/);

    // The driver resumes and completes; the same facade recovers on its own
    // (the "new" decision was already cached during the outage).
    const summary = await migrateInstance({
      from: old,
      to: newSessions(),
      name,
    });
    expect(summary.resumed).toBe(true);
    expect(await facade.get(name).getValue("key0")).toBe("value0");
  });
});

describe("both-live conflict and its suggested recoveries", () => {
  async function forceSplit(name: string): Promise<string> {
    await oldBucket(name).configure(10, 0); // old has data, unsealed
    await newBuckets().get(name).configure(5, 0); // new initialized directly
    const facade = lazyFacade();
    let error = "";
    try {
      await facade.get(name).remaining();
    } catch (e) {
      error = messageOf(e);
    }
    expect(error).toMatch(/both the old instance/);
    return error;
  }

  it('suggested recovery "wipe the new one" does not work while the instance is resident', async () => {
    const name = "split-wipe";
    const error = await forceSplit(name);
    console.log("[probe both-live] router error:", error);

    // The error says: "seal the old instance, or wipe the new one". Try the
    // wipe. The only wipe a kind can perform is storage.deleteAll() (the
    // library's resetStorage would keep the kind pinned on purpose).
    await newBuckets().get(name).nuke();

    // Still split: the host caches the kind in memory, so the wiped
    // instance keeps reporting itself live until it is evicted.
    let stillSplit = "";
    try {
      await lazyFacade().get(name).remaining();
    } catch (e) {
      stillSplit = messageOf(e);
    }
    console.log("[probe both-live] after deleteAll on new:", stillSplit);
    expect(stillSplit).toMatch(/both the old instance/);
  });

  it('suggested recovery "seal the old instance" works but silently strands the old data', async () => {
    const name = "split-seal";
    await forceSplit(name);

    await oldBucket(name).__claydoSeal();

    // Routing recovers...
    const facade = lazyFacade();
    expect(await facade.get(name).remaining()).toBe(5);
    // ...but the old instance's 10-token state is stranded behind the seal,
    // and nothing migrated it. The error message never mentioned this.
    await expect(oldBucket(name).remaining()).rejects.toThrow(/is sealed/);
  });
});

describe("cache staleness after an external migration", () => {
  it("RPC through a stale facade recovers via the seal-retry path", async () => {
    const name = "stale-rpc";
    await oldBucket(name).configure(10, 0);
    await oldBucket(name).take(2); // 8 left on old

    const facade = migrated(env.OLD_BUCKETS, newBuckets(), {
      strategy: "manual",
      oldRouteTtlMs: 3_600_000,
    });
    expect(await facade.get(name).remaining()).toBe(8); // caches "old"

    await migrateInstance({ from: oldBucket(name), to: newBuckets(), name });

    // The cached "old" route hits the seal, re-resolves once, retries new.
    expect(await facade.get(name).remaining()).toBe(8);
    expect((await facade.get(name).take(1)).remaining).toBe(7);
    expect(await newBuckets().get(name).remaining()).toBe(7);
  });

  it("fetch() through a stale facade leaks the raw 410 — no retry", async () => {
    const name = "stale-fetch";
    await oldBucket(name).configure(10, 0);

    const facade = migrated(env.OLD_BUCKETS, newBuckets(), {
      strategy: "manual",
      oldRouteTtlMs: 3_600_000,
    });
    const before = await facade.get(name).fetch("https://do/");
    expect(before.status).toBe(200); // routed old, cached "old"

    await migrateInstance({ from: oldBucket(name), to: newBuckets(), name });

    const after = await facade.get(name).fetch("https://do/");
    const body = await after.text();
    console.log(`[probe stale-fetch] fetch -> ${after.status}: ${body}`);
    expect(after.status).toBe(410);
    expect(body).toMatch(/is sealed/);

    // An RPC call on the same facade repairs the cache (its retry path
    // re-resolves), after which fetch() works again — fetch never heals
    // itself.
    expect(await facade.get(name).remaining()).toBe(10);
    const healed = await facade.get(name).fetch("https://do/");
    expect(healed.status).toBe(200);
    expect(await healed.json()).toEqual({ remaining: 10 });
  });
});

describe("websockets through the facade", () => {
  async function wsThrough(
    facade: ReturnType<typeof lazyFacade>,
    name: string,
  ): Promise<Response> {
    return facade.get(name).fetch("https://do/ws", {
      headers: { Upgrade: "websocket" },
    });
  }

  async function takeOverWs(ws: WebSocket): Promise<string> {
    ws.accept();
    return new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) =>
        resolve(event.data as string),
      );
      ws.send("take");
    });
  }

  it("upgrades to an old-routed instance connect, but exportable() corrupts sync self-calls", async () => {
    await oldBucket("ws-old").configure(10, 0);
    const facade = migrated(env.OLD_BUCKETS, newBuckets(), {
      strategy: "manual",
    });
    const response = await wsThrough(facade, "ws-old");
    expect(response.status).toBe(101); // the upgrade itself works

    const reply = await takeOverWs(response.webSocket!);
    console.log("[probe ws-old] reply from the OLD (exportable) class:", reply);
    // BUG CAPTURED: the handler runs `JSON.stringify(this.take(1))`. On the
    // unwrapped class that is {"allowed":true,"remaining":9}. But the
    // exportable() seal guard replaced take() with an ASYNC wrapper, so the
    // handler stringified a pending Promise:
    expect(reply).toBe("{}");
    response.webSocket!.close();
    // The take itself still landed on the OLD instance, asynchronously:
    expect(await oldBucket("ws-old").remaining()).toBe(9);
  });

  it("upgrades to a freshly sealed instance return a raw 410; reconnects fail until the cache expires", async () => {
    const name = "ws-sealed";
    await oldBucket(name).configure(10, 0);
    const facade = migrated(env.OLD_BUCKETS, newBuckets(), {
      strategy: "manual",
      oldRouteTtlMs: 3_600_000,
    });
    expect(await facade.get(name).remaining()).toBe(10); // cache "old"

    await migrateInstance({ from: oldBucket(name), to: newBuckets(), name });

    // The client tries to (re)connect: no WebSocket, just a 410 body.
    const attempt = await wsThrough(facade, name);
    const body = await attempt.text();
    console.log(`[probe ws-sealed] upgrade -> ${attempt.status}: ${body}`);
    expect(attempt.status).toBe(410);
    expect(attempt.webSocket).toBeNull();
    expect(body).toMatch(/is sealed/);

    // An immediate reconnect through the same facade: still 410, because
    // the "old" decision is cached for another hour.
    const reconnect = await wsThrough(facade, name);
    expect(reconnect.status).toBe(410);

    // Only a facade whose cache expired (simulated with a fresh one)
    // reaches the migrated instance — with the data carried over. On the
    // NEW side the kind class is unwrapped, so the reply is intact.
    const freshFacade = migrated(env.OLD_BUCKETS, newBuckets(), {
      strategy: "manual",
    });
    const ok = await wsThrough(freshFacade, name);
    expect(ok.status).toBe(101);
    const reply = await takeOverWs(ok.webSocket!);
    expect(JSON.parse(reply) as TakeResult).toEqual({
      allowed: true,
      remaining: 9,
    });
    ok.webSocket!.close();
  });
});
