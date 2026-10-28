/**
 * A `TableQuerySession` over an in-memory Arrow IPC stream, for tests and the
 * demo. Not part of the public API.
 *
 * The whole table lives in one WASM store. A query runs `store_filter_rows`
 * for the predicate subset the WASM filter ABI knows (range, set, not-in,
 * boolean), takes the head of the matching row indices, and serializes those
 * rows with `get_viewport_by_indices`; an empty result is the schema-only
 * stream `filter_rows` produces for an all-zero mask. No sort or cast
 * pushdown; counts are exact.
 */

import { resolveTableFileLimits, type TableFileLimits } from "./file-data";
import type { ColumnPredicate, FilterPredicate } from "./filter-schema";
import { ensureModule, type FilterSpecJson } from "./predicate";
import {
  type QueryCapabilities,
  type QueryPage,
  type RequestContext,
  supportsQuery,
  type TableQuery,
  type TableQuerySession,
  type WindowRequest,
} from "./query";

export type ArrowIpcSessionOptions = {
  /** Bounds for loading `ipc` into the store. Defaults match `loadTableFile`. */
  limits?: TableFileLimits;
};

export type ArrowIpcSession = TableQuerySession & {
  /** Rows in the base relation. */
  readonly rowCount: number;
  /** Queries answered so far, newest last. Tests read this. */
  readonly queries: (TableQuery & { window: WindowRequest })[];
};

const LEAF_OPS: Record<string, readonly ColumnPredicate["op"][]> = {
  numeric: ["between"],
  timestamp: ["between"],
  categorical: ["in", "not_in", "is_null"],
  boolean: ["eq"],
};

export async function createArrowIpcSession(
  ipc: Uint8Array,
  options: ArrowIpcSessionOptions = {},
): Promise<ArrowIpcSession> {
  const mod = await ensureModule();
  const { maxRows, maxColumns, maxDecodedBytes } = resolveTableFileLimits(options.limits ?? {});
  const source = new Uint8Array(ipc);
  const handle = mod.load_ipc_bounded(source, maxRows, maxColumns, maxDecodedBytes);
  const rowCount = mod.num_rows(handle);
  const names: string[] = mod.col_names(handle);
  const types = names.map((_, c) => mod.col_type(handle, c));
  const columnIndex = new Map(names.map((name, c) => [name, c]));
  const filters: QueryCapabilities["filters"] = {};
  names.forEach((name, c) => {
    const ops = LEAF_OPS[types[c]];
    if (ops) filters[name] = ops;
  });
  const capabilities: QueryCapabilities = {
    filters,
    sort: [],
    casts: [],
    counts: ["exact"],
    // Only Sift's category exclusion idiom, `or(is_null(c), not_in(c, …))`;
    // `toFilterSpec` refuses any other `or`.
    compound: ["or"],
  };
  const queries: ArrowIpcSession["queries"] = [];
  let closed = false;

  function toFilterSpec(predicate: FilterPredicate): FilterSpecJson {
    if (!("column" in predicate)) {
      if (predicate.op === "or" && predicate.args.length === 2) {
        const [a, b] = predicate.args;
        const isNull = [a, b].find((p) => "column" in p && p.op === "is_null");
        const notIn = [a, b].find((p) => "column" in p && p.op === "not_in");
        if (
          isNull &&
          notIn &&
          "column" in isNull &&
          "column" in notIn &&
          isNull.column === notIn.column &&
          notIn.op === "not_in"
        ) {
          return { kind: "not_in", col: col(notIn.column), values: notIn.value.map(String) };
        }
      }
      throw new Error(`Unsupported compound filter "${predicate.op}"`);
    }
    switch (predicate.op) {
      case "between":
        return {
          kind: "range",
          col: col(predicate.column),
          min: predicate.value[0],
          max: predicate.value[1],
        };
      case "in":
        return { kind: "set", col: col(predicate.column), values: predicate.value.map(String) };
      case "eq":
        if (typeof predicate.value !== "boolean") {
          throw new Error(`Unsupported "eq" value on ${predicate.column}`);
        }
        return { kind: "boolean", col: col(predicate.column), value: predicate.value };
      default:
        throw new Error(`Unsupported filter "${predicate.op}" on ${predicate.column}`);
    }
  }

  function col(name: string): number {
    const index = columnIndex.get(name);
    if (index === undefined) throw new Error(`Unknown column ${name}`);
    return index;
  }

  /** Matching row indices in base order, after validating the whole query. */
  function matches(q: TableQuery, ctx: RequestContext): Uint32Array {
    if (closed) throw new Error("Query session is closed");
    ctx.signal.throwIfAborted();
    const support = supportsQuery(capabilities, q);
    if (!support.ok) throw new Error(support.reason);
    if (q.filters.length === 0) return Uint32Array.from({ length: rowCount }, (_, i) => i);
    return mod.store_filter_rows(handle, q.filters.map(toFilterSpec));
  }

  return {
    capabilities,
    rowCount,
    queries,
    async query(q, ctx): Promise<QueryPage> {
      queries.push(q);
      const matched = matches(q, ctx);
      const head = matched.subarray(0, Math.max(0, q.window.limit));
      const page =
        head.length > 0
          ? mod.get_viewport_by_indices(handle, head)
          : mod.filter_rows(source, new Uint8Array(rowCount));
      return {
        ipc: page,
        returnedRows: head.length,
        matchedCount: { kind: "exact", value: matched.length },
        continuation: head.length < matched.length ? { kind: "more" } : { kind: "end" },
      };
    },
    async count(q, _mode, ctx) {
      return { kind: "exact", value: matches(q, ctx).length };
    },
    async close() {
      if (closed) return;
      closed = true;
      mod.free(handle);
    },
  };
}
