/**
 * A Sift `TableQuerySession` over one relation in a Page's DuckDB engine.
 *
 * Sift sends name-addressed predicates; this compiles them to a parameterized
 * SELECT over the relation and answers with the head of the result as one
 * Arrow IPC stream. Sift never sees SQL. Values are bound as parameters, and
 * column names are checked against the relation's schema before quoting.
 */
import { supportsQuery } from "@nteract/sift";
import { quoteIdent } from "./duckdb-engine.mjs";

// Whole DuckDB type names: a list such as INTEGER[] or a struct is not a
// scalar and takes no pushdown.
const NUMERIC =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL\(\d+,\d+\))$/;
const TEMPORAL =
  /^(DATE|TIMESTAMP|TIMESTAMP_S|TIMESTAMP_MS|TIMESTAMP_NS|TIMESTAMP WITH TIME ZONE)$/;
const ORDERED = ["between", "gt", "gte", "lt", "lte", "is_null", "is_not_null"];

const FLOATING = /^(FLOAT|DOUBLE)$/;

/**
 * A temporal column as epoch milliseconds, computed the way Sift compares
 * timestamps: an f64 from the column's own unit (nanoseconds / 1e6,
 * microseconds / 1e3, whole milliseconds as they are), so pushdown keeps
 * Sift's row set at sub-millisecond boundaries and past 2^53 microseconds.
 * A zoned timestamp is already an instant; casting it would apply the
 * session time zone.
 */
function epochMs(type, col) {
  switch (type) {
    case "TIMESTAMP_NS":
      return `(epoch_ns(${col})::DOUBLE / 1e6)`;
    case "TIMESTAMP":
    case "TIMESTAMP WITH TIME ZONE":
      return `(epoch_us(${col})::DOUBLE / 1e3)`;
    default:
      // DATE, TIMESTAMP_S and TIMESTAMP_MS hold whole milliseconds.
      return `epoch_ms(${col}::TIMESTAMP)::DOUBLE`;
  }
}

/** Leaf ops a DuckDB column type answers. Other types accept no pushdown. */
function opsFor(type) {
  if (NUMERIC.test(type)) return [...ORDERED, "eq", "neq", "in", "not_in"];
  if (TEMPORAL.test(type)) return ORDERED;
  if (type === "VARCHAR")
    return ["eq", "neq", "in", "not_in", "is_null", "is_not_null", "contains"];
  if (type === "BOOLEAN") return ["eq", "is_null", "is_not_null"];
  return [];
}

/**
 * `engine` is from openPageEngine; `relation` names a view or table in it.
 * `close` leaves the engine and its sources open: they belong to the Page.
 */
