import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getServerByName, routePartykitRequest } from "partyserver";
import { isClaydoError, kinds } from "../../../src/index";
import type { ClaydoError } from "../../../src/index";
import { connect } from "./helpers";

const app = kinds(env.APP_DO);

async function caught(promise: Promise<unknown>): Promise<ClaydoError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(Error);
  return error as ClaydoError;
}

describe("stub misuse", () => {
  it("rejects a typo'd method name with CLAYDO_NO_METHOD", async () => {
    const limiter = app.limiter.get("typo") as unknown as {
      consme(): Promise<unknown>;
    };
    const error = await caught(limiter.consme());
    expect(isClaydoError(error)).toBe(true);
    expect(error.code).toBe("CLAYDO_NO_METHOD");
    expect(error.message).toContain("consme");
  });

  it("returns a callable (not undefined) for any unknown property", async () => {
    // The stub proxy cannot know which methods exist without a round trip,
    // so every unknown key looks like a function; the call itself rejects.
    const limiter = app.limiter.get("property") as unknown as Record<
      string,
      unknown
    >;
    expect(typeof limiter["consme"]).toBe("function");
    expect(typeof limiter["definitelyNotAMethod"]).toBe("function");
  });

  it("rejects a kind name that is not in the registry", async () => {
    const nope = (app as Record<string, any>)["mailer"].get("x");
    const error = await caught(nope.send());
    expect(error.code).toBe("CLAYDO_UNKNOWN_KIND");
    expect(error.message).toContain("chat, limiter");
  });
});

describe("kind identity", () => {
  it("rejects fromId() access through the wrong kind", async () => {
    const limiter = app.limiter.get("locked-user");
    await limiter.consume();
    const wrong = app.chat.fromId(limiter.id);
    const error = await caught(wrong.roomInfo());
    expect(error.code).toBe("CLAYDO_KIND_MISMATCH");
    // Custom own fields on errors survive the RPC hop.
    expect((error as ClaydoError & { actualKind?: string }).actualKind).toBe(
      "limiter",
    );
    expect(
      (error as ClaydoError & { expectedKind?: string }).expectedKind,
    ).toBe("chat");
  });

  it("fromId() never initializes an untouched unique() instance", async () => {
    const intended = app.limiter.unique();
    const impostor = app.chat.fromId(intended.id);
    const error = await caught(impostor.roomInfo());
    expect(error.code).toBe("CLAYDO_UNINITIALIZED");
    expect(error.message).toContain("fromId()");

    // fetch() through a fromId() stub refuses to initialize too.
    const response = await impostor.fetch("https://do/");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("has no kind yet");

    // The intended kind still owns first contact...
    expect((await intended.consume()).allowed).toBe(true);
    // ...and once initialized, fromId() under the right kind works.
    const later = app.limiter.fromId(intended.id.toString());
    expect((await later.peek()).used).toBe(1);
  });
});

describe("partyserver ecosystem integration", () => {
  it("routePartykitRequest works with a kind-prefixed room name in the URL", async () => {
    // routePartykitRequest resolves the room by idFromName(), so the room
    // segment must be the full instance name "<kind>:<name>".
    const request = new Request(
      "https://example.com/parties/app-do/chat:pk-room?_pk=pk-user",
      { headers: { Upgrade: "websocket" } },
    );
    const response = await routePartykitRequest(request, env as never);
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

  it("routePartykitRequest without the kind prefix fails with guidance", async () => {
    const request = new Request(
      "https://example.com/parties/app-do/plain-room?_pk=pk-user2",
      { headers: { Upgrade: "websocket" } },
    );
    const response = await routePartykitRequest(request, env as never);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);
    expect(await response!.text()).toContain("kind() helper");
  });

  it("getServerByName fails with directions to the kind() helper", async () => {
    // getServerByName() addresses instances without the kind prefix, so a
    // claydo union rejects it and points at the supported accessors.
    const error = await getServerByName(env.APP_DO as never, "chat:gsn-room")
      .then(() => undefined)
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/getServerByName/);
    expect(error!.message).toMatch(/kind\(ns, '<kind>'\)\.get\(name\)/);
  });
});

describe("websocket sessions and stub errors coexist", () => {
  it("keeps a connection usable after a failed RPC on the same room", async () => {
    const client = await connect("resilient", "pat");
    await client.next(); // welcome
    const room = app.chat.get("resilient") as unknown as {
      noSuchMethod(): Promise<unknown>;
    };
    const error = await caught(room.noSuchMethod());
    expect(error.code).toBe("CLAYDO_NO_METHOD");
    client.ws.send("still alive");
    expect(await client.next()).toMatchObject({
      type: "chat",
      text: "still alive",
    });
    client.close();
  });
});
