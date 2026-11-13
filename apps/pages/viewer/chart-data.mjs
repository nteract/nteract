// Rows a chart reads, as plain values: the budgets the page checks before a
// draw starts, and the copy the chart Worker makes of what crosses to it. No
// DOM and no Vega, so the page and viewer/chart-worker.mjs share it.
import { CHART_MAX_CELLS, chartNumber } from "../shared/chart-spec.mjs";

/**
 * One data value as a chart reads it. Numbers go through `chartNumber`
 * (bigints become numbers first). Vega coerces strings in arithmetic, so a
 * string that reads as a number outside CHART_NUMBER_RANGE, or as Infinity,
 * becomes that number's chart value.
 */
function plainScalar(value) {
  if (typeof value === "bigint") return chartNumber(Number(value));
  if (typeof value === "number") return chartNumber(value);
  if (typeof value === "string" && value.trim() !== "") {
    const read = Number(value);
    if (!Number.isNaN(read) && chartNumber(read) !== read) return chartNumber(read);
  }
  return value;
}

/** Nesting a copied value keeps; anything deeper becomes null. */
const MAX_NESTING = 32;

/** A dataset that needs more than CHART_MAX_CELLS cells to copy. */
class CellBudgetSpent extends Error {}

/** The cells left for one dataset's copy, top-level and nested together. */
function cellBudget(limit) {
  let left = limit;
  return (cells) => {
    left -= cells;
    if (left < 0) throw new CellBudgetSpent();
  };
}

// Arrow's nested values: a list cell is a Vector, a struct cell a StructRow
// and a map cell a MapRow. Their toJSON reads every element at once, so they
// are walked one entry at a time instead, after their size is charged.
const ARROW_PARENT = Symbol.for("parent");
const ARROW_KEYS = Symbol.for("keys");
const isArrowVector = (value) =>
  typeof value.get === "function" &&
  Number.isInteger(value.length) &&
  Array.isArray(value.data) &&
  value.type !== undefined;
const arrowRowSize = (value) => {
  if (value[ARROW_KEYS] !== undefined) return value.size;
  if (value[ARROW_PARENT] !== undefined) return value[ARROW_PARENT].type?.children?.length;
  return undefined;
};

/** Define `key` on `copy` as an own property, so "__proto__" stays a key, as
 * JSON.parse makes it. */
const defineKey = (copy, key, value) =>
  Object.defineProperty(copy, key, { value, enumerable: true, writable: true, configurable: true });

/**
 * A copy of one data value, spending a cell for every array element and
 * object key before reading it, nested ones included, so a payload shared by
 * every row counts once per row. A field path reaches nested values, so they
 * get `plainScalar` too. Objects copy as plain objects, since Vega coerces
 * some (a gradient paint) to strings. Arrow lists, structs and maps are
 * walked entry by entry; another object's `toJSON` is honored after the depth
 * check. A cycle, a value deeper than MAX_NESTING or a property that throws
 * becomes null.
 */
function plainValue(value, spend, depth = 0, ancestors = []) {
  if (value instanceof Date || value === null || typeof value !== "object")
    return plainScalar(value);
  if (depth >= MAX_NESTING || ancestors.includes(value)) return null;
  ancestors.push(value);
  try {
    const next = (item) => plainValue(item, spend, depth + 1, ancestors);
    if (isArrowVector(value)) {
      spend(value.length);
      const copy = new Array(value.length);
      for (let i = 0; i < value.length; i++) copy[i] = next(value.get(i));
      return copy;
    }
    const rowSize = arrowRowSize(value);
    if (rowSize !== undefined) {
      spend(Number.isInteger(rowSize) ? rowSize : Number.POSITIVE_INFINITY);
      const copy = {};
      for (const [key, item] of value) defineKey(copy, String(key), next(item));
      return copy;
    }
    if (typeof value.toJSON === "function") {
      let json;
      try {
        json = value.toJSON();
      } catch {
        return null;
      }
      return json === value ? null : next(json);
    }
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      spend(value.length);
      const copy = new Array(value.length);
      for (let i = 0; i < value.length; i++) copy[i] = next(value[i]);
      return copy;
    }
    const copy = {};
    for (const key of Object.keys(value)) {
      spend(1);
      let item;
      try {
        item = value[key];
      } catch {
        item = null;
      }
      defineKey(copy, key, next(item));
    }
    return copy;
  } finally {
    ancestors.pop();
  }
}

export const tooManyCells = (name) =>
  `The dataset "${name}" has more than ${CHART_MAX_CELLS.toLocaleString("en-US")} cells (rows × columns, nested values included); a chart reads at most that many.`;

/** Rows in a dataset, before any are copied. */
export const rowCount = (dataset) =>
  Array.isArray(dataset) ? dataset.length : isArrowTable(dataset) ? dataset.numRows : 0;

export const unreadableDataset = (name) =>
  `The dataset "${name}" holds a value a chart can't read: one nested more than ${MAX_NESTING} levels deep, or one that isn't plain data: an object, array, string, number, boolean, date or typed array.`;

/** A typed array: a view with a length, not a DataView. */
const isTypedArray = (value) => ArrayBuffer.isView(value) && !(value instanceof DataView);

/** An object with Object's prototype or none: what structured clone and
 * `plainValue` copy key by key. */
const isPlainObject = (value) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** A value a row may hold with nothing inside it to walk. */
const isScalar = (value) =>
  value === null ||
  value instanceof Date ||
  ["string", "number", "boolean", "bigint", "undefined"].includes(typeof value);

