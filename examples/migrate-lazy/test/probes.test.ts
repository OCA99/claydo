import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import {
  migrateInstance,
  migrated,
  wipeTarget,
  SEALED_HEADER,
  type ExportChunk,
} from "../../../src/migrate";
import type { ImportState } from "../../../src/migrate-wire";
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

async function expectRejects(
  run: () => Promise<unknown>,
  pattern: RegExp,
): Promise<string> {
  try {
    await run();
  } catch (error) {
    const message = messageOf(error);
    expect(message).toMatch(pattern);
    return message;
  }
  expect.unreachable(`expected rejection matching ${pattern}`);
}

describe("first-touch race", () => {
  it("same facade: 5 concurrent calls migrate exactly once, data intact", async () => {
    await oldBucket("race-same").configure(100, 0);
    const facade = lazyFacade();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => facade.get("race-same").take(1)),
    );

    expect(results.every((r) => r.allowed)).toBe(true);
    expect(new Set(results.map((r) => r.remaining))).toEqual(
      new Set([95, 96, 97, 98, 99]),
    );
    expect(await newBuckets().get("race-same").remaining()).toBe(95);
    expect((await oldBucket("race-same").__claydoSealed()).sealed).toBe(true);
  });

  it("two facades (two Workers): ALL callers succeed, exactly-once, no split", async () => {
    await oldBucket("race-two").configure(50, 0);
    const facadeA = lazyFacade();
    const facadeB = lazyFacade();

    const outcomes = await Promise.allSettled([
      facadeA.get("race-two").take(1),
      facadeB.get("race-two").take(1),
      facadeA.get("race-two").take(1),
      facadeB.get("race-two").take(1),
    ]);
    console.log(
      "[probe race-two] outcomes:",
      outcomes.map((o) =>
        o.status === "fulfilled" ? o.value : messageOf(o.reason),
      ),
    );

    expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);
    const values = outcomes.map(
      (o) => (o as PromiseFulfilledResult<TakeResult>).value,
    );
    expect(values.every((v) => v.allowed)).toBe(true);
    expect(new Set(values.map((v) => v.remaining))).toEqual(
      new Set([46, 47, 48, 49]),
    );
    expect(await newBuckets().get("race-two").remaining()).toBe(46);

    const seal = await oldBucket("race-two").__claydoSealed();
    console.log("[probe race-two] old seal state after race:", seal);
    expect(seal.sealed).toBe(true);
    expect(seal.movedTo).toBe("bucket:race-two");
    expect(await lazyFacade().get("race-two").remaining()).toBe(46);
  });

  it("deterministic loser replay: reservation fails fast, nothing is rolled back", async () => {
    const name = "race-loser";
    await oldBucket(name).configure(10, 0);
    const raw = rawNew("bucket", name);

    expect((await raw.__claydoImportStatus()).kind).toBeUndefined();
    await migrateInstance({ from: oldBucket(name), to: newBuckets(), name });
    const loserError = await expectRejects(
      () => raw.__claydoBeginImport("bucket", "loser-token"),
      /is (?:already )?live as kind 'bucket'/,
    );
    console.log("[probe race-loser] loser reservation error:", loserError);
    expect(loserError).toMatch(/wipe it with wipeTarget\(\)/);

    const seal = await oldBucket(name).__claydoSealed();
    expect(seal.sealed).toBe(true);
    expect(seal.movedTo).toBe(`bucket:${name}`);

    const again = await migrateInstance({
      from: oldBucket(name),
      to: newBuckets(),
      name,
    });
    expect(again.skipped).toBe(true);
    expect(again.reason).toBe("already migrated");

    expect(await lazyFacade().get(name).remaining()).toBe(10);
  });

  it("the seq protocol is ownership-guarded: wrong token, out-of-order, foreign abort all fail", async () => {
    const name = "seq-gap";
    const old = oldSession(name);
    for (let i = 0; i < 6; i++) await old.setValue(`k${i}`, `v${i}`);
    await old.__claydoSeal();
    const raw = rawNew("session", name);
    await raw.__claydoBeginImport("session", "driver-a");
    const first = (await old.__claydoExport(undefined, null, {
      maxBytes: 16,
    })) as ExportChunk;
    await raw.__claydoImport("session", first, 1, "driver-a");

    const foreign = await expectRejects(
      () => raw.__claydoImport("session", first, 2, "driver-b"),
      /owned by another migration driver/,
    );
    console.log("[probe seq-gap] foreign-token error:", foreign);

    const gap = await expectRejects(
      () => raw.__claydoImport("session", first, 3, "driver-a"),
      /expected seq 2, got 3/,
    );
    console.log("[probe seq-gap] out-of-order error:", gap);

    const abort = await expectRejects(
      () => raw.__claydoAbortImport("driver-b"),
      /cannot abort an import owned by another migration driver/,
    );
    console.log("[probe seq-gap] foreign-abort error:", abort);
    expect(abort).toMatch(/Use wipeTarget\(\) to force/);
  });
});

