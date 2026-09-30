import {
  env,
  evictDurableObject,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { getServerByName, routePartykitRequest } from "partyserver";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { kindNamespace, kinds } from "../src/index";
import { caught } from "./helpers";

describe("native SDK compatibility", () => {
  it("makes the logical name available in the original class constructor", async () => {
    const room = await getServerByName(
      kindNamespace(env.APP_DO, "sdkConstructor"),
      "constructor:room",
      { props: { uid: "alice" } },
    );
    expect(await room.constructorName()).toBe("constructor:room");
  });
  it("lets setName deliver props before startup and exposes a logical name", async () => {
    const namespace = kindNamespace(env.APP_DO, "sdkParty");
    expect(await namespace.getByName("sdk:room").starts()).toBe(0);
    const room = await getServerByName(namespace, "sdk:room", {
      props: { uid: "alice" },
    });
    expect(await room.identity()).toEqual({ name: "sdk:room", owner: "alice" });
    expect(await room.starts()).toBe(1);
    const again = await getServerByName(namespace, "sdk:room", {
      props: { uid: "alice" },
    });
    expect(await again.starts()).toBe(1);
  });

  it("isolates SDK instances with the same name and retains Agents helper types", async () => {
    const a = await getAgentByName(
      kindNamespace(env.APP_DO, "mcp"),
      "streamable-http:sdk-shared",
      { props: { uid: "alice" } },
    );
    const b = await getServerByName(
      kindNamespace(env.APP_DO, "sdkOther"),
      "sdk-shared",
      { props: { uid: "bob" } },
    );
    expect(a.id.equals(b.id)).toBe(false);
    expect(await b.identity()).toEqual({ name: "sdk-shared", owner: "bob" });
  });

  it("preserves logical names after an ID-based cold start", async () => {
    const namespace = kindNamespace(env.APP_DO, "sdkParty");
    const room = await getServerByName(namespace, "sdk-cold", {
      props: { uid: "alice" },
    });
    await runInDurableObject(env.APP_DO.get(room.id), (_instance, ctx) => {
      ctx.facets.abort("sdkParty", "test cold facet");
    });
    await evictDurableObject(env.APP_DO.get(room.id));
    const fresh = kindNamespace(env.APP_DO, "sdkParty");
    const restored = fresh.get(fresh.idFromString(room.id.toString()));
    await restored.setName("sdk-cold", { uid: "alice" });
    expect(await restored.identity()).toEqual({
      name: "sdk-cold",
      owner: "alice",
    });
  });

  it("lets an original Agent receive authenticated props through its own startup", async () => {
    const agent = await getAgentByName(
      kindNamespace(env.APP_DO, "agent"),
      "agent:with:colons",
      { props: { uid: "alice" } },
    );
    expect(await agent.identity()).toEqual({
      name: "agent:with:colons",
      owner: "alice",
    });
  });

  it("supports SDK bootstrap of unique IDs", async () => {
    const namespace = kindNamespace(env.APP_DO, "sdkParty");
    const room = namespace.get(namespace.newUniqueId());
    await room.setName("unique-session", { uid: "alice" });
    expect(await room.identity()).toEqual({
      name: "unique-session",
      owner: "alice",
    });
  });

  it("keeps SDK validation for empty and mismatched names", async () => {
    const room = kindNamespace(env.APP_DO, "sdkParty").getByName(
      "sdk-validation",
    );
    expect(
      (await caught(room.setName("", { uid: "alice" }))).message,
    ).toContain("name");
    expect(
      (await caught(room.setName("different", { uid: "alice" }))).message,
    ).toContain("cannot setName");
  });

  it("gives original framework classes the native logical name", async () => {
    expect(
      await kinds(env.APP_DO).party.get("sdk-unadapted").storedName(),
    ).toBe("sdk-unadapted");
  });

  it("works with Sentry instrumentation around the original class", async () => {
    const room = await getServerByName(
      kindNamespace(env.APP_DO, "sdkWrapped"),
      "wrapped",
      { props: { uid: "alice" } },
    );
    expect(await room.identity()).toEqual({ name: "wrapped", owner: "alice" });
  });

  it("supports SDK fetch routing with startup props", async () => {
    const response = await routePartykitRequest(
      new Request("https://do/parties/rooms/sdk-fetch", {
        headers: { Upgrade: "websocket" },
      }),
      { ...env, rooms: kindNamespace(env.APP_DO, "sdkParty") },
      { props: { uid: "carol" } },
    );
    expect(response?.status).toBe(101);
    response!.webSocket!.accept();
    response!.webSocket!.close();
    expect(
      await kindNamespace(env.APP_DO, "sdkParty")
        .getByName("sdk-fetch")
        .identity(),
    ).toEqual({ name: "sdk-fetch", owner: "carol" });
  });

  it("initializes and reattaches an instrumented MCP session with authenticated props", async () => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const initialized = await SELF.fetch("https://do/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain("claydo-probe");
    const session = initialized.headers.get("mcp-session-id");
    expect(session).toBeTruthy();
    const namespace = kindNamespace(env.APP_DO, "mcp");
    const parent = env.APP_DO.get(
      namespace.idFromName(`streamable-http:${session}`),
    );
    await runInDurableObject(parent, (_instance, ctx) => {
      ctx.facets.abort("mcp", "test MCP cold facet");
    });
    await evictDurableObject(parent);
    const tool = await SELF.fetch("https://do/mcp", {
      method: "POST",
      headers: { ...headers, "mcp-session-id": session! },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "identity", arguments: {} },
      }),
    });
    expect(tool.status).toBe(200);
    const text = await tool.text();
    expect(text).toContain("test-owner");
    expect(text).toContain(`streamable-http:${session}`);
    expect(text).not.toContain(`mcp:streamable-http:${session}`);
  });
});
