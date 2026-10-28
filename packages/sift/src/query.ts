/**
 * Query seam: the contract between Sift and a host-owned data provider.
 *
 * A provider answers a `TableQuery` with one bounded Arrow IPC stream. Sift
 * loads that stream through its resident path and records that the rows
 * already satisfy the query, so it does not filter them again locally. The
 * host owns the SQL dialect, the base relation, the connection, credentials,
 * and where the query runs; Sift never sees SQL text.
 */

import type { ColumnPredicate, FilterPredicate, SortEntry } from "./filter-schema";
import type { ColumnType } from "./table";

export type TableQuery = {
  /** Applied before filters. At most one per column. */
  casts: { column: string; to: ColumnType }[];
  /** Top-level AND. */
  filters: FilterPredicate[];
  sort: SortEntry[];
};

export type Count =
  | { kind: "exact"; value: number }
  | { kind: "estimate"; value: number; method?: string }
  | { kind: "lower-bound"; value: number }
  | { kind: "unknown" };

/** The only window mode this slice supports: the leading rows of the result. */
export type WindowRequest = { mode: "head"; limit: number };

export type QueryPage = {
  /** One complete uncompressed Arrow IPC stream; schema-only when empty. */
  ipc: Uint8Array;
  returnedRows: number;
  /** Rows matching the query before the window. Never the base relation count. */
  matchedCount: Count;
  continuation:
    | { kind: "end" }
    | { kind: "more" }
    | { kind: "stopped"; reason: "budget" | "unsupported-resume" };
};

export type QueryCapabilities = {
  /** Leaf predicate ops supported per column name. Columns absent here accept no pushdown. */
  filters: Record<string, readonly ColumnPredicate["op"][]>;
  /** Sortable columns; `[]` means none. */
  sort: readonly string[];
  casts: readonly { column: string; to: ColumnType }[];
  counts: readonly ("exact" | "estimate")[];
  /**
   * Compound predicates the provider accepts below the top-level AND. Absent
   * means leaves only: Sift's category exclusion (`or(is_null, not_in)`) then
   * cannot be pushed down.
   */
  compound?: readonly ("and" | "or" | "not")[];
};

export type RequestContext = {
  requestId: string;
  signal: AbortSignal;
  budget: { maxIpcBytes: number; maxDecodedBytes: number; deadlineMs?: number };
};

export interface TableQuerySession {
  readonly capabilities: QueryCapabilities;
  query(q: TableQuery & { window: WindowRequest }, ctx: RequestContext): Promise<QueryPage>;
  count(q: TableQuery, mode: "cheap" | "exact", ctx: RequestContext): Promise<Count>;
  close(): Promise<void>;
}

export type QuerySupport = { ok: true } | { ok: false; reason: string };

/**
 * Whether `caps` can answer `q` as written: every filter leaf's column and op,
 * every compound node, every sort column, and every cast must be declared.
 * Unsupported queries are refused here rather than narrowed silently.
 */
export function supportsQuery(caps: QueryCapabilities, q: TableQuery): QuerySupport {
  for (const cast of q.casts) {
    if (!caps.casts.some((c) => c.column === cast.column && c.to === cast.to)) {
      return { ok: false, reason: `Cast of ${cast.column} to ${cast.to} is not supported` };
    }
  }
  for (const predicate of q.filters) {
    const result = supportsPredicate(caps, predicate);
    if (!result.ok) return result;
  }
  for (const entry of q.sort) {
    if (!caps.sort.includes(entry.column)) {
      return { ok: false, reason: `Sorting by ${entry.column} is not supported` };
    }
  }
  return { ok: true };
}

function supportsPredicate(caps: QueryCapabilities, p: FilterPredicate): QuerySupport {
  if ("column" in p) {
    const ops = caps.filters[p.column];
    if (!ops) return { ok: false, reason: `Filters on ${p.column} are not supported` };
    if (!ops.includes(p.op)) {
      return { ok: false, reason: `Filter "${p.op}" on ${p.column} is not supported` };
    }
    return { ok: true };
  }
  if (!caps.compound?.includes(p.op)) {
    return { ok: false, reason: `Compound "${p.op}" filters are not supported` };
  }
  const args = p.op === "not" ? [p.arg] : p.args;
  for (const arg of args) {
    const result = supportsPredicate(caps, arg);
    if (!result.ok) return result;
  }
  return { ok: true };
}
