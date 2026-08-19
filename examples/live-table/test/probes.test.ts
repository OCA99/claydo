/**
 * Adversarial DX probes. Each test deliberately misuses the library (or
 * stresses it) and asserts on the exact observed behavior, so the verbatim
 * error messages quoted in DX-REPORT.md stay honest.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind, kinds, union, type KindNameOf } from "../../../src/index";
import { type InsertDelta } from "../worker";

async function messageOf(response: Response): Promise<string> {
  return response.text();
}

describe("probe: concurrent first contact", () => {
  it("survives 10 concurrent first RPC calls to a fresh instance", async () => {
    const shard = kind(env.APP_DO, "shard").get("probe-concurrent-rpc");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        shard.insert("probe-concurrent-rpc", `msg-${i}`),
      ),
    );
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await shard.list("probe-concurrent-rpc")).toHaveLength(10);
  });

  it("survives mixed concurrent first contact: RPC + fetch + websocket", async () => {
    const shard = kind(env.APP_DO, "shard").get("probe-concurrent-mixed");
    const [inserted, plainFetch, wsFetch, listed] = await Promise.all([
      shard.insert("probe-concurrent-mixed", "first"),
      shard.fetch("https://do/"), // non-upgrade → the kind returns 426
      shard.fetch("https://do/", { headers: { Upgrade: "websocket" } }),
      shard.list("probe-concurrent-mixed"),
    ]);
    expect(inserted.seq).toBe(1);
    expect(plainFetch.status).toBe(426);
    expect(wsFetch.status).toBe(101);
    wsFetch.webSocket!.accept();
    wsFetch.webSocket!.close();
    expect(listed.length).toBeLessThanOrEqual(1);
  });
});

describe("probe: raw namespace access without the kind prefix", () => {
  it("silently reaches a DIFFERENT instance than kind().get()", async () => {
    const viaHelper = kind(env.APP_DO, "shard").get("room-raw");
    await viaHelper.insert("room-raw", "helper-data");

    // The realistic mistake: same logical name, raw namespace, no prefix.
    const rawId = env.APP_DO.idFromName("room-raw");
    expect(rawId.toString()).not.toBe(viaHelper.id.toString());

    // First contact through raw fetch: no stored kind, no prefix, no hint.
    // The 400 now explains the raw-access trap and names the instance.
    const raw = env.APP_DO.get(rawId);
    const response = await raw.fetch("https://do/");
    expect(response.status).toBe(400);
    expect(await messageOf(response)).toBe(
      "claydo: instance 'room-raw' has no kind yet. " +
        "Its name has no registered '<kind>:' prefix. Raw namespace access " +
        "(for example getByName('room-raw')) reaches a different instance than " +
        "kind(ns, '<kind>').get('room-raw'). Access instances through the " +
        "kind() helper, or use a '<kind>:' prefixed name.",
    );
  });

  it("raw access WITH the manual prefix works but skips the hint", async () => {
    await kind(env.APP_DO, "shard").get("room-raw-2").insert("room-raw-2", "x");
    const raw = env.APP_DO.get(env.APP_DO.idFromName("shard:room-raw-2"));
    // Raw fetch resolves the kind from storage/prefix; here it hits Shard.fetch.
    const response = await raw.fetch("https://do/");
    expect(response.status).toBe(426); // Shard's own "expected a websocket upgrade"
  });
});

describe("probe: logical names containing a colon", () => {
  it("round-trips get/list/instanceName for 'tenant:42'", async () => {
    const shard = kind(env.APP_DO, "shard").get("tenant:42");
    await shard.insert("tenant:42", "colon-safe");
    expect(await shard.list("tenant:42")).toHaveLength(1);
    // instanceName splits on the FIRST colon only, so the rest survives.
    expect(await shard.roomName()).toBe("tenant:42");
    // Distinct from a shard named plain "tenant".
    expect(kind(env.APP_DO, "shard").idFromName("tenant:42").toString()).not.toBe(
      kind(env.APP_DO, "shard").idFromName("tenant").toString(),
    );
  });

  it("a logical name that starts with ANOTHER kind's name is fine through the helper", async () => {
    // Full name is "shard:session:9" — prefix parse stops at the first colon.
    const shard = kind(env.APP_DO, "shard").get("session:9");
    await shard.insert("session:9", "not-a-session");
    expect(await shard.roomName()).toBe("session:9");
  });
});

describe("probe: fromId() no longer initializes", () => {
  it("RPC through fromId() on a fresh instance fails with an actionable error", async () => {
    const id = env.APP_DO.newUniqueId();
    const orphan = kind(env.APP_DO, "shard").fromId(id);
    let thrown: unknown;
    try {
      await orphan.list("anything");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe(
      `claydo: instance '${id.toString()}' has no kind yet. ` +
        "It was accessed as kind 'shard' through fromId(), which never " +
        "initializes an instance. Create the instance first with " +
        "kind(ns, 'shard').get(name) or .unique(), then reach it by id.",
    );
  });

  it("fetch() through fromId() on a fresh instance refuses with a 400", async () => {
    const id = env.APP_DO.newUniqueId();
    const orphan = kind(env.APP_DO, "shard").fromId(id);
    const response = await orphan.fetch("https://do/");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "through fromId(), which never initializes an instance",
    );
  });

  it("fromId() still reaches instances that were initialized via unique()", async () => {
    const made = kind(env.APP_DO, "shard").unique();
    await made.insert("r", "first-contact");
    const again = kind(env.APP_DO, "shard").fromId(made.id.toString());
    expect(await again.list("r")).toHaveLength(1);
  });

  it("kind-mismatch errors now name the instance", async () => {
    const shard = kind(env.APP_DO, "shard").get("probe-mismatch");
    await shard.insert("probe-mismatch", "x");
    const wrong = kind(env.APP_DO, "session").fromId(shard.id);
    await expect(wrong.recent()).rejects.toThrow(
      "claydo: instance 'shard:probe-mismatch' is kind " +
        "'shard', but the caller expected kind 'session'.",
    );
  });
});

describe("probe: stubs across async boundaries", () => {
  it("works after a setTimeout", async () => {
    const shard = kind(env.APP_DO, "shard").get("probe-settimeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await shard.insert("probe-settimeout", "late")).seq).toBe(1);
  });

  it("works inside ctx.waitUntil", async () => {
    const ctx = createExecutionContext();
    const shard = kind(env.APP_DO, "shard").get("probe-waituntil");
    ctx.waitUntil(shard.insert("probe-waituntil", "deferred"));
    await waitOnExecutionContext(ctx);
    expect(await shard.list("probe-waituntil")).toHaveLength(1);
  });
});

describe("probe: non-method members and reserved-name shadowing", () => {
  it("hides public fields from the stub type; the runtime error now explains it's a property", async () => {
    const probe = kind(env.APP_DO, "probe").get("probe-field");
    // @ts-expect-error TS2339: Property 'version' does not exist on type 'KindStub<Probe>'.
    void probe.version;

    // With `as any`, property access still returns an async FUNCTION, not the
    // value — but calling it now yields a self-explanatory error:
    const leaked = (probe as any).version;
    expect(typeof leaked).toBe("function"); // still truthy, still looks defined
    await expect(leaked()).rejects.toThrow(
      "claydo: 'version' on kind 'probe' is a property, " +
        "not a method (type: number). The stub only proxies methods; " +
        "add a getter method to read it.",
    );
  });

  it("union() now rejects kind classes with reserved method names at creation time", () => {
    class BadKind {
      constructor(_ctx: DurableObjectState, _env: unknown) {}
      name(): string {
        return "shadowed";
      }
    }
    // This used to be silently shadowed (stub.name() typechecked, then threw
    // TypeError at runtime). Now it fails fast, at class-creation time:
    expect(() => union({ bad: BadKind })).toThrowError(
      "claydo: kind 'bad' (class BadKind) defines a method " +
        "named 'name'. The stub reserves 'id', 'name', 'kind', 'stub' for " +
        "metadata, so this method would not be callable. Rename the method.",
    );
  });

  it("KindStub no longer types metadata keys as callable", async () => {
    const shard = kind(env.APP_DO, "shard").get("probe-meta-type");
    // stub.name is plain metadata now — string | undefined, not callable.
    const name: string | undefined = shard.name;
    expect(name).toBe("probe-meta-type");
    // @ts-expect-error TS2722: Cannot invoke an object which is possibly 'undefined'.
    void (() => shard.name());
  });
});

describe("probe: RPC return value serialization", () => {
  it("Map survives", async () => {
    const probe = kind(env.APP_DO, "probe").get("probe-serialize");
    const map = await probe.returnMap();
    expect(map).toBeInstanceOf(Map);
    expect(map.get("a")).toBe(1);
  });

  it("Date survives", async () => {
    const probe = kind(env.APP_DO, "probe").get("probe-serialize");
    const date = await probe.returnDate();
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).toBe(1_700_000_000_000);
  });

  it("ArrayBuffer survives", async () => {
    const probe = kind(env.APP_DO, "probe").get("probe-serialize");
    const buffer = await probe.returnBuffer();
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(new DataView(buffer).getUint32(0)).toBe(42);
  });

  it("a custom class instance fails at the RPC layer — now WITH kind+method context", async () => {
    const probe = kind(env.APP_DO, "probe").get("probe-serialize");
    let thrown: unknown;
    try {
      await probe.returnCustomClass();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // Fixed (was my issue #1): the transport failure is wrapped with the
    // kind and method name, and the original DataCloneError rides as `cause`.
    expect((thrown as Error).message).toBe(
      "claydo: call to probe.returnCustomClass() failed: " +
        'Could not serialize object of type "Widget". This type does not support serialization.',
    );
    const cause = (thrown as Error).cause as Error;
    expect(cause).toBeInstanceOf(Error);
    expect(cause.name).toBe("DataCloneError");
  });
});

describe("probe: typos and runtime kind names", () => {
  it("typo through `as any` fails at runtime with the library's error", async () => {
    const shard = kind(env.APP_DO, "shard").get("probe-typo");
    await expect((shard as any).isnert("probe-typo", "x")).rejects.toThrow(
      "claydo: kind 'shard' has no method 'isnert'.",
    );
    // Without `as any`, TS catches it (verbatim):
    // @ts-expect-error TS2551: Property 'isnert' does not exist on type 'KindStub<Shard>'. Did you mean 'insert'?
    void shard.isnert;
  });

  it("a runtime-built kind name is now typeable with KindNameOf (no lying cast)", async () => {
    const dynamic: string = ["sha", "rd"].join("");
    // A bare string is still rejected — and still with the opaque alias
    // (verbatim; kind() itself did NOT gain better diagnostics, kinds() did):
    // @ts-expect-error TS2345: Argument of type 'string' is not assignable to parameter of type 'KindNameOf<DurableObjectNamespace<LiveTableDO>>'.
    kind(env.APP_DO, dynamic);
    // Fixed (was my issue #4): the sanctioned spelling — one honest cast to
    // the exported name union, then narrow:
    const k = dynamic as KindNameOf<typeof env.APP_DO>;
    if (k !== "shard") throw new Error("routing bug");
    const shard = kind(env.APP_DO, k).get("probe-dynamic");
    await shard.insert("probe-dynamic", "dyn");
    expect(await shard.list("probe-dynamic")).toHaveLength(1);
  });

  it("an unregistered runtime kind name fails with the kind list AND the instance identity", async () => {
    const nope = kind(env.APP_DO, "coutner" as "probe").get("x");
    await expect(nope.echoLength("hi")).rejects.toThrow(
      "claydo: unknown kind 'coutner' on instance 'coutner:x'. " +
        "Registered kinds: shard, session, probe.",
    );
  });

  it("kinds() gives property-access dispatch with good diagnostics", async () => {
    const app = kinds(env.APP_DO);
    await app.shard.get("probe-kinds").insert("probe-kinds", "via-kinds");
    expect(await app.session.get("probe-kinds").recent()).toEqual([]);
    expect(await app.shard.get("probe-kinds").list("probe-kinds")).toHaveLength(1);
    // A typo'd kind is now a property error with a fix-it:
    // @ts-expect-error TS2551: Property 'shrad' does not exist on type '{ shard: KindAccessor<Shard>; session: KindAccessor<Session>; probe: KindAccessor<Probe>; }'. Did you mean 'shard'?
    void app.shrad;
  });
});

describe("probe: big payloads (~100KB)", () => {
  const big = "x".repeat(100_000);

  it("100KB through RPC (argument and return)", async () => {
    const probe = kind(env.APP_DO, "probe").get("probe-big");
    expect(await probe.echoLength(big)).toBe(100_000);
    const shard = kind(env.APP_DO, "shard").get("probe-big-room");
    await shard.insert("probe-big-room", big);
    const rows = await shard.list("probe-big-room");
    expect(rows[0]!.body.length).toBe(100_000);
  });

  it("100KB delta through a WebSocket subscriber", async () => {
    const shard = kind(env.APP_DO, "shard").get("probe-big-ws");
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
    await shard.insert("probe-big-ws", big);
    expect((await delta).body.length).toBe(100_000);
    ws.close();
  });
});
