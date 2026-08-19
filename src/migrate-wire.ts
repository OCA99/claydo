/**
 * Wire formats shared between the exporter (old Durable Object class), the
 * importer (the claydo host), and the migration driver. This module has no
 * runtime dependencies so both sides can import it without cycles.
 */

/** Storage key on the OLD instance that marks it sealed. */
export const SEAL_KEY = "__claydo:sealed";

/** Storage key on the NEW instance that tracks an import in progress. */
export const IMPORT_STATE_KEY = "__claydo:import";

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
  /** A page of rows for one table. `columns` starts with `__rowid__`. */
  rows?: { table: string; columns: string[]; values: SqlValue[][] };
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
}

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
  importing?: { kind: string; seq: number; cursor: ExportCursor | null };
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
