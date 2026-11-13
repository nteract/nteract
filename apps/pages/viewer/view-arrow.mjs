// A chart's decoder for a Parquet source: one Arrow table, columnar, in
// JavaScript memory, with each column in a form Vega reads. The chart
// renderer (vega-chart.mjs datasetRows) turns that table into the row
// objects Vega reads in one pass, so the only other copy is a column this
// module converts. Nothing stays in Sift's WASM store, so the table has
// nothing to dispose.
//
// Columns, by Arrow type:
// - Decimal: numbers, scaled by the field's scale (12.34, not 1234).
// - 64-bit integers: numbers. A value past Number.MAX_SAFE_INTEGER becomes
//   the nearest double, as any chart axis would show it.
// - Time of day: milliseconds since midnight, whatever the stored unit.
// - Date and timestamp: kept; Arrow reads them as epoch milliseconds, which
//   Vega takes as temporal values.
// - Dictionary: kept; Arrow reads each value through its dictionary.
// - List, struct and map: kept; the renderer passes each as plain JSON.
// - Interval and duration: null. A chart has no scale for them.
// - A column named `__proto__` is dropped: as a row key it would set the
//   row's prototype instead of a field.
import { parquetToArrowStream } from "@nteract/sift";
import {
  DataType,
  Float64,
  Table,
  TimeUnit,
  tableFromIPC,
  util,
  vectorFromArray,
} from "apache-arrow";

/** Milliseconds per stored unit of a time-of-day column. */
const MS_PER = {
  [TimeUnit.SECOND]: 1000,
  [TimeUnit.MILLISECOND]: 1,
  [TimeUnit.MICROSECOND]: 1 / 1000,
  [TimeUnit.NANOSECOND]: 1 / 1_000_000,
};

/** How to read one value of a column of `type` as a number, or null to keep
 * the column as it is. */
function numberReader(type) {
  if (DataType.isDecimal(type)) return (value) => util.bigNumToNumber(value, type.scale);
  if (DataType.isInt(type) && type.bitWidth === 64) return (value) => Number(value);
  if (DataType.isTime(type)) return (value) => Number(value) * MS_PER[type.unit];
  if (DataType.isInterval(type) || DataType.isDuration(type)) return () => null;
  return null;
}

/** `table` with each column in the form a chart reads (see above). The
 * table is returned as it is when no column needs a change. */
export function chartTable(table) {
  let changed = false;
  const columns = [];
  for (const [index, field] of table.schema.fields.entries()) {
    if (field.name === "__proto__") {
      changed = true;
      continue;
    }
    const vector = table.getChildAt(index);
    const read = numberReader(field.type);
    if (!read) {
      columns.push([field.name, vector]);
      continue;
    }
    changed = true;
    const values = Array.from({ length: vector.length }, (_, row) => {
      const value = vector.get(row);
      return value === null || value === undefined ? null : read(value);
    });
    columns.push([field.name, vectorFromArray(values, new Float64())]);
  }
  return changed ? new Table(Object.fromEntries(columns)) : table;
}

/** Decode Parquet `bytes` within `limits` (sift-dataset.mjs DATAFRAME_LIMITS)
 * into an Arrow table a chart reads. */
export async function decodeArrow(bytes, { maxBytes, maxRows, maxColumns, maxDecodedBytes } = {}) {
  const ipc = await parquetToArrowStream(bytes, { maxBytes, maxRows, maxColumns, maxDecodedBytes });
  return chartTable(tableFromIPC(ipc));
}