describe("traffic during a slow migration", () => {
  it("facade callers WAIT for the in-flight migration and succeed; direct target traffic still blocks", async () => {
    const name = "slow-1";
    const old = oldSession(name);
    for (let i = 0; i < 8; i++) await old.setValue(`key${i}`, `value${i}`);

    await old.__claydoSeal();
    const raw = rawNew("session", name);
    await raw.__claydoBeginImport("session", "stalled-driver");
    const first = (await old.__claydoExport(undefined, null, {
      maxBytes: 16,
    })) as ExportChunk;
    expect(first.cursor).not.toBeNull(); // genuinely mid-import
    await raw.__claydoImport("session", first, 1, "stalled-driver");

    const direct = await expectRejects(
      () => newSessions().get(name).getValue("key0"),
      /is importing kind 'session'/,
    );
    console.log("[probe slow-import] direct RPC error:", direct);
    const response = await newSessions().get(name).fetch("https://do/");
    console.log(
      `[probe slow-import] direct fetch -> ${response.status}: ${await response.text()}`,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("2");

    const facade = migrated(env.OLD_SESSIONS, newSessions(), {
      strategy: "drain",
    });
    const waiting = facade.get(name).getValue("key0");
    await runInDurableObject(raw, async (_instance, state) => {
      const s = (await state.storage.get("__claydo:import")) as ImportState;
      s.updatedAtMs = Date.now() - 60_000;
      await state.storage.put("__claydo:import", s);
    });
    const summary = await migrateInstance({
      from: old,
      to: newSessions(),
      name,
    });
    expect(summary.resumed).toBe(true);
    expect(await waiting).toBe("value0"); // the caller never saw an error
    expect(await facade.get(name).getValue("key7")).toBe("value7");
  });
});

describe("both-live conflict and its suggested recoveries", () => {
  async function forceSplit(name: string): Promise<string> {
    await oldBucket(name).configure(10, 0); // old has data, unsealed
    await newBuckets().get(name).configure(5, 0); // new initialized directly
    return expectRejects(
      () => lazyFacade().get(name).remaining(),
      /both the old instance/,
    );
  }

  it("wipeTarget() recovers a polluted target end-to-end", async () => {
    const name = "split-wipe";
    const error = await forceSplit(name);
    console.log("[probe both-live] router error:", error);
    expect(error).toMatch(/wipe the polluted new instance with wipeTarget\(\)/);

    await newBuckets().get(name).nuke();
    const still = await expectRejects(
      () => lazyFacade().get(name).remaining(),
      /both the old instance/,
    );
    console.log("[probe both-live] after raw deleteAll:", still);

    await wipeTarget(newBuckets(), name);

    expect(await lazyFacade().get(name).remaining()).toBe(10);
    expect((await oldBucket(name).__claydoSealed()).sealed).toBe(true);
    expect(await newBuckets().get(name).remaining()).toBe(10);
  });

  it('the "seal the old side" path warns that old data is not copied', async () => {
    const name = "split-seal";
    await forceSplit(name);

    const driverError = await expectRejects(
      () =>
        migrateInstance({ from: oldBucket(name), to: newBuckets(), name }),
      /both the old instance .* are live/,
    );
    console.log("[probe both-live] driver error:", driverError);
    expect(driverError).toMatch(/its data will NOT be copied/);

    await oldBucket(name).__claydoSeal();
    expect(await lazyFacade().get(name).remaining()).toBe(5);
    await expectRejects(() => oldBucket(name).remaining(), /is sealed/);
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

    expect(await facade.get(name).remaining()).toBe(8);
    expect((await facade.get(name).take(1)).remaining).toBe(7);
    expect(await newBuckets().get(name).remaining()).toBe(7);
  });

  it("fetch() through a stale facade retries too — no raw 410", async () => {
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
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ remaining: 10 });

    const raw410 = await oldBucket(name).fetch("https://do/");
    const body = await raw410.text();
    console.log(
      `[probe stale-fetch] raw old binding -> ${raw410.status} ` +
        `(${SEALED_HEADER}: ${raw410.headers.get(SEALED_HEADER)}): ${body}`,
    );
    expect(raw410.status).toBe(410);
    expect(raw410.headers.get(SEALED_HEADER)).toBe("1");
    expect(body).toBe(
      "claydo: this instance is sealed (migrating or migrated). " +
        "Reconnect through the current endpoint.",
    );
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

  it("old-routed upgrades work AND sync self-calls stay intact", async () => {
    await oldBucket("ws-old").configure(10, 0);
    const facade = migrated(env.OLD_BUCKETS, newBuckets(), {
      strategy: "manual",
    });
    const response = await wsThrough(facade, "ws-old");
    expect(response.status).toBe(101);

    const reply = await takeOverWs(response.webSocket!);
    console.log("[probe ws-old] reply from the OLD (exportable) class:", reply);
    expect(reply).toBe('{"allowed":true,"remaining":9}');
    response.webSocket!.close();
    expect(await oldBucket("ws-old").remaining()).toBe(9);
  });

  it("sealing closes live sockets with 1012, and reconnects through the STALE facade land on the new side", async () => {
    const name = "ws-sealed";
    await oldBucket(name).configure(10, 0);
    const facade = migrated(env.OLD_BUCKETS, newBuckets(), {
      strategy: "manual",
      oldRouteTtlMs: 3_600_000,
    });

    const first = await wsThrough(facade, name);
    expect(first.status).toBe(101);
    const ws = first.webSocket!;
    ws.accept();
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener("close", (event) =>
        resolve({ code: event.code, reason: event.reason }),
      ),
    );

    await migrateInstance({ from: oldBucket(name), to: newBuckets(), name });

    const close = await closed;
    console.log("[probe ws-sealed] client close event:", close);
    expect(close.code).toBe(1012);
    expect(close.reason).toBe("claydo: instance migrating; reconnect");

    const reconnect = await wsThrough(facade, name);
    expect(reconnect.status).toBe(101);
    const reply = await takeOverWs(reconnect.webSocket!);
    expect(JSON.parse(reply) as TakeResult).toEqual({
      allowed: true,
      remaining: 9,
    });
    reconnect.webSocket!.close();
  });
});
