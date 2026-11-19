// A Parquet file as a ColumnSet (@nteract/output-frame/column-set): the
// table a module view's model holds. Sift decodes the Parquet bytes to one
// Arrow IPC stream (view-arrow.mjs, as a chart does), and apache-arrow reads
// that stream here. parquetColumns is the only entry point, so a decoder
// that yields columns directly can replace its inside alone.
//
// Types, by Arrow type (a dictionary by its value type):
// - 64-bit integers, signed or not: "number" when every value is a safe
//   integer (within ±(2^53 − 1)), else "bigint", exact.
// - Other integers, floats, decimals and times of day: "number", read as a
//   chart reads them (chart-arrow.mjs chartReader): a decimal is the nearest
//   float, a time of day is milliseconds since midnight.
// - Dates and timestamps of every unit: "date", epoch milliseconds.
// - Strings: "string". Booleans: "boolean".
// - Anything else: "other", each value as a chart reads it (lists, structs
//   and maps as plain arrays and objects, binary as its own bytes).
// A column named `__proto__` is dropped, as a chart drops it.
import { checkColumnSet } from "@nteract/output-frame/column-set";
import { DataType, tableFromIPC } from "apache-arrow";
import { chartReader } from "./chart-arrow.mjs";
import { decodeArrow } from "./view-arrow.mjs";

const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Decode Parquet `bytes` within `limits` (sift-dataset.mjs DATAFRAME_LIMITS)
 * into a ColumnSet, checked once here: the shared cache keeps it, and the
 * parent copies it to each frame without checking it again. */
export async function parquetColumns(bytes, limits) {
  return checkColumnSet(arrowColumns(await decodeArrow(bytes, limits)));
}

/** The ColumnSet of one Arrow IPC stream. */
export function arrowColumns(ipc) {
  const table = tableFromIPC(ipc);
  const numRows = table.numRows;
  const columns = [];
  table.schema.fields.forEach((field, index) => {
    if (field.name === "__proto__") return;
    columns.push(arrowColumn(field, table.getChildAt(index), numRows));
  });
  return { numRows, columns };
}

function columnType(type) {
  const base = DataType.isDictionary(type) ? type.dictionary : type;
  if (DataType.isInt(base) && base.bitWidth === 64) return "int64";
  if (DataType.isInt(base) || DataType.isFloat(base) || DataType.isDecimal(base)) return "number";
  if (DataType.isTime(base)) return "number";
  if (DataType.isDate(base) || DataType.isTimestamp(base)) return "date";
  if (DataType.isUtf8(base) || DataType.isLargeUtf8?.(base)) return "string";
  if (DataType.isBool(base)) return "boolean";
  return "other";
}

function arrowColumn(field, vector, numRows) {
  const kind = columnType(field.type);
  const present = new Uint8Array(numRows);
  let missing = 0;
  for (let row = 0; row < numRows; row++)
    if (vector.isValid(row)) present[row] = 1;
    else missing++;
  const nulls = missing ? { nulls: present } : {};
  const has = (row) => present[row] === 1;
  if (kind === "int64") {
    const raw = new Array(numRows);
    let safe = true;
    for (let row = 0; row < numRows; row++) {
      const value = has(row) ? BigInt(vector.get(row)) : 0n;
      raw[row] = value;
      if (value > SAFE || value < -SAFE) safe = false;
    }
    if (safe)
      return { name: field.name, type: "number", values: Float64Array.from(raw, Number), ...nulls };
    // A dictionary's sign is its value type's.
    const base = DataType.isDictionary(field.type) ? field.type.dictionary : field.type;
    const Values = base.isSigned === false ? BigUint64Array : BigInt64Array;
    return { name: field.name, type: "bigint", values: Values.from(raw), ...nulls };
  }
  const read = chartReader(field.type);
  if (kind === "number" || kind === "date") {
    const values = new Float64Array(numRows);
    for (let row = 0; row < numRows; row++) if (has(row)) values[row] = read(vector.get(row));
    return { name: field.name, type: kind, values, ...nulls };
  }
  const values = new Array(numRows);
  for (let row = 0; row < numRows; row++) {
    if (!has(row)) values[row] = null;
    else if (kind === "other") {
      const value = read(vector.get(row));
      // A byte view would carry its whole IPC buffer through a clone.
      values[row] = ArrayBuffer.isView(value) ? value.slice() : value;
    } else values[row] = vector.get(row);
  }
  return { name: field.name, type: kind, values, ...nulls };
}
