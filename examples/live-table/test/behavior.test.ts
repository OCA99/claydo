/**
 * Library behavior exercised through the live-table kinds: instance
 * addressing, first-contact concurrency, error codes, and payload sizes.
 */
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isClaydoError, kind, kinds, type KindNameOf } from "../../../src/index";
import type { ClaydoError } from "../../../src/index";
import { type InsertDelta } from "../worker";

const app = kinds(env.APP_DO);

async function caught(promise: Promise<unknown>): Promise<ClaydoError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(Error);
  return error as ClaydoError;
}

describe("concurrent first contact", () => {
  it("survives 10 concurrent first RPC calls to a fresh instance", async () => {
    const shard = app.shard.get("concurrent-rpc");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        shard.insert("concurrent-rpc", `msg-${i}`),
      ),
    );
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await shard.list("concurrent-rpc")).toHaveLength(10);
  });

  it("survives mixed concurrent first contact: RPC + fetch + websocket", async () => {
    const shard = app.shard.get("concurrent-mixed");
    const [inserted, plainFetch, wsFetch, listed] = await Promise.all([
      shard.insert("concurrent-mixed", "first"),
      shard.fetch("https://do/"), // non-upgrade: the kind answers 426
      shard.fetch("https://do/", { headers: { Upgrade: "websocket" } }),
      shard.list("concurrent-mixed"),
    ]);
    expect(inserted.seq).toBe(1);
    expect(plainFetch.status).toBe(426);
    expect(wsFetch.status).toBe(101);
    wsFetch.webSocket!.accept();
    wsFetch.webSocket!.close();
    expect(listed.length).toBeLessThanOrEqual(1);
  });
});

describe("raw namespace access without the kind prefix", () => {
  it("reaches a DIFFERENT instance than the kind accessor", async () => {
    const viaHelper = app.shard.get("room-raw");
    await viaHelper.insert("room-raw", "helper-data");

    // Same logical name, raw namespace, no prefix: a different instance.
    const rawId = env.APP_DO.idFromName("room-raw");
    expect(rawId.toString()).not.toBe(viaHelper.id.toString());

    // A fetch to that un-prefixed instance fails with guidance.
    const response = await env.APP_DO.get(rawId).fetch("https://do/");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("kind() helper");
  });

  it("raw access WITH the manual prefix reaches the kind", async () => {
    await app.shard.get("room-raw-2").insert("room-raw-2", "x");
    const raw = env.APP_DO.get(env.APP_DO.idFromName("shard:room-raw-2"));
    // The kind resolves from the name prefix, so this hits Shard.fetch.
    const response = await raw.fetch("https://do/");
    expect(response.status).toBe(426); // Shard's "expected a websocket upgrade"
  });
});

describe("logical names containing a colon", () => {
  it("round-trips get/list/instanceName for 'tenant:42'", async () => {
    const shard = app.shard.get("tenant:42");
    await shard.insert("tenant:42", "colon-safe");
    expect(await shard.list("tenant:42")).toHaveLength(1);
    // The kind prefix ends at the FIRST colon, so the rest survives.
    expect(await shard.roomName()).toBe("tenant:42");
    // Distinct from a shard named plain "tenant".
    expect(app.shard.idFromName("tenant:42").toString()).not.toBe(
      app.shard.idFromName("tenant").toString(),
    );
  });

  it("a logical name that starts with another kind's name is fine", async () => {
    // Full name is "shard:session:9"; the prefix parse stops at the first colon.
    const shard = app.shard.get("session:9");
    await shard.insert("session:9", "not-a-session");
    expect(await shard.roomName()).toBe("session:9");
  });
});

describe("fromId() never initializes", () => {
  it("RPC through fromId() on an untouched id fails with CLAYDO_UNINITIALIZED", async () => {
    const id = env.APP_DO.newUniqueId();
    const orphan = app.shard.fromId(id);
    const error = await caught(orphan.list("anything"));
    expect(isClaydoError(error)).toBe(true);
    expect(error.code).toBe("CLAYDO_UNINITIALIZED");
    expect(error.message).toContain("fromId()");
  });

  it("fetch() through fromId() on an untouched id answers 404", async () => {
    const id = env.APP_DO.newUniqueId();
    const orphan = app.shard.fromId(id);
    const response = await orphan.fetch("https://do/");
    expect(response.status).toBe(404);
  });

  it("fromId() reaches instances that were initialized via unique()", async () => {
    const made = app.shard.unique();
    await made.insert("r", "first-contact");
    const again = app.shard.fromId(made.id.toString());
    expect(await again.list("r")).toHaveLength(1);
  });

  it("access under the wrong kind fails with CLAYDO_KIND_MISMATCH", async () => {
    const shard = app.shard.get("mismatch");
    await shard.insert("mismatch", "x");
    const wrong = app.session.fromId(shard.id);
    const error = await caught(wrong.recent());
    expect(error.code).toBe("CLAYDO_KIND_MISMATCH");
    expect((error as ClaydoError & { actualKind?: string }).actualKind).toBe(
      "shard",
    );
    expect(
      (error as ClaydoError & { expectedKind?: string }).expectedKind,
    ).toBe("session");
  });
});

