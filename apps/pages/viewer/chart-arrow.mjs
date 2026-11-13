// A chart's view of an Arrow table: Arrow's shape, with each value converted,
// as it is read, to a form Vega reads. The chart Worker
// (chart-dataflow.mjs) reads a chart's Arrow IPC bytes through `chartTable`,
// and `datasetRows` copies them into the row objects Vega reads in one pass,
// so no column is copied first. Arrow only: no DOM, no WASM.
//
// Values, by Arrow type:
// - Decimal: numbers, scaled by the field's scale (12.34, not 1234; a
//   negative scale multiplies).
// - 64-bit integers: numbers. A value past Number.MAX_SAFE_INTEGER becomes
//   the nearest double, as any chart axis would show it.
// - Time of day: milliseconds since midnight, whatever the stored unit.
// - Date and timestamp: epoch milliseconds, which Vega takes as temporal
//   values. Arrow reads every unit (second to nanosecond) to milliseconds,
//   keeping a fraction below one. A timestamp with a time zone is stored as
//   the UTC instant; one without reads as that wall time in UTC.
// - Dictionary: its values, converted by the dictionary's value type.
// - List, struct and map: plain arrays and objects, each value converted by
//   its own type, so a 64-bit integer or a decimal inside reads as a number.
// - Interval and duration: null. A chart has no scale for them.
// - Anything else: as Arrow reads it.
// A column or struct field named `__proto__` is dropped: as a key it would
// set an object's prototype instead of a field.
import { DataType, TimeUnit } from "apache-arrow";

/** Milliseconds per stored unit of a time-of-day column. */
const MS_PER = {
  [TimeUnit.SECOND]: 1000,
  [TimeUnit.MILLISECOND]: 1,
  [TimeUnit.MICROSECOND]: 1 / 1000,
  [TimeUnit.NANOSECOND]: 1 / 1_000_000,
};

const DROPPED = "__proto__";

/** A decimal's unscaled value `big` at `scale`, as a number. The whole and
 * fractional parts convert apart, so a wide decimal keeps its cents. */
export function decimalNumber(big, scale) {
  if (scale <= 0) return Number(big) * 10 ** -scale;
  const unit = 10n ** BigInt(scale);
  return Number(big / unit) + Number(big % unit) / Number(unit);
}

/** A decimal's stored words (32-bit, low first, two's complement) as the
 * signed BigInt they hold. */
const unscaled = (words) => {
  let big = 0n;
  for (let index = words.length - 1; index >= 0; index--) big = (big << 32n) | BigInt(words[index]);
  return BigInt.asIntN(words.length * 32, big);
};

const TWO_32 = 2 ** 32;
const SAFE_HIGH = 2 ** 21;

/** A decimal's value at `scale`. When its unscaled value is a safe integer
 * (every high word is the low two's sign) and 10 ** scale is exact, one
 * double division gives the nearest number; anything wider goes through
 * BigInt. */
const decimalValue = (words, scale) => {
  const high = words[1] | 0;
  const sign = high < 0 ? 0xffffffff : 0;
  let small = Math.abs(scale) <= 22 && high > -SAFE_HIGH && high < SAFE_HIGH;
  for (let index = 2; small && index < words.length; index++) small = words[index] === sign;
  if (!small) return decimalNumber(unscaled(words), scale);
  const whole = high * TWO_32 + words[0];
  return scale <= 0 ? whole * 10 ** -scale : whole / 10 ** scale;
};

/** Any BigInt in `value`, nested or not, as a number. */
const plain = (value) => {
  if (typeof value === "bigint") return Number(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(plain);
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) if (key !== DROPPED) out[key] = plain(item);
  return out;
};

const same = (value) => value;
const nullable = (read) => (value) => (value === null || value === undefined ? null : read(value));

/** How to read one value of `type` as a chart reads it. */
export function chartReader(type) {
  if (DataType.isDictionary(type)) return chartReader(type.dictionary);
  if (DataType.isDecimal(type)) return nullable((value) => decimalValue(value, type.scale));
  if (DataType.isInt(type) && type.bitWidth === 64) return nullable(Number);
  if (DataType.isTime(type)) return nullable((value) => Number(value) * MS_PER[type.unit]);
  if (DataType.isDate(type) || DataType.isTimestamp(type)) return nullable(Number);
  if (DataType.isInterval(type) || DataType.isDuration(type)) return () => null;
  if (DataType.isList(type) || DataType.isFixedSizeList(type)) {
    const item = chartReader(type.children[0].type);
    return nullable((list) =>
      Array.from({ length: list.length }, (_, index) => item(list.get(index))),
    );
  }
  if (DataType.isStruct(type)) {
    // Fields are read by position through the row's iterator. Arrow's
    // StructRow resolves a name as its own member first, so `row.toJSON` is
    // a method even when a field has that name.
    const fields = type.children.map((field) => [field.name, chartReader(field.type)]);
    return nullable((row) => {
      const out = Object.create(null);
      let index = 0;
      for (const [, value] of row) {
        const [name, read] = fields[index++];
        if (name !== DROPPED) out[name] = read(value);
      }
      return out;
    });
  }
  if (DataType.isMap(type)) {
    // A key is named by its stored value's own text (a BigInt's full
    // digits), so two keys a chart number can't tell apart stay apart. Only
    // values convert.
    const item = chartReader(type.children[0].type.children[1].type);
    return nullable((map) => {
      const out = Object.create(null);
      for (const [key, value] of map) {
        const name = String(key);
        if (name !== DROPPED) out[name] = item(value);
      }
      return out;
    });
  }
  if (DataType.isUnion(type)) return nullable(plain);
  return same;
}

/**
 * `table` as a chart table: Arrow's shape (`schema.fields`, `numRows`,
 * `getChildAt(index).get(row)`) with each value read as a chart reads it
 * (see above), converted when the renderer reads it.
 */
export function chartTable(table) {
  const columns = table.schema.fields
    .map((field, index) => ({ field, vector: table.getChildAt(index) }))
    .filter(({ field }) => field.name !== DROPPED)
    .map(({ field, vector }) => {
      const read = chartReader(field.type);
      return {
        field,
        column:
          read === same
            ? vector
            : { length: vector?.length ?? 0, get: (row) => read(vector?.get(row) ?? null) },
      };
    });
  return Object.freeze({
    schema: Object.freeze({ fields: columns.map(({ field }) => field) }),
    numRows: table.numRows,
    numCols: columns.length,
    getChildAt: (index) => columns[index]?.column ?? null,
  });
}