export async function createDuckQuerySession(engine, relation) {
  const columns = await engine.describe(relation);
  const typeOf = new Map(columns.map(({ name, type }) => [name, type]));
  const filters = {};
  for (const { name, type } of columns) {
    const ops = opsFor(type);
    if (ops.length) filters[name] = ops;
  }
  const capabilities = {
    filters,
    // Only scalar columns sort; a list or struct has no order Sift shows.
    sort: Object.keys(filters),
    casts: [],
    counts: ["exact"],
    compound: ["and", "or", "not"],
  };
  let closed = false;

  function where(query) {
    const params = [];
    const compile = (p) => {
      if (!("column" in p)) {
        if (p.op === "not") return `NOT (${compile(p.arg)})`;
        // An empty conjunction holds for every row; an empty disjunction for none.
        if (!p.args.length) return p.op === "and" ? "TRUE" : "FALSE";
        return `(${p.args.map(compile).join(p.op === "and" ? " AND " : " OR ")})`;
      }
      const type = typeOf.get(p.column);
      const col = quoteIdent(p.column);
      const bind = (value) => (params.push(value), "?");
      // Equality on a number binds its text and casts it to the column's
      // type, so a BIGINT, HUGEINT or wide DECIMAL compares exactly rather
      // than through a double. Sift's category values are cell text already.
      const exact = NUMERIC.test(type)
        ? (value) => `CAST(${bind(String(value))} AS ${type})`
        : bind;
      // Ordered comparisons are Sift's range filter: both sides as f64, stated
      // here rather than left to parameter type inference, and NaN, which
      // DuckDB orders above every number, never matches.
      const f64 = TEMPORAL.test(type) ? epochMs(type, col) : `CAST(${col} AS DOUBLE)`;
      const bound = (value) => `CAST(${bind(value)} AS DOUBLE)`;
      const ordered = (sql) => (FLOATING.test(type) ? `(${sql} AND NOT isnan(${col}))` : sql);
      switch (p.op) {
        case "between":
          return ordered(`${f64} BETWEEN ${bound(p.value[0])} AND ${bound(p.value[1])}`);
        case "eq":
          return p.value === null ? `${col} IS NULL` : `${col} = ${exact(p.value)}`;
        case "neq":
          return p.value === null
            ? `${col} IS NOT NULL`
            : `${col} IS DISTINCT FROM ${exact(p.value)}`;
        case "gt":
          return ordered(`${f64} > ${bound(p.value)}`);
        case "gte":
          return ordered(`${f64} >= ${bound(p.value)}`);
        case "lt":
          return ordered(`${f64} < ${bound(p.value)}`);
        case "lte":
          return ordered(`${f64} <= ${bound(p.value)}`);
        case "is_null":
          return `${col} IS NULL`;
        case "is_not_null":
          return `${col} IS NOT NULL`;
        case "contains":
          // Case-sensitive and literal, as Sift's SQL and pandas exports read it.
          return `contains(${col}, ${bind(p.value)})`;
        case "in":
        case "not_in": {
          const values = p.value.filter((v) => v !== null);
          const hasNull = values.length < p.value.length;
          const set = values.length ? `${col} IN (${values.map(exact).join(", ")})` : "FALSE";
          if (p.op === "in") return hasNull ? `(${set} OR ${col} IS NULL)` : set;
          // Sift's not_in keeps nulls unless null is listed.
          return hasNull ? `(NOT ${set} AND ${col} IS NOT NULL)` : `(${col} IS NULL OR NOT ${set})`;
        }
      }
      throw Error(`Unsupported filter "${p.op}"`);
    };
    const clauses = query.filters.map(compile);
    return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
  }

  function check(query, ctx) {
    if (closed) throw Error("Query session is closed");
    ctx.signal.throwIfAborted();
    const support = supportsQuery(capabilities, query);
    if (!support.ok) throw Error(support.reason);
  }

  async function count(query, ctx) {
    const { sql, params } = where(query);
    const { ipc } = await engine.stream(
      `SELECT count(*)::DOUBLE AS n FROM ${quoteIdent(relation)}${sql}`,
      params,
      { signal: ctx.signal },
    );
    ctx.signal.throwIfAborted();
    return { kind: "exact", value: await firstNumber(ipc) };
  }

  return {
    capabilities,
    async query(query, ctx) {
      check(query, ctx);
      const { sql, params } = where(query);
      const order = query.sort.length
        ? ` ORDER BY ${query.sort.map((s) => `${quoteIdent(s.column)} ${s.direction === "desc" ? "DESC" : "ASC"} NULLS LAST`).join(", ")}`
        : "";
      const limit = Math.max(0, Math.floor(query.window.limit));
      // The stream is uncompressed, so its size is also its decoded size.
      const maxBytes = Math.min(ctx.budget.maxIpcBytes, ctx.budget.maxDecodedBytes);
      const select = (rows) =>
        engine.stream(`SELECT * FROM ${quoteIdent(relation)}${sql}${order} LIMIT ${rows}`, params, {
          signal: ctx.signal,
          maxBytes,
        });
      let { ipc, complete, refused } = await select(limit);
      ctx.signal.throwIfAborted();
      let returnedRows = await rowCount(ipc);
      if (returnedRows === 0 && refused) {
        // DuckDB batches rows by the thousand, so on a wide table the first
        // batch alone can exceed the budget. Ask once for the rows that fit,
        // sized from that batch's bytes per row with room for batch overhead.
        const rows = await rowCount(
          concat(ipc.subarray(0, -END_OF_STREAM), refused, ipc.subarray(-END_OF_STREAM)),
        );
        const fit = Math.floor((0.9 * (maxBytes - ipc.byteLength) * rows) / refused.byteLength);
        if (fit >= 1 && fit < limit) {
          ({ ipc } = await select(fit));
          ctx.signal.throwIfAborted();
          returnedRows = await rowCount(ipc);
        }
      }
      const matched =
        complete && returnedRows < limit
          ? { kind: "exact", value: returnedRows }
          : await count(query, ctx);
      return {
        ipc,
        returnedRows,
        matchedCount: matched,
        continuation: !complete
          ? { kind: "stopped", reason: "budget" }
          : returnedRows < matched.value
            ? { kind: "more" }
            : { kind: "end" },
      };
    },
    async count(query, _mode, ctx) {
      check(query, ctx);
      return count(query, ctx);
    },
    async close() {
      closed = true;
    },
  };
}

const END_OF_STREAM = 8;
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

let arrow;
async function rowCount(ipc) {
  arrow ??= await import("apache-arrow");
  return arrow.tableFromIPC(ipc).numRows;
}
async function firstNumber(ipc) {
  arrow ??= await import("apache-arrow");
  return Number(arrow.tableFromIPC(ipc).getChildAt(0).get(0));
}
