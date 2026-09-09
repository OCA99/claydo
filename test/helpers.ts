import { expect } from "vitest";
import type { ClaydoError } from "../src/index";

/**
 * Awaits a rejection with a synchronously attached handler.
 * `expect(...).rejects` attaches its handler late enough that
 * vitest-pool-workers reports RPC rejections as unhandled errors.
 */
export async function caught(promise: Promise<unknown>): Promise<ClaydoError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(Error);
  return error as ClaydoError;
}

/** Polls until `ok` accepts the read value, or the deadline passes. */
export async function eventually<T>(
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
