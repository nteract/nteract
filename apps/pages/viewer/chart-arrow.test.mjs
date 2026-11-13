// Arrow columns a Parquet reader writes rarely or never (dictionaries of
// decimals and 64-bit integers, negative and zero decimal scales), built
// directly, read through the chart table as the renderer reads them.
// view-embed.test.mjs reads the types DuckDB writes from real Parquet.
import test from "node:test";
import assert from "node:assert/strict";
import { Decimal, Dictionary, Int32, Int64, Table, makeData, makeVector } from "apache-arrow";
import { chartTable, decimalNumber } from "./chart-arrow.mjs";
import { datasetRows } from "./chart-data.mjs";

/** 128-bit two's-complement words, low first, for each BigInt. */
function decimalWords(values) {
  const words = new Uint32Array(values.length * 4);
  values.forEach((value, index) => {
    let rest = BigInt.asUintN(128, value);
    for (let word = 0; word < 4; word++) {
      words[index * 4 + word] = Number(rest & 0xffffffffn);
      rest >>= 32n;
    }
  });
  return words;
}

const decimals = (scale, values) =>
  makeVector(
    makeData({
      type: new Decimal(scale, 38, 128),
      length: values.length,
      data: decimalWords(values),
    }),
  );

const dictionaryOf = (dictionary, indices) =>
  makeVector(
    makeData({
      type: new Dictionary(dictionary.type, new Int32()),
      length: indices.length,
      data: Int32Array.from(indices),
      dictionary,
    }),
  );

const rowsOf = (columns) => datasetRows(chartTable(new Table(columns)));

test("a decimal reads as its number at any scale", () => {
  assert.equal(decimalNumber(1234n, 2), 12.34);
  assert.equal(decimalNumber(-15n, 1), -1.5);
  assert.equal(decimalNumber(42n, 0), 42);
  assert.equal(decimalNumber(7n, -2), 700, "a negative scale multiplies");
  assert.equal(decimalNumber(12345678901234567812n, 2), 123456789012345678.12);
  const rows = rowsOf({
    cents: decimals(2, [1234n, -5n]),
    whole: decimals(0, [42n, -42n]),
    hundreds: decimals(-2, [7n, -3n]),
  });
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { cents: 12.34, whole: 42, hundreds: 700 },
      { cents: -0.05, whole: -42, hundreds: -300 },
    ],
  );
  // Past a safe integer, the value goes through BigInt and reads the same.
  const wide = 12345678901234567812n;
  const [big, small] = rowsOf({ cents: decimals(2, [wide, -(2n ** 53n) + 1n]) });
  assert.equal(big.cents, decimalNumber(wide, 2));
  assert.equal(small.cents, (-(2 ** 53) + 1) / 100);
});

test("a dictionary of decimals reads each value at the dictionary's scale", () => {
  const rows = rowsOf({ price: dictionaryOf(decimals(2, [1234n, 99n]), [1, 0, 1]) });
  assert.deepEqual(
    rows.map((row) => row.price),
    [0.99, 12.34, 0.99],
  );
});

test("a dictionary of 64-bit integers reads as numbers", () => {
  const values = makeVector(BigInt64Array.from([5n, 9007199254740993n]));
  assert.ok(values.type instanceof Int64);
  const rows = rowsOf({ count: dictionaryOf(values, [0, 1, 0]) });
  assert.deepEqual(
    rows.map((row) => row.count),
    [5, 9007199254740992, 5],
  );
});
