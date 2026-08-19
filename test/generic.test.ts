import {
  createExecutionContext,
  env,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind, kinds, union } from "../src/index";
import worker from "./fixtures/worker";

describe("rpc dispatch", () => {
  it("calls kind methods through the typed stub", async () => {
    const counter = kind(env.APP_DO, "counter").get("rpc-basic");
    expect(await counter.increment(2)).toBe(2);
    expect(await counter.increment()).toBe(3);
    expect(await counter.value()).toBe(3);
  });

  it("persists SQLite state across stubs of the same instance", async () => {
    await kind(env.APP_DO, "counter").get("rpc-persist").increment(5);
    const again = kind(env.APP_DO, "counter").get("rpc-persist");
    expect(await again.value()).toBe(5);
  });

  it("exposes id, name, kind and the raw stub", async () => {
    const counter = kind(env.APP_DO, "counter").get("rpc-meta");
    expect(counter.kind).toBe("counter");
    expect(counter.name).toBe("rpc-meta");
    expect(counter.id.toString()).toBe(
      kind(env.APP_DO, "counter").idFromName("rpc-meta").toString(),
    );
    expect(counter.stub).toBeDefined();
  });

  it("strips the kind prefix in instanceName()", async () => {
    const counter = kind(env.APP_DO, "counter").get("who-am-i");
    expect(await counter.whoAmI()).toBe("who-am-i");
  });
});

describe("kind isolation", () => {
  it("maps the same logical name under different kinds to different instances", async () => {
    const a = kind(env.APP_DO, "counter").idFromName("shared");
    const b = kind(env.APP_DO, "plain").idFromName("shared");
    expect(a.toString()).not.toBe(b.toString());
  });

  it("rejects access through the wrong kind", async () => {
    const counter = kind(env.APP_DO, "counter").get("locked");
    await counter.increment();
    const wrong = kind(env.APP_DO, "plain").fromId(counter.id);
    await expect(wrong.ping()).rejects.toThrow(
      /is kind 'counter', but the caller expected kind 'plain'/,
    );
  });

  it("rejects unknown kinds", async () => {
    const nope = kind(env.APP_DO as any, "nope").get("x");
    await expect((nope as any).ping()).rejects.toThrow(/unknown kind 'nope'/);
  });

  it("reports no kind for untouched unique-id instances", async () => {
    const raw = env.APP_DO.get(env.APP_DO.newUniqueId());
    expect(await raw.__gdoKind()).toBeUndefined();
    const response = await raw.fetch("https://do/");
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/has no kind yet/);
  });

  it("never initializes an instance through fromId()", async () => {
    const untouched = env.APP_DO.newUniqueId();
    const stub = kind(env.APP_DO, "counter").fromId(untouched);
    await expect(stub.increment()).rejects.toThrow(
      /fromId\(\), which never initializes/,
    );
    // The failed access did not pin any kind.
    const raw = env.APP_DO.get(env.APP_DO.idFromString(untouched.toString()));
    expect(await raw.__gdoKind()).toBeUndefined();
    // fetch() through a fromId() stub does not initialize either.
    const response = await kind(env.APP_DO, "echo")
      .fromId(untouched)
      .fetch("https://do/");
    expect(response.status).toBe(400);
  });

  it("explains raw namespace access without a prefix", async () => {
    const raw = env.APP_DO.get(env.APP_DO.idFromName("no-prefix-here"));
    const response = await raw.fetch("https://do/");
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(
      /Raw namespace access .* reaches a different instance/,
    );
  });
});

describe("kinds() accessor", () => {
  it("provides property access per kind", async () => {
    const app = kinds(env.APP_DO);
    expect(await app.counter.get("via-kinds").increment(3)).toBe(3);
    expect(await app.plain.get("via-kinds").ping()).toBe("pong");
  });
});

describe("union() validation", () => {
  it("rejects kind classes with reserved method names", () => {
    class BadKind {
      constructor(_ctx: DurableObjectState, _env: unknown) {}
      name(): string {
        return "clash";
      }
    }
    expect(() => union({ bad: BadKind })).toThrow(
      /defines a method named 'name'/,
    );
  });
});

