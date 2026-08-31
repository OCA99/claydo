import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getServerByName, routePartykitRequest } from "partyserver";
import { kind, kinds, union } from "../../../src/index";
import { Chat } from "../worker";
import { connect } from "./helpers";

describe("stub misuse", () => {
  it("rejects a typo'd method name at runtime", async () => {
    const limiter = kind(env.APP_DO, "limiter").get("typo-probe");
    await expect((limiter as any).consme()).rejects.toThrow(
      "claydo: kind 'limiter' has no method 'consme'.",
    );
  });

  it("returns a function (not undefined) for ANY unknown property", async () => {
    const limiter = kind(env.APP_DO, "limiter").get("property-probe");
    expect(typeof (limiter as any).consme).toBe("function");
    expect(typeof (limiter as any).definitelyNotAMethod).toBe("function");
  });

  it("calling a plain property explains itself", async () => {
    const limiter = kind(env.APP_DO, "limiter").get("plain-prop-probe");
    await expect((limiter as any).windowMs()).rejects.toThrow(
      "claydo: 'windowMs' on kind 'limiter' is a property, " +
        "not a method (type: number). The stub only proxies methods; " +
        "add a getter method to read it.",
    );
  });

  it("rejects a kind name that is not in the registry, naming the instance", async () => {
    const nope = kind(env.APP_DO as any, "mailer").get("x");
    await expect((nope as any).send()).rejects.toThrow(
      "claydo: unknown kind 'mailer' on instance 'mailer:x'. " +
        "Registered kinds: chat, limiter.",
    );
  });

  it("kinds() accessor reaches the same instances as kind()", async () => {
    await kinds(env.APP_DO).limiter.get("accessor-probe").consume();
    const viaKind = kind(env.APP_DO, "limiter").get("accessor-probe");
    expect((await viaKind.peek()).used).toBe(1);
  });
});

describe("kind identity", () => {
  it("rejects fromId() access through the wrong kind on an initialized instance", async () => {
    const limiter = kind(env.APP_DO, "limiter").get("locked-user");
    await limiter.consume();
    const wrong = kind(env.APP_DO, "chat").fromId(limiter.id);
    await expect(wrong.roomInfo()).rejects.toThrow(
      "claydo: instance 'limiter:locked-user' is kind " +
        "'limiter', but the caller expected kind 'chat'.",
    );
  });

  it("fromId() never initializes an untouched unique() instance", async () => {
    const intended = kind(env.APP_DO, "limiter").unique();
    const impostor = kind(env.APP_DO, "chat").fromId(intended.id);
    const noKindMessage =
      `claydo: instance '${intended.id.toString()}' has no ` +
      "kind yet. It was accessed as kind 'chat' through fromId(), which " +
      "never initializes an instance. Create the instance first with " +
      "kind(ns, 'chat').get(name) or .unique(), then reach it by id.";
    await expect(impostor.roomInfo()).rejects.toThrow(noKindMessage);

    const response = await impostor.fetch("https://do/");
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(noKindMessage);

    expect((await intended.consume()).allowed).toBe(true);
    const later = kind(env.APP_DO, "limiter").fromId(intended.id.toString());
    expect((await later.peek()).used).toBe(1);
  });
});

describe("error propagation", () => {
  it("swallows a throw inside a PartyServer onMessage handler (console only)", async () => {
    const client = await connect("throw-room", "thrower");
    await client.next(); // welcome
    client.ws.send("/throw"); // Chat.onMessage throws an Error here.
    client.ws.send("still alive");
    expect(await client.next()).toMatchObject({
      type: "chat",
      text: "still alive",
    });
    client.close();
  });

  it("cross-kind RPC errors carry the remote stack plus a marker line", async () => {
    const wrong = kind(env.APP_DO, "chat").fromId(
      kind(env.APP_DO, "limiter").idFromName("stack-probe"),
    );
    await kind(env.APP_DO, "limiter").get("stack-probe").consume();
    const error = (await wrong.roomInfo().catch((e: Error) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toContain("src/host.ts");
    expect(error.stack).toContain(
      "at [remote call chat.roomInfo() via claydo]",
    );
    expect(error.stack).toContain("probes.test.ts");
  });
});

describe("reserved names", () => {
  it("union() rejects kind classes that define reserved stub methods", () => {
    class BadKind {
      constructor(_ctx: DurableObjectState, _env: unknown) {}
      name(): string {
        return "x";
      }
    }
    expect(() => union({ bad: BadKind })).toThrow(
      "claydo: kind 'bad' (class BadKind) defines a method " +
        "named 'name'. The stub reserves 'id', 'name', 'kind', 'stub' for " +
        "metadata, so this method would not be callable. Rename the method.",
    );
    expect(() => union({ chat: Chat })).not.toThrow();
  });
});

describe("partyserver ecosystem integration", () => {
  it("routePartykitRequest works ONLY with a kind-prefixed room name in the URL", async () => {
    const request = new Request(
      "https://example.com/parties/app-do/chat:pk-room?_pk=pk-user",
      { headers: { Upgrade: "websocket" } },
    );
    const response = await routePartykitRequest(request, env as any);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(101);
    const ws = response!.webSocket!;
    const welcome = new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) => resolve(event.data as string));
    });
    ws.accept();
    expect(JSON.parse(await welcome)).toMatchObject({
      type: "welcome",
      room: "chat:pk-room",
      users: ["pk-user"],
    });
    ws.close();
  });

  it("routePartykitRequest without the kind prefix yields an explanatory 400", async () => {
    const request = new Request(
      "https://example.com/parties/app-do/plain-room?_pk=pk-user2",
      { headers: { Upgrade: "websocket" } },
    );
    const response = await routePartykitRequest(request, env as any);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
    expect(await response!.text()).toBe(
      "claydo: instance 'plain-room' has no kind yet. " +
        "Its name has no registered '<kind>:' prefix. Raw namespace access " +
        "(for example getByName('plain-room')) reaches a different instance " +
        "than kind(ns, '<kind>').get('plain-room'). Access instances through " +
        "the kind() helper, or use a '<kind>:' prefixed name.",
    );
  });

  it("getServerByName fails with directions to the kind() helper", async () => {
    const error = await getServerByName(env.APP_DO as any, "chat:gsn-room")
      .then(() => undefined)
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/getServerByName/);
    expect(error!.message).toMatch(/kind\(ns, '<kind>'\)\.get\(name\)/);
  });
});
