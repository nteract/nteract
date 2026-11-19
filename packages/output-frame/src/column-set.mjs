// A ColumnSet is a table as it crosses the frame boundary: plain data a
// structured clone carries, with no class instances. Both sides check it
// with checkColumnSet; the frame reads it through table.mjs.
//
// { numRows, columns: [{ name, type, values, nulls? }] }
//
// `type` is one of COLUMN_TYPES:
// - "number": a Float64Array. 64-bit integers that are all safe integers
//   (within ±(2^53 − 1)), other integers, floats, decimals (as floats) and
//   times of day (ms since midnight).
// - "bigint": a BigInt64Array, or a BigUint64Array for unsigned values; a
//   64-bit integer column with any value that is not a safe integer, exact.
// - "date": a Float64Array of milliseconds since the epoch. Dates and
//   timestamps of every unit.
// - "string": an array of strings.
// - "boolean": an array of booleans.
// - "other": an array of structured-clone values: lists, structs, maps and
//   binary, as a chart reads them.
// `nulls` is absent when the column has no nulls; otherwise a Uint8Array
// validity mask, 1 where a value is present. Where it is 0, an array holds
// null and a typed array holds a value nobody reads.

export const COLUMN_TYPES = Object.freeze([
  "number",
  "bigint",
  "date",
  "string",
  "boolean",
  "other",
]);
export const MAX_COLUMNS = 256;
export const MAX_COLUMN_NAME = 256;

const invalid = (why) => Error(`Invalid column set: ${why}.`);

const ARRAYS = {
  number: (values) => values instanceof Float64Array,
  date: (values) => values instanceof Float64Array,
  bigint: (values) => values instanceof BigInt64Array || values instanceof BigUint64Array,
  string: Array.isArray,
  boolean: Array.isArray,
  other: Array.isArray,
};
const ITEMS = {
  string: (value) => typeof value === "string",
  boolean: (value) => typeof value === "boolean",
};

/** Throws for anything that is not a ColumnSet: wrong lengths, an unknown
 * type, values of the wrong kind, or names that are not unique strings of
 * 1 to MAX_COLUMN_NAME characters. Returns `set`. */
export function checkColumnSet(set) {
  if (!set || typeof set !== "object" || Array.isArray(set)) throw invalid("not an object");
  const { numRows, columns } = set;
  if (!Number.isSafeInteger(numRows) || numRows < 0) throw invalid("numRows");
  if (!Array.isArray(columns) || columns.length > MAX_COLUMNS)
    throw invalid(`at most ${MAX_COLUMNS} columns`);
  const names = new Set();
  for (const column of columns) {
    if (!column || typeof column !== "object") throw invalid("a column is not an object");
    const { name, type, values, nulls } = column;
    if (
      typeof name !== "string" ||
      !name.length ||
      name.length > MAX_COLUMN_NAME ||
      name === "__proto__" ||
      names.has(name)
    )
      throw invalid("column names are unique strings");
    names.add(name);
    if (!Object.hasOwn(ARRAYS, type)) throw invalid(`unknown type for ${name}`);
    if (!ARRAYS[type](values) || values.length !== numRows)
      throw invalid(`values of ${name} do not match its type and numRows`);
    if (
      nulls !== undefined &&
      (!(nulls instanceof Uint8Array) || nulls.length !== numRows || nulls.some((bit) => bit > 1))
    )
      throw invalid(`nulls of ${name}`);
    if (Array.isArray(values)) {
      const item = ITEMS[type];
      for (let row = 0; row < numRows; row++) {
        const present = !nulls || nulls[row] === 1;
        if (present ? item && !item(values[row]) : values[row] !== null)
          throw invalid(`values of ${name} do not match its type`);
      }
    }
  }
  return set;
}

/** A dedicated copy of a checked ColumnSet and the buffers to transfer
 * with it: every typed array of the copy. Arrays are copied by the
 * structured clone that carries the copy. */
export function copyColumnSet(set) {
  const transfer = [];
  const own = (array) => {
    if (Array.isArray(array) || array === undefined) return array;
    const copy = array.slice();
    transfer.push(copy.buffer);
    return copy;
  };
  const columns = set.columns.map(({ name, type, values, nulls }) => ({
    name,
    type,
    values: own(values),
    ...(nulls && { nulls: own(nulls) }),
  }));
  return [{ numRows: set.numRows, columns }, transfer];
}
