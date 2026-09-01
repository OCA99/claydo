import {
  createExecutionContext,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
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
    expect(await raw.__claydoKind()).toBeUndefined();
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
    expect(await raw.__claydoKind()).toBeUndefined();
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

describe("facet storage isolation", () => {
  it("keeps user SQL and KV out of supervisor storage", async () => {
    const counter = kind(env.APP_DO, "counter").get("facet-isolation");
    await counter.increment(9);
    await runInDurableObject(counter.stub, async (_instance, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE '_cf_%'`,
        )
        .toArray()
        .map((row) => row.name);
      expect(tables).not.toContain("counters");
      expect([...((await state.storage.list()).keys())]).toEqual([
        "__claydo:kind",
      ]);
    });
    // The isolated facet still owns and serves the data.
    expect(await counter.value()).toBe(9);
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
    for (const method of ["then", "ctx", "env"] as const) {
      class ReservedKind {
        [method](): void {}
      }
      expect(() => union({ reserved: ReservedKind })).toThrow(
        new RegExp(`defines a method named '${method}'`),
      );
    }
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
      "[remote call teapot.explode() via claydo]",
    );
  });

  it("distinguishes properties from missing methods", async () => {
    const plain = kind(env.APP_DO, "plain").get("props");
    await plain.ping();
    await expect((plain as any).label()).rejects.toThrow(
      /'label' on kind 'plain' is a property, not a method/,
    );
    await expect(plain.fieldFunction()).rejects.toThrow(
      /function-valued instance field, not a prototype method/,
    );
  });

  it("skips throwing error getters while preserving safe fields", async () => {
    const teapot = kind(env.APP_DO, "teapot").get("hostile-error");
    let caught: unknown;
    try {
      await teapot.explodeWithThrowingField();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: "still serializable",
      code: "SAFE_CODE",
    });
    expect((caught as Record<string, unknown>).hostile).toBeUndefined();
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
    expect(await raw.__claydoKind()).toBe("vault");
  });

  it("does not delete the facet before the resetting method returns", async () => {
    const vault = kind(env.APP_DO, "vault").get("reset-finish");
    await vault.set("k", "v");
    expect(await vault.wipeAndFinishWork()).toBe("finished");
    expect(await vault.getValue("k")).toBeUndefined();
  });

  it("makes cleared state visible to concurrent calls", async () => {
    const vault = kind(env.APP_DO, "vault").get("reset-race");
    await vault.set("k", "v");
    const resetting = vault.wipeAndFinishWork();
    await scheduler.wait(5);
    const racingRead = vault.getValue("k");
    expect(await resetting).toBe("finished");
    expect(await racingRead).toBeUndefined();
  });

  it("preserves writes and alarms made after deleteAll()", async () => {
    const vault = kind(env.APP_DO, "vault").get("reset-post-write");
    await vault.set("old", "gone");
    await vault.wipeThenWrite();
    expect(await vault.getValue("old")).toBeUndefined();
    expect(await vault.getValue("epoch")).toBe("2");
    expect(await vault.alarmTime()).toBeTypeOf("number");
  });

  it("resets foreign-key schemas atomically without partial drops", async () => {
    const vault = kind(env.APP_DO, "vault").get("reset-foreign-keys");
    await vault.seedForeignKeys();
    expect(await vault.userTables()).toEqual(["a_parent", "z_child"]);
    await vault.wipe();
    expect(await vault.userTables()).toEqual([]);
  });
});

describe("kind resolution", () => {
  it("resolves the kind from the name prefix on raw access", async () => {
    const counter = kind(env.APP_DO, "counter").get("from-name");
    await counter.increment(7);
    // Access the same instance without the client helper.
    const raw = env.APP_DO.get(env.APP_DO.idFromName("counter:from-name"));
    expect(await raw.__claydoKind()).toBe("counter");
  });

  it("initializes unique-id instances from the call hint and pins the kind", async () => {
    const counter = kind(env.APP_DO, "counter").unique();
    expect(await counter.increment(4)).toBe(4);
    // The kind persists, so a raw stub resolves it from storage.
    const raw = env.APP_DO.get(env.APP_DO.idFromString(counter.id.toString()));
    expect(await raw.__claydoKind()).toBe("counter");
    // The same unique instance is reachable again through fromId().
    const again = kind(env.APP_DO, "counter").fromId(counter.id.toString());
    expect(await again.value()).toBe(4);
  });

  it("rejects reserved methods through the stub", async () => {
    const counter = kind(env.APP_DO, "counter").get("reserved");
    await expect(
      (counter as any).webSocketMessage("x"),
    ).rejects.toThrow(/reserved/);
    await expect((counter as any).__claydoCall("a", "b", [])).rejects.toThrow(
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

  it("returns 500 when kind construction fails during fetch", async () => {
    const broken = kind(env.APP_DO, "brokenConstructor").get("fetch");
    const response = await broken.fetch("https://do/");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("claydo: kind request failed.");
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

  it("completes a facet reset requested by a WebSocket handler", async () => {
    const echo = kind(env.APP_DO, "echo").get("ws-reset");
    const response = await echo.fetch("https://do/ws", {
      headers: { Upgrade: "websocket" },
    });
    const ws = response.webSocket!;
    ws.accept();
    ws.send("reset");
    await vi.waitFor(
      async () => {
        expect(await echo.marker()).toBeUndefined();
      },
      { timeout: 2_000, interval: 10 },
    );
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

  it("adapts storage references captured during construction", async () => {
    const reminder = kind(env.APP_DO, "reminder").get("captured-alarm");
    await reminder.remindThroughCapturedStorage("captured");
    expect(await reminder.alarmTime()).toBeTypeOf("number");
    expect(
      await runDurableObjectAlarm(
        env.APP_DO.get(env.APP_DO.idFromName("reminder:captured-alarm")),
      ),
    ).toBe(true);
    expect(await reminder.fired()).toBe("fired:captured");
  });

  it("serializes AlarmInvocationInfo into the facet", async () => {
    const reminder = kind(env.APP_DO, "reminder").get("alarm-info");
    await reminder.remind("inspect info");
    await runInDurableObject(reminder.stub, async (instance) => {
      await instance.alarm!({
        isRetry: true,
        retryCount: 2,
        scheduledTime: 123456,
      });
    });
    expect(await reminder.alarmInfo()).toEqual({
      isRetry: true,
      retryCount: 2,
      scheduledTime: 123456,
    });
  });

  it("deleteAll preserves the pending supervisor alarm", async () => {
    const reminder = kind(env.APP_DO, "reminder").get("alarm-reset");
    await reminder.remind("must not fire");
    const scheduled = await reminder.alarmTime();
    await reminder.wipe();
    expect(await reminder.alarmTime()).toBe(scheduled);
  });

  it("rejects non-atomic alarm operations inside storage transactions", async () => {
    const reminder = kind(env.APP_DO, "reminder").get("alarm-transaction");
    await expect(reminder.alarmInsideTransaction()).rejects.toThrow(
      /alarm operations inside storage\.transaction\(\) cannot be atomic/,
    );
    await expect(reminder.outerAlarmInsideTransaction()).rejects.toThrow(
      /alarm operations inside storage\.transaction\(\) cannot be atomic/,
    );
    await expect(reminder.alarmInsideSyncTransaction()).rejects.toThrow(
      /alarm operations inside storage\.transactionSync\(\) cannot be atomic/,
    );
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

  it("initializes framework kinds on RPC-first access", async () => {
    // No fetch() has touched this instance: the host must run the
    // framework startup hook before dispatching the method.
    const room = kind(env.APP_DO, "party").get("rpc-first");
    expect(await room.roomName()).toBe("party:rpc-first");
  });

  it("rejects getServerByName/getAgentByName with directions", async () => {
    const raw = env.APP_DO.get(env.APP_DO.idFromName("party:lobby"));
    let message = "";
    try {
      await (
        raw as unknown as { setName(n: string): Promise<void> }
      ).setName("party:lobby");
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/getServerByName|getAgentByName/);
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
