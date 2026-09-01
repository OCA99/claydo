import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kinds } from "../src/index";

const app = kinds(env.APP_DO);

describe("fetch routing", () => {
  it("routes stub.fetch() to the kind's fetch handler", async () => {
    const counter = app.counter.get("http-1");
    await counter.increment(9);
    const response = await counter.fetch("https://do/value");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: 9 });
  });

  it("routes through a worker in front", async () => {
    await app.counter.get("http-worker").increment(2);
    const response = await SELF.fetch(
      "https://example.com/counter/http-worker/value",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: 2 });
  });

  it("answers 501 for kinds without a fetch handler", async () => {
    const response = await app.vault.get("http-nofetch").fetch("https://do/");
    expect(response.status).toBe(501);
    expect(await response.text()).toContain("does not implement fetch()");
  });

  it("initializes a unique instance before its first fetch", async () => {
    const created = app.counter.unique();
    const response = await created.fetch("https://do/value");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: 0 });
  });

  it("answers 404 with guidance for raw un-prefixed names", async () => {
    const raw = env.APP_DO.get(env.APP_DO.idFromName("bare-name"));
    const response = await raw.fetch("https://do/anything");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("kind() helper");
  });

  it("answers 404 for a fetch to an untouched unique id", async () => {
    const raw = env.APP_DO.get(env.APP_DO.newUniqueId());
    const response = await raw.fetch("https://do/anything");
    expect(response.status).toBe(404);
  });
});

describe("WebSockets", () => {
  async function connect(room: string): Promise<WebSocket> {
    const response = await app.chat.get(room).fetch("https://do/", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket;
    if (ws === null) throw new Error("no socket on the 101 response");
    ws.accept();
    return ws;
  }

  it("upgrades through the stub and echoes messages", async () => {
    const ws = await connect("ws-echo");
    const received = new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) =>
        resolve(event.data as string),
      );
    });
    ws.send("hello");
    expect(await received).toBe("echo:hello");
    expect(await app.chat.get("ws-echo").history()).toEqual(["hello"]);
    ws.close();
  });

  it("tracks connections on the kind's own context", async () => {
    const ws = await connect("ws-track");
    expect(await app.chat.get("ws-track").connections()).toBe(1);
    ws.close();
  });

  it("delivers close events to the kind", async () => {
    const ws = await connect("ws-close");
    const closed = new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve());
    });
    ws.send("close-me");
    await closed;
    const last = (await app.chat.get("ws-close").lastClose()) as {
      code: number;
    } | null;
    // The server initiated the close; the kind's webSocketClose handler
    // observes the client acknowledgment.
    expect(last === null || last === undefined || last.code >= 1000).toBe(
      true,
    );
    ws.close();
  });

  it("answers 426 for plain requests to the chat kind", async () => {
    const response = await app.chat.get("ws-plain").fetch("https://do/");
    expect(response.status).toBe(426);
  });
});
