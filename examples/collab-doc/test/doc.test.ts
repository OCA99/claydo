import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../worker";
import { app, connect } from "./helpers";

/** Polls until `ok` accepts the read value, or the deadline passes. */
async function eventually<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("collaborative document", () => {
  it("converges two WebSocket clients through op broadcast", async () => {
    const a = await connect("conv");
    expect(await a.next()).toEqual({ type: "init", text: "" });
    const b = await connect("conv");
    expect(await b.next()).toEqual({ type: "init", text: "" });

    a.ws.send(JSON.stringify({ type: "insert", pos: 0, text: "hello" }));
    expect(await a.next()).toEqual({ type: "ack", seq: 1 });
    expect(await b.next()).toEqual({
      type: "op",
      seq: 1,
      op: { type: "insert", pos: 0, text: "hello" },
    });

    b.ws.send(JSON.stringify({ type: "insert", pos: 5, text: " world" }));
    expect(await b.next()).toEqual({ type: "ack", seq: 2 });
    expect(await a.next()).toEqual({
      type: "op",
      seq: 2,
      op: { type: "insert", pos: 5, text: " world" },
    });

    expect(await app.doc.get("conv").getText()).toBe("hello world");
    a.close();
    b.close();
  });

  it("applies deletes and reports stats over RPC", async () => {
    const doc = app.doc.get("stats");
    await doc.applyOp({ type: "insert", pos: 0, text: "abcdef" });
    await doc.applyOp({ type: "delete", pos: 1, len: 3 });
    expect(await doc.getText()).toBe("aef");
    expect(await doc.getStats()).toEqual({
      opCount: 2,
      snapshotVersion: 0,
      textLength: 3,
      alarmScheduled: true,
    });
  });

  it("persists ops across stub recreation", async () => {
    await app.doc
      .get("persist")
      .applyOp({ type: "insert", pos: 0, text: "durable" });
    // A brand-new accessor and stub must observe the same state.
    const fresh = app.doc.get("persist");
    expect(await fresh.getText()).toBe("durable");
    expect((await fresh.getStats()).opCount).toBe(1);
  });

  it("compacts the op log into a snapshot when the alarm fires", async () => {
    const doc = app.doc.get("compact");
    await doc.applyOp({ type: "insert", pos: 0, text: "state" });
    await doc.applyOp({ type: "insert", pos: 5, text: "ful" });
    expect(await doc.getStats()).toMatchObject({
      opCount: 2,
      snapshotVersion: 0,
      alarmScheduled: true,
    });

    // Pull the compaction alarm forward and wait for it to fire.
    await doc.compactNow();
    const compacted = await eventually(
      () => doc.getStats(),
      (stats) => stats.snapshotVersion === 1,
    );
    expect(compacted).toEqual({
      opCount: 0,
      snapshotVersion: 1,
      textLength: 8,
      alarmScheduled: false,
    });
    expect(await doc.getText()).toBe("stateful");

    // New ops after compaction keep working and reschedule the alarm.
    await doc.applyOp({ type: "insert", pos: 8, text: "!" });
    expect(await doc.getStats()).toMatchObject({
      opCount: 1,
      snapshotVersion: 1,
      alarmScheduled: true,
    });
  });

  it("pushes RPC-applied ops to connected WebSocket clients", async () => {
    const client = await connect("live");
    expect(await client.next()).toEqual({ type: "init", text: "" });
    await app.doc
      .get("live")
      .applyOp({ type: "insert", pos: 0, text: "from rpc" });
    expect(await client.next()).toEqual({
      type: "op",
      seq: 1,
      op: { type: "insert", pos: 0, text: "from rpc" },
    });
    client.close();
  });

  it("rejects invalid ops on the WebSocket path with an error frame", async () => {
    const client = await connect("invalid-ws");
    await client.next(); // init
    client.ws.send(JSON.stringify({ type: "insert", pos: 99, text: "x" }));
    expect(await client.next()).toEqual({
      type: "error",
      message: "collab-doc: insert position 99 out of range 0..0",
    });
    client.ws.send("this is not json");
    expect(await client.next()).toEqual({
      type: "error",
      message: "invalid JSON",
    });
    client.close();
  });

  it("serves document reads end to end through the worker", async () => {
    await app.doc
      .get("e2e")
      .applyOp({ type: "insert", pos: 0, text: "via worker" });
    const ctx = createExecutionContext();
    const request = new Request("https://example.com/doc/e2e");
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await response.json()).toEqual({ text: "via worker" });
  });
});
