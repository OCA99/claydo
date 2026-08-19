/**
 * Adversarial DX probes, updated after the library's post-audit changes.
 * Each test deliberately misuses the library and asserts the observed
 * behavior. Verbatim messages are quoted in ../DX-REPORT.md (§3 for the
 * original audit, §6 for the post-fix verification).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kind } from "../../../src/index";
import { connect } from "./helpers";

describe("rpc error propagation", () => {
  it("FIXED: an Error thrown in an RPC method keeps stack, fields, and message", async () => {
    const doc = kind(env.APP_DO, "doc").get("rpc-throw");
    const error = (await doc
      .applyOp({ type: "insert", pos: 999, text: "x" })
      .catch((e: Error) => e)) as Error & { code?: string; pos?: number };
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("Error");
    expect(error.message).toBe(
      "collab-doc: insert position 999 out of range 0..0",
    );
    // Own enumerable serializable fields survive the hop.
    expect(error.code).toBe("E_RANGE");
    expect(error.pos).toBe(999);
    // The remote stack survives: it points at the kind code that threw...
    expect(error.stack).toContain("collab-doc/worker.ts");
    // ...followed by the boundary marker...
    expect(error.stack).toContain(
      "at [remote call doc.applyOp() via claydo]",
    );
    // ...followed by local frames (this test file).
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
    // Still observed post-update: the client gets NOTHING — no error frame,
    // no close event — and the connection keeps working. The improvement is
    // server-side only: the host now console.errors with kind + instance
    // context ("webSocketMessage() failed on kind 'doc' instance
    // 'doc:boom'") before rethrowing.
    client.ws.send(JSON.stringify({ type: "insert", pos: 0, text: "next" }));
    expect(await client.next()).toEqual({ type: "ack", seq: 1 });
    expect(client.events).toEqual([]);
    client.close();
  });
});

describe("serialization limits", () => {
  it("IMPROVED: unserializable return values fail with call context and a cause", async () => {
    const doc = kind(env.APP_DO, "doc").get("handle");
    const error = (await doc.getHandle().catch((e: Error) => e)) as Error & {
      cause?: Error;
    };
    expect(error).toBeInstanceOf(Error);
    // The bare DataCloneError is now wrapped with kind + method context.
    expect(error.name).toBe("Error");
    expect(error.message).toBe(
      "claydo: call to doc.getHandle() failed: " +
        'Could not serialize object of type "SnapshotHandle". ' +
        "This type does not support serialization.",
    );
    // The original error is preserved as the cause.
    expect(error.cause?.name).toBe("DataCloneError");
  });

  it("does NOT fail when an RPC method returns a function: it becomes an RPC stub", async () => {
    const doc = kind(env.APP_DO, "doc").get("callback");
    // Unchanged after the update: workerd RPC serializes functions as
    // callable stubs, so this resolves instead of rejecting.
    const result = await doc.getCallback();
    expect(typeof result).toBe("function");
    // The stub is even callable across the RPC boundary.
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