describe("error fidelity", () => {
  it("preserves name, fields, and remote stack of thrown errors", async () => {
    const teapot = kind(env.APP_DO, "teapot").get("kettle");
    let caught: unknown;
    try {
      await teapot.explode();
    } catch (error) {
      caught = error;
    }
    const error = caught as Error & {
      status?: number;
      detail?: { hint: string };
    };
    expect(error.name).toBe("TeapotError");
    expect(error.message).toBe("I am a teapot");
    expect(error.status).toBe(418);
    expect(error.detail).toEqual({ hint: "short and stout" });
    expect(error.stack).toContain("explode");
    expect(error.stack).toContain(
      "[remote call teapot.explode() via generic-durable-objects]",
    );
  });

  it("distinguishes properties from missing methods", async () => {
    const plain = kind(env.APP_DO, "plain").get("props");
    await plain.ping();
    await expect((plain as any).label()).rejects.toThrow(
      /'label' on kind 'plain' is a property, not a method/,
    );
  });
});

describe("resetStorage()", () => {
  it("clears data but keeps the kind pinned on unique instances", async () => {
    const vault = kind(env.APP_DO, "vault").unique();
    await vault.set("k", "v");
    expect(await vault.getValue("k")).toBe("v");
    await vault.wipe();
    expect(await vault.getValue("k")).toBeUndefined();
    const raw = env.APP_DO.get(env.APP_DO.idFromString(vault.id.toString()));
    expect(await raw.__gdoKind()).toBe("vault");
  });
});

describe("kind resolution", () => {
  it("resolves the kind from the name prefix on raw access", async () => {
    const counter = kind(env.APP_DO, "counter").get("from-name");
    await counter.increment(7);
    // Access the same instance without the client helper.
    const raw = env.APP_DO.get(env.APP_DO.idFromName("counter:from-name"));
    expect(await raw.__gdoKind()).toBe("counter");
  });

  it("initializes unique-id instances from the call hint and pins the kind", async () => {
    const counter = kind(env.APP_DO, "counter").unique();
    expect(await counter.increment(4)).toBe(4);
    // The kind persists, so a raw stub resolves it from storage.
    const raw = env.APP_DO.get(env.APP_DO.idFromString(counter.id.toString()));
    expect(await raw.__gdoKind()).toBe("counter");
    // The same unique instance is reachable again through fromId().
    const again = kind(env.APP_DO, "counter").fromId(counter.id.toString());
    expect(await again.value()).toBe(4);
  });

  it("rejects reserved methods through the stub", async () => {
    const counter = kind(env.APP_DO, "counter").get("reserved");
    await expect(
      (counter as any).webSocketMessage("x"),
    ).rejects.toThrow(/reserved/);
    await expect((counter as any).__gdoCall("a", "b", [])).rejects.toThrow(
      /reserved/,
    );
    await expect((counter as any).missing()).rejects.toThrow(
      /has no method 'missing'/,
    );
  });
});

describe("fetch and websockets", () => {
  it("forwards fetch() to the kind implementation", async () => {
    const echo = kind(env.APP_DO, "echo").get("http");
    const response = await echo.fetch("https://do/hello");
    expect(await response.text()).toBe("echo:/hello");
  });

  it("returns 501 when the kind has no fetch()", async () => {
    const plain = kind(env.APP_DO, "plain").get("no-fetch");
    const response = await plain.fetch("https://do/");
    expect(response.status).toBe(501);
  });

  it("forwards hibernating WebSocket events", async () => {
    const echo = kind(env.APP_DO, "echo").get("ws");
    const response = await echo.fetch("https://do/ws", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    const reply = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) =>
        resolve(event.data as string),
      );
      ws.send("hi");
    });
    expect(reply).toBe("echo:hi");
    ws.close();
  });
});

describe("alarms", () => {
  it("forwards alarm() to the kind implementation", async () => {
    const reminder = kind(env.APP_DO, "reminder").get("alarm-1");
    await reminder.remind("water the plants");
    const ran = await runDurableObjectAlarm(
      env.APP_DO.get(env.APP_DO.idFromName("reminder:alarm-1")),
    );
    expect(ran).toBe(true);
    expect(await reminder.fired()).toBe("fired:water the plants");
  });
});

describe("third-party kinds (partyserver)", () => {
  it("hosts a PartyServer Server as a kind", async () => {
    const room = kind(env.APP_DO, "party").get("lobby");
    const response = await room.fetch("https://do/", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    const reply = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) =>
        resolve(event.data as string),
      );
      ws.send("hello");
    });
    expect(reply).toBe("party[party:lobby]:hello");
    ws.close();
  });
});

describe("worker end to end", () => {
  it("serves requests that use the client helper", async () => {
    const ctx = createExecutionContext();
    const request = new Request("https://example.com/counter/e2e");
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await response.json()).toEqual({ value: 1 });
  });
});
