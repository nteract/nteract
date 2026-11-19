// The table a module view's model holds for a Parquet data name: a frozen,
// Arrow-style wrapper over one checked ColumnSet (column-set.mjs). It
// spells its members as an Apache Arrow JS table does, so code written for
// an Arrow table, and Plot, read it. This is the author interface; nothing
// else on the object is part of it.
//
// Table: numRows, numCols, schema.fields ({name, type}), getChild(name),
// getChildAt(index), get(index), toArray(), [Symbol.iterator] over rows,
// select(names).
// Column: length, nullCount, type, get(index), toArray(), toJSON(),
// [Symbol.iterator].
//
// Where it differs from Arrow JS on purpose:
// - Values are plain JavaScript: a "date" value is a Date, a "bigint"
//   value a BigInt, a missing value null.
// - A row is a plain object the view may change, built once with every
//   other row. The table, its schema and its columns are frozen.
// - A column's toArray() is its typed array when it is "number" or
//   "bigint" with no nulls; otherwise an array with nulls as null. Each
//   frame holds its own copy, so a view that writes to one changes only
//   what it reads back.
// - getChild and getChildAt answer null for a name or index the table does
//   not hold, and select skips unknown names, as Arrow JS does.
import { checkColumnSet } from "./column-set.mjs";

// Each column type as an Arrow DataType reads: `typeId` from apache-arrow's
// Type enum (Int 2, Float 3, Utf8 5, Bool 6, Timestamp 10, NONE 0) and
// `unit` from its TimeUnit (MILLISECOND 1). Plot reads typeId 10 with
// unit 1 as a time column. `kind` is the ColumnSet type.
const TYPES = Object.freeze({
  number: Object.freeze({ typeId: 3, kind: "number" }),
  bigint: Object.freeze({ typeId: 2, bitWidth: 64, kind: "bigint" }),
  date: Object.freeze({ typeId: 10, unit: 1, kind: "date" }),
  string: Object.freeze({ typeId: 5, kind: "string" }),
  boolean: Object.freeze({ typeId: 6, kind: "boolean" }),
  other: Object.freeze({ typeId: 0, kind: "other" }),
});

/** An Arrow-style table over the ColumnSet `set`. Throws for a set
 * checkColumnSet refuses. The table reads `set` in place. */
export function columnTable(set) {
  const { numRows, columns } = checkColumnSet(set);
  return tableOf(
    numRows,
    columns.map((column) => columnOf(column, numRows)),
  );
}

function tableOf(numRows, children) {
  const fields = Object.freeze(
    children.map(({ name, column }) =>
      Object.freeze({ name, type: column.type, nullable: column.nullCount > 0 }),
    ),
  );
  let rows;
  const toArray = () => {
    if (!rows) {
      const values = children.map(({ column }) => column.toArray());
      rows = Array.from({ length: numRows }, (_, row) => {
        const out = {};
        children.forEach(({ name }, index) => (out[name] = values[index][row]));
        return out;
      });
    }
    return rows;
  };
  const getChildAt = (index) => children[index]?.column ?? null;
  return Object.freeze({
    numRows,
    numCols: children.length,
    schema: Object.freeze({ fields }),
    getChild: (name) => getChildAt(children.findIndex((child) => child.name === name)),
    getChildAt,
    get: (index) => toArray()[index] ?? null,
    toArray,
    [Symbol.iterator]: () => toArray()[Symbol.iterator](),
    select(names) {
      const picked = names.flatMap((name) => children.filter((child) => child.name === name));
      return tableOf(numRows, picked);
    },
  });
}

// Plot reads a table through getChild, schema.fields and each column's
// toArray/toJSON, sizes it by numRows, and reads a column with nulls
// through toJSON (Plot 0.6.17 src/options.js: isArrowTable, isArrowVector,
// vectorToArray, lengthof). A function channel reads rows through the
// table's iterator, and some transforms through get(index).
function columnOf({ name, type, values, nulls }, numRows) {
  let nullCount = 0;
  if (nulls) for (const bit of nulls) nullCount += bit ? 0 : 1;
  let built;
  const toArray = () => {
    if (built) return built;
    if (!nulls && (type === "number" || type === "bigint")) return (built = values);
    const out = new Array(numRows);
    for (let row = 0; row < numRows; row++)
      out[row] =
        nulls && !nulls[row] ? null : type === "date" ? new Date(values[row]) : values[row];
    return (built = out);
  };
  const column = Object.freeze({
    length: numRows,
    nullCount,
    type: TYPES[type],
    get: (index) =>
      Number.isInteger(index) && index >= 0 && index < numRows ? toArray()[index] : null,
    toArray,
    toJSON: toArray,
    [Symbol.iterator]: () => toArray()[Symbol.iterator](),
  });
  return { name, column };
}
