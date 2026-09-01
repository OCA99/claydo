/**
 * Error codes for every error that claydo creates.
 *
 * Codes are the stable contract for programmatic error handling. Match on
 * `error.code`, never on `error.message`: messages can change in any
 * release, codes only change in a semver-major release.
 */
export type ClaydoErrorCode =
  /** The worker exports or the wrangler configuration are incomplete. */
  | "CLAYDO_CONFIG"
  /** The requested kind is not in the registry passed to `union()`. */
  | "CLAYDO_UNKNOWN_KIND"
  /** The instance belongs to one kind, but the caller expected another. */
  | "CLAYDO_KIND_MISMATCH"
  /** The unique-ID instance has no kind yet, and the access cannot set one. */
  | "CLAYDO_UNINITIALIZED"
  /** The called name is not a callable method on the kind. */
  | "CLAYDO_NO_METHOD"
  /** An alarm operation ran inside a storage transaction. */
  | "CLAYDO_ALARM_IN_TRANSACTION";

/** An error that claydo created. */
export interface ClaydoError extends Error {
  code: ClaydoErrorCode;
}

/**
 * Creates a claydo error. Every error carries `name: "ClaydoError"` and a
 * {@link ClaydoErrorCode}; both survive Workers RPC.
 */
export function claydoError(
  code: ClaydoErrorCode,
  message: string,
  extra?: Record<string, unknown>,
): ClaydoError {
  const error = new Error(`claydo: ${message}`) as ClaydoError;
  error.name = "ClaydoError";
  error.code = code;
  if (extra !== undefined) Object.assign(error, extra);
  return error;
}

/**
 * True when `error` came from claydo, on either side of an RPC hop.
 * Narrows the error so `error.code` can be matched exhaustively.
 */
export function isClaydoError(error: unknown): error is ClaydoError {
  return (
    error instanceof Error &&
    error.name === "ClaydoError" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
