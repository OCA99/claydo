import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import { connect } from "./helpers";

describe("rpc error propagation", () => {
  it("an Error thrown in an RPC method keeps stack, fields, and message", async () => {
    const doc = kind(env.APP_DO, "doc").get("rpc-throw");
    const error = (await doc
      .applyOp({ type: "insert", pos: 999, text: "x" })
      .catch((e: Error) => e)) as Error & { code?: string; pos?: number };
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("Error");
    expect(error.message).toBe(
      "collab-doc: insert position 999 out of range 0..0",
    );
    expect(error.code).toBe("E_RANGE");
    expect(error.pos).toBe(999);
    expect(error.stack).toContain("collab-doc/worker.ts");
    expect(error.stack).toContain(
      "at [remote call doc.applyOp() via claydo]",
    );
    expect(error.stack).toContain("probes.test.ts");
  });

  it("rejects a typo'd method name at runtime", async () => {
    const doc = kind(env.APP_DO, "doc").get("typo");
    await expect((doc as any).getTxt()).rejects.toThrow(
      "claydo: kind 'doc' has no method 'getTxt'.",
    );
  });
});

describe("websocket error propagation", () => {
  it("shows what an uncaught throw in webSocketMessage looks like", async () => {
    const client = await connect("boom");
    await client.next(); // init
    client.ws.send(JSON.stringify({ type: "boom" }));
    client.ws.send(JSON.stringify({ type: "insert", pos: 0, text: "next" }));
    expect(await client.next()).toEqual({ type: "ack", seq: 1 });
    expect(client.events).toEqual([]);
    client.close();
  });
});

describe("serialization limits", () => {
  it("unserializable return values fail with call context and a cause", async () => {
    const doc = kind(env.APP_DO, "doc").get("handle");
    const error = (await doc.getHandle().catch((e: Error) => e)) as Error & {
      cause?: Error;
    };
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("Error");
    expect(error.message).toBe(
      "claydo: call to doc.getHandle() failed: " +
        'Could not serialize object of type "SnapshotHandle". ' +
        "This type does not support serialization.",
    );
    expect(error.cause?.name).toBe("DataCloneError");
  });

  it("does NOT fail when an RPC method returns a function: it becomes an RPC stub", async () => {
    const doc = kind(env.APP_DO, "doc").get("callback");
    const result = await doc.getCallback();
    expect(typeof result).toBe("function");
    await expect(
      (result as unknown as () => Promise<unknown>)(),
    ).resolves.toBeUndefined();
  });
});

describe("instanceName in the constructor", () => {
  it("reports what instanceName(ctx) returned during construction", async () => {
    const doc = kind(env.APP_DO, "doc").get("ctor-probe");
    const probe = await doc.constructorNameProbe();
    expect(probe).toBe("value: ctor-probe");
  });
});
