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

const NUMERIC =
  /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL)/;
const TEMPORAL = /^(DATE|TIMESTAMP)/;
const ORDERED = ["between", "gt", "gte", "lt", "lte", "is_null", "is_not_null"];

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
    sort: columns.map(({ name }) => name),
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
        return `(${p.args.map(compile).join(p.op === "and" ? " AND " : " OR ")})`;
      }
      const type = typeOf.get(p.column);
      // Sift sends timestamps as epoch milliseconds.
      const col = TEMPORAL.test(type)
        ? `epoch_ms(${quoteIdent(p.column)}::TIMESTAMP)`
        : quoteIdent(p.column);
      const bind = (value) => (params.push(value), "?");
      switch (p.op) {
        case "between":
          return `${col} BETWEEN ${bind(p.value[0])} AND ${bind(p.value[1])}`;
        case "eq":
          return p.value === null ? `${col} IS NULL` : `${col} = ${bind(p.value)}`;
        case "neq":
          return p.value === null
            ? `${col} IS NOT NULL`
            : `${col} IS DISTINCT FROM ${bind(p.value)}`;
        case "gt":
          return `${col} > ${bind(p.value)}`;
        case "gte":
          return `${col} >= ${bind(p.value)}`;
        case "lt":
          return `${col} < ${bind(p.value)}`;
        case "lte":
          return `${col} <= ${bind(p.value)}`;
        case "is_null":
          return `${col} IS NULL`;
        case "is_not_null":
          return `${col} IS NOT NULL`;
        case "contains":
          return `contains(${col}, ${bind(p.value)})`;
        case "in":
        case "not_in": {
          const values = p.value.filter((v) => v !== null);
          const hasNull = values.length < p.value.length;
          const set = values.length ? `${col} IN (${values.map(bind).join(", ")})` : "FALSE";
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
    const ipc = await engine.run(
      `SELECT count(*)::DOUBLE AS n FROM ${quoteIdent(relation)}${sql}`,
      params,
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
      const ipc = await engine.run(
        `SELECT * FROM ${quoteIdent(relation)}${sql}${order} LIMIT ${limit}`,
        params,
      );
      ctx.signal.throwIfAborted();
      if (ipc.byteLength > ctx.budget.maxIpcBytes)
        throw Error(`Result exceeds ${ctx.budget.maxIpcBytes} bytes; filter further.`);
      const returnedRows = await rowCount(ipc);
      const matched =
        returnedRows < limit ? { kind: "exact", value: returnedRows } : await count(query, ctx);
      return {
        ipc,
        returnedRows,
        matchedCount: matched,
        continuation: returnedRows < matched.value ? { kind: "more" } : { kind: "end" },
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

let arrow;
async function rowCount(ipc) {
  arrow ??= await import("apache-arrow");
  return arrow.tableFromIPC(ipc).numRows;
}
async function firstNumber(ipc) {
  arrow ??= await import("apache-arrow");
  return Number(arrow.tableFromIPC(ipc).getChildAt(0).get(0));
}
