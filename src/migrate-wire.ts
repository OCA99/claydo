/**
 * Wire formats shared between the exporter (old Durable Object class), the
 * importer (the claydo host), and the migration driver. This module has no
 * runtime dependencies so both sides can import it without cycles.
 */

/** Storage key on the OLD instance that marks it sealed. */
export const SEAL_KEY = "__claydo:sealed";

/** Supervisor storage key on the NEW instance that tracks an import. */
export const IMPORT_STATE_KEY = "__claydo:import";

/** Temporary checkpoint key used only inside a target staging facet. */
export const IMPORT_CHECKPOINT_KEY = "__claydo:import-checkpoint";

/**
 * The only key the exporter adds to OLD user storage. The target's kind and
 * import metadata live in isolated supervisor storage, so every other old
 * key — even `__claydo:kind` — migrates into the user facet normally.
 */
export const RESERVED_STORAGE_KEYS: ReadonlySet<string> = new Set([
  SEAL_KEY,
]);

/** Response header set on 410 responses from sealed instances. */
export const SEALED_HEADER = "x-claydo-sealed";

/**
 * An import in progress goes stale when no chunk arrived for this long.
 * A stale import can be adopted (resumed or restarted) by another driver.
 */
export const IMPORT_STALE_MS = 30_000;

/** Export page limits persisted with an import reservation. */
export interface ImportLimits {
  maxRows: number;
  maxBytes: number;
}

/** A value that SQLite can hold. */
export type SqlValue = null | number | string | ArrayBuffer;

/**
 * Position of an export between chunks. Treat it as opaque: read it from
 * `ExportChunk.cursor` and pass it back to the next export call.
 */
export type ExportCursor =
  | { phase: "kv"; afterKey: string }
  | { phase: "rows"; tableIndex: number; afterRowid: number };

/** One chunk of an exported instance. */
export interface ExportChunk {
  /** Table DDL, present in the first chunk only. Replayed before any rows. */
  tables?: { name: string; ddl: string }[];
  /** A page of KV entries (never more than 128, the batch-put limit). */
  kv?: [string, unknown][];
  /**
   * A page of rows for one table. When `rowid` is `"__rowid__"`, the first
   * column carries the rowid explicitly. When `rowid` names a column, that
   * column is the INTEGER PRIMARY KEY alias and carries the rowid itself,
   * wherever it sits in the column list.
   */
  rows?: {
    table: string;
    columns: string[];
    values: SqlValue[][];
    rowid: string;
  };
  /** DDL for indexes, triggers, and views. Final chunk only, applied after rows. */
  post?: string[];
  /** `sqlite_sequence` entries for AUTOINCREMENT tables. Final chunk only. */
  sequences?: [string, number][];
  /** The pending alarm timestamp, or null. Final chunk only. */
  alarm?: number | null;
  /** Expected totals for verification. Final chunk only. */
  totals?: { kv: number; rows: Record<string, number> };
  /** Pass this to the next export call. `null` means the export is complete. */
  cursor: ExportCursor | null;
}

/** Import progress persisted on the target instance between chunks. */
export interface ImportState {
  kind: string;
  seq: number;
  cursor: ExportCursor | null;
  applied: { kv: number; rows: Record<string, number> };
  /** The driver that owns this import. Chunks from other drivers fail. */
  token: string;
  limits: ImportLimits;
  /** Final verification failed; adoption must discard staging and restart. */
  restartRequired: boolean;
  /** Refreshed on every chunk; used for stale-import adoption. */
  updatedAtMs: number;
}

/**
 * The result of reserving an import with `__claydoBeginImport`.
 * A refusal (another driver owns a non-stale import) is a return value, not
 * a thrown error, so correct concurrent behavior does not pollute the
 * target's logs with exceptions.
 */
export type ImportBegin =
  | {
      ok: true;
      /** The last applied chunk seq; 0 for a fresh import. */
      seq: number;
      /** The cursor to resume the export from; null for a fresh import. */
      cursor: ExportCursor | null;
      /** True when this call adopted an existing (stale or own) import. */
      resumed: boolean;
      limits: ImportLimits;
      restartRequired: boolean;
    }
  | {
      ok: false;
      reason: "owned";
      /** Milliseconds since the owning driver's last progress. */
      ageMs: number;
    };

/** Acknowledgement returned by the host for each imported chunk. */
export interface ImportAck {
  seq: number;
  /** True when the chunk had already been applied (idempotent retry). */
  alreadyApplied: boolean;
  /** True when this chunk finalized the import and pinned the kind. */
  done: boolean;
  applied: { kv: number; rows: Record<string, number> };
}

/** Snapshot of the target instance's migration-related state. */
export interface ImportStatus {
  /** The pinned kind, when the instance is live. */
  kind?: string;
  /** Present while an import is in progress. */
  importing?: {
    kind: string;
    seq: number;
    cursor: ExportCursor | null;
    /** Milliseconds since the last applied chunk. */
    ageMs: number;
  };
}

/** Quotes an SQLite identifier. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Rough byte size of a value, for chunk budgeting. */
export function sizeOf(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (typeof value === "string") return value.length * 2;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  // Conservative guess for structured values.
  return 256;
}