/** Whether an array has an own enumerable property besides its entries,
 * which structured clone would carry. Array indices list first among own
 * keys, so any other key is last. Lists the array's keys: called only once
 * its entries have been charged. */
const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;
const hasKeysPastEntries = (array) => {
  const last = Object.keys(array).at(-1);
  return last !== undefined && !(ARRAY_INDEX.test(last) && Number(last) < 2 ** 32 - 1);
};

/** Thrown by `cellCount` for a value it can't account for. */
export class UnreadableDataset extends Error {}

/**
 * Cells a copy of the dataset would hold, counted without copying, before
 * the page posts it to a Worker. Rows count the way the Worker's copy spends
 * them (`plainValue`): each row's own keys, and every nested array element,
 * typed-array element and object key. An object met twice in one row counts
 * once, so a cycle ends. Stops once past `limit`. An Arrow table counts rows
 * × columns; its nested values are charged in the Worker as they decode.
 *
 * Throws UnreadableDataset for a row the count can't fully account for, so
 * it never crosses: a container nested more than MAX_NESTING levels deep
 * (the Worker's copy would drop it), a value that isn't a scalar
 * (`isScalar`), a plain object, an array or a typed array, or an array,
 * the dataset's own included, with a property besides its entries.
 */
export function cellCount(dataset, limit) {
  if (isArrowTable(dataset)) return dataset.numRows * dataset.schema.fields.length;
  if (!Array.isArray(dataset)) return 0;
  if (hasKeysPastEntries(dataset)) throw new UnreadableDataset();
  let cells = 0;
  for (const row of dataset) {
    if (isScalar(row)) continue;
    if (!Array.isArray(row) && !isPlainObject(row)) throw new UnreadableDataset();
    const seen = new Set([row]);
    const stack = [[row, 0]];
    while (stack.length) {
      const [value, depth] = stack.pop();
      if (isTypedArray(value)) {
        cells += value.length;
        if (cells > limit) return cells;
        continue;
      }
      const keys = Array.isArray(value) ? null : Object.keys(value);
      const size = keys ? keys.length : value.length;
      cells += size;
      if (cells > limit) return cells;
      if (!keys && hasKeysPastEntries(value)) throw new UnreadableDataset();
      for (let index = 0; index < size; index++) {
        let child;
        try {
          child = keys ? value[keys[index]] : value[index];
        } catch {
          throw new UnreadableDataset();
        }
        if (isScalar(child)) continue;
        if (!Array.isArray(child) && !isTypedArray(child) && !isPlainObject(child))
          throw new UnreadableDataset();
        if (depth + 1 >= MAX_NESTING) throw new UnreadableDataset();
        if (!seen.has(child)) {
          seen.add(child);
          stack.push([child, depth + 1]);
        }
      }
    }
    if (cells > limit) return cells;
  }
  return cells;
}

export const isArrowTable = (value) =>
  !!value &&
  typeof value === "object" &&
  Array.isArray(value.schema?.fields) &&
  typeof value.getChildAt === "function" &&
  Number.isInteger(value.numRows);

/**
 * Plain rows for Vega from a dataset: an array of row objects, or an Arrow
 * table, or null for anything else. Rows are copied, since Vega tags each row
 * it ingests, and each value goes through `plainValue`: 64-bit integers
 * become numbers, since Vega's scales take only numbers, and every number
 * lands in CHART_NUMBER_RANGE or becomes 0 or null. Each copy has a null
 * prototype, so a column named `__proto__` stays a column and a missing
 * `constructor` or `toString` column reads as undefined.
 *
 * The copy spends at most `limit` cells, top-level and nested together, and
 * throws CellBudgetSpent past it.
 */
export function datasetRows(dataset, limit = CHART_MAX_CELLS) {
  const spend = cellBudget(limit);
  if (Array.isArray(dataset))
    return dataset.map((row) => {
      const copy = Object.create(null);
      if (!row || typeof row !== "object") return copy;
      for (const key of Object.keys(row)) {
        spend(1);
        copy[key] = plainValue(row[key], spend);
      }
      return copy;
    });
  if (isArrowTable(dataset)) {
    const columns = dataset.schema.fields.map((field, index) => ({
      name: field.name,
      vector: dataset.getChildAt(index),
    }));
    spend(dataset.numRows * columns.length);
    const rows = new Array(dataset.numRows);
    for (let r = 0; r < rows.length; r++) {
      const row = Object.create(null);
      for (const { name, vector } of columns) row[name] = plainValue(vector?.get(r) ?? null, spend);
      rows[r] = row;
    }
    return rows;
  }
  return null;
}

/** True when `error` is datasetRows running out of cells. */
export const spentCellBudget = (error) => error instanceof CellBudgetSpent;

/**
 * The rows the chart Worker received, normalized in place: each row loses its
 * prototype and each value goes through `plainValue`, under the same cell
 * budget as `datasetRows`. Structured clone already made the one copy, so the
 * rows are not copied again. Throws CellBudgetSpent past `limit`.
 */
export function ownRows(rows, limit = CHART_MAX_CELLS) {
  const spend = cellBudget(limit);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      rows[i] = Object.create(null);
      continue;
    }
    Object.setPrototypeOf(row, null);
    for (const key of Object.keys(row)) {
      spend(1);
      row[key] = plainValue(row[key], spend);
    }
  }
  return rows;
}
