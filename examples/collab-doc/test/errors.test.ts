import { describe, expect, it } from "vitest";
import { isClaydoError } from "../../../src/index";
import { app } from "./helpers";

describe("error handling over RPC", () => {
  it("delivers kind errors with message and structured fields", async () => {
    const doc = app.doc.get("rpc-throw");
    const error = (await doc
      .applyOp({ type: "insert", pos: 999, text: "x" })
      .catch((e: Error) => e)) as Error & { code?: string; pos?: number };
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("Error");
    expect(error.message).toBe(
      "collab-doc: insert position 999 out of range 0..0",
    );
    // Own enumerable serializable fields survive the RPC hop, so callers
    // can match on the app's error code.
    expect(error.code).toBe("E_RANGE");
    expect(error.pos).toBe(999);
    // App errors are not claydo errors.
    expect(isClaydoError(error)).toBe(false);
  });

  it("reports unknown method names with a ClaydoError code", async () => {
    const doc = app.doc.get("typo");
    const error = await (doc as unknown as { getTxt(): Promise<unknown> })
      .getTxt()
      .catch((e: unknown) => e);
    expect(isClaydoError(error)).toBe(true);
    if (isClaydoError(error)) {
      expect(error.code).toBe("CLAYDO_NO_METHOD");
      expect(error.message).toContain("getTxt");
    }
  });
});