describe("stubs across async boundaries", () => {
  it("works after a setTimeout", async () => {
    const shard = app.shard.get("boundary-settimeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await shard.insert("boundary-settimeout", "late")).seq).toBe(1);
  });

  it("works inside ctx.waitUntil", async () => {
    const ctx = createExecutionContext();
    const shard = app.shard.get("boundary-waituntil");
    ctx.waitUntil(shard.insert("boundary-waituntil", "deferred"));
    await waitOnExecutionContext(ctx);
    expect(await shard.list("boundary-waituntil")).toHaveLength(1);
  });
});

describe("stub metadata and misuse", () => {
  it("exposes id, name, and kind as plain metadata", async () => {
    const shard = app.shard.get("meta");
    expect(shard.kind).toBe("shard");
    expect(shard.name).toBe("meta");
    expect(shard.id.toString()).toBe(app.shard.idFromName("meta").toString());
  });

  it("a typo'd method fails with CLAYDO_NO_METHOD", async () => {
    const shard = app.shard.get("typo");
    const error = await caught(
      (shard as unknown as { isnert(r: string, b: string): Promise<unknown> })
        .isnert("typo", "x"),
    );
    expect(error.code).toBe("CLAYDO_NO_METHOD");
    expect(error.message).toContain("isnert");
    // Without the cast, TypeScript catches it:
    // @ts-expect-error TS2551: Property 'isnert' does not exist on type 'KindStub<Shard>'. Did you mean 'insert'?
    void shard.isnert;
  });

  it("a runtime-built kind name is typeable with KindNameOf", async () => {
    const dynamic: string = ["sha", "rd"].join("");
    // A bare string is rejected at the type level:
    // @ts-expect-error TS2345: Argument of type 'string' is not assignable to parameter of type 'KindNameOf<DurableObjectNamespace<LiveTableDO>>'.
    kind(env.APP_DO, dynamic);
    // Cast once to the exported name union, then narrow:
    const k = dynamic as KindNameOf<typeof env.APP_DO>;
    if (k !== "shard") throw new Error("routing bug");
    const shard = kind(env.APP_DO, k).get("dynamic-name");
    await shard.insert("dynamic-name", "dyn");
    expect(await shard.list("dynamic-name")).toHaveLength(1);
  });

  it("an unregistered runtime kind name fails with CLAYDO_UNKNOWN_KIND", async () => {
    const nope = kind(
      env.APP_DO,
      "tables" as KindNameOf<typeof env.APP_DO>,
    ).get("x");
    const error = await caught(
      (nope as unknown as { list(r: string): Promise<unknown> }).list("x"),
    );
    expect(error.code).toBe("CLAYDO_UNKNOWN_KIND");
    expect(error.message).toContain("shard");
    expect(error.message).toContain("session");
  });
});

describe("large payloads (~100KB)", () => {
  const big = "x".repeat(100_000);

  it("100KB through RPC (argument and return)", async () => {
    const shard = app.shard.get("big-room");
    await shard.insert("big-room", big);
    const rows = await shard.list("big-room");
    expect(rows[0]!.body.length).toBe(100_000);
  });

  it("100KB delta through a WebSocket subscriber", async () => {
    const shard = app.shard.get("big-ws");
    const response = await shard.fetch("https://do/", {
      headers: { Upgrade: "websocket" },
    });
    const ws = response.webSocket!;
    ws.accept();
    const delta = new Promise<InsertDelta>((resolve) =>
      ws.addEventListener("message", (event) =>
        resolve(JSON.parse(event.data as string)),
      ),
    );
    await shard.insert("big-ws", big);
    expect((await delta).body.length).toBe(100_000);
    ws.close();
  });
});
