// CSV text through the Page's one conversion (csv-arrow.mjs, @nteract/sift-csv)
// to the rows a module view's csv() gives: each value type, quoting, empty
// fields, a header-only file, malformed files, and the behaviours the agent
// guide states.
import assert from "node:assert/strict";
import { test } from "node:test";
import { columnRows } from "@nteract/output-frame/table";
import { csvArrow } from "./csv-arrow.mjs";
import { parquetColumns } from "./parquet-columns.mjs";
import { normalizedBytes, normalizedForm } from "./normalized-bytes.mjs";
import { CSV_UNREADABLE, DATAFRAME_LIMITS } from "./sift-dataset.mjs";
import { isParquet } from "./view-arrow.mjs";

const encode = (value) => new TextEncoder().encode(value);
const rowsOf = async (source, limits = DATAFRAME_LIMITS) =>
  columnRows(await parquetColumns(await csvArrow(encode(source), limits), limits));

test("each CSV column type reads as the value a view gets", async () => {
  const rows = await rowsOf(
    [
      "name,count,ratio,ok,day,at,big",
      '"Ada, ""the first""\nLovelace",1,1.5,true,2024-01-02,2024-01-02T03:04:05,9007199254740993',
      ",,,,,,",
      "Bo,3,2e3,FALSE,2024-02-03,2024-02-03T00:00:00Z,1",
    ].join("\n"),
  );
  assert.deepEqual(rows.columns, ["name", "count", "ratio", "ok", "day", "at", "big"]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    // A quoted field keeps its comma, its doubled quote and its newline.
    name: 'Ada, "the first"\nLovelace',
    count: 1,
    ratio: 1.5,
    ok: true,
    day: new Date("2024-01-02T00:00:00Z"),
    // A timestamp with no zone is read as UTC.
    at: new Date("2024-01-02T03:04:05Z"),
    // A 64-bit integer column with a value past 2^53 stays exact.
    big: 9007199254740993n,
  });
  // An empty field is null in every type.
  assert.deepEqual(rows[1], {
    name: null,
    count: null,
    ratio: null,
    ok: null,
    day: null,
    at: null,
    big: null,
  });
  assert.deepEqual(rows[2].ratio, 2000);
  assert.equal(rows[2].ok, false, "booleans in any case");
});

test("what the guide says about CSV is what a view gets", async () => {
  // A column of digits is numbers: a postal code loses its leading zero.
  const zips = await rowsOf("zip,city\n02134,Boston\n10001,New York\n");
  assert.deepEqual(
    zips.map((row) => row.zip),
    [2134, 10001],
  );
  // The first row is always the header, even when it looks like data.
  const numbers = await rowsOf("1,2\n3,4\n");
  assert.deepEqual(numbers.columns, ["1", "2"]);
  assert.deepEqual([...numbers], [{ 1: 3, 2: 4 }]);
  // Only a comma separates fields: a semicolon file is one text column.
  const semicolons = await rowsOf("a;b\n1;2\n");
  assert.deepEqual(semicolons.columns, ["a;b"]);
  assert.deepEqual([...semicolons], [{ "a;b": "1;2" }]);
  // A leading byte-order mark is skipped; the file must otherwise be UTF-8.
  assert.deepEqual((await rowsOf("﻿a\n1\n")).columns, ["a"]);
  await assert.rejects(csvArrow(Uint8Array.of(0x61, 0x0a, 0xff, 0x0a), DATAFRAME_LIMITS), {
    name: CSV_UNREADABLE,
    message: /can't be read as CSV: .*UTF-8/,
  });
  // A mixed column is text.
  const mixed = await rowsOf("v\n1\nx\n");
  assert.deepEqual(
    mixed.map((row) => row.v),
    ["1", "x"],
  );
});

test("a header-only file has columns and no rows; a malformed file rejects with its reason", async () => {
  const empty = await rowsOf("a,b\n");
  assert.deepEqual(empty.columns, ["a", "b"]);
  assert.equal(empty.length, 0);
  // A blank line is no row, as the Sources preview reads it.
  assert.deepEqual([...(await rowsOf("a\n\n1\n"))], [{ a: 1 }]);
  for (const [source, reason] of [
    ["a,b\n1\n", /unequal lengths/],
    ["", /can't be read as CSV/],
  ])
    await assert.rejects(csvArrow(encode(source), DATAFRAME_LIMITS), (error) => {
      assert.equal(error.name, CSV_UNREADABLE);
      assert.match(error.message, /^This file can't be read as CSV: /);
      assert.match(error.message, reason);
      assert.ok(error.message.length <= 240, "bounded");
      return true;
    });
});

test("a header with a repeated, empty or overlong column name rejects, saying which", async () => {
  const long = "n".repeat(257);
  for (const [source, message] of [
    ["day,day\n1,2\n", "This file can't be read as CSV: two columns are named day."],
    ["a,,b\n1,2,3\n", "This file can't be read as CSV: a column has no name."],
    [",\n1,2\n", "This file can't be read as CSV: a column has no name."],
    [
      `${long}\n1\n`,
      `This file can't be read as CSV: the column ${"n".repeat(40)}… has a name longer than 256 characters.`,
    ],
  ])
    await assert.rejects(csvArrow(encode(source), DATAFRAME_LIMITS), {
      name: CSV_UNREADABLE,
      message,
    });
  // Names that differ only in spaces are different names.
  assert.deepEqual((await rowsOf(" a ,a\n1,2\n")).columns, [" a ", "a"]);
});

test("a quote left open runs to the end of the file as one value", async () => {
  // The parser reads an unclosed quote as a field that ends with the file,
  // so this is one row whose value keeps the newline, not an error.
  const rows = await rowsOf('a\n"x\n');
  assert.deepEqual(rows.columns, ["a"]);
  assert.deepEqual([...rows], [{ a: "x\n" }]);
});

test("every limit is an error; nothing is truncated", async () => {
  const source = encode("a,b\n1,2\n3,4\n5,6\n");
  for (const [limits, reason] of [
    [{ ...DATAFRAME_LIMITS, maxRows: 2 }, /row limit/],
    [{ ...DATAFRAME_LIMITS, maxColumns: 1 }, /column limit/],
    [{ ...DATAFRAME_LIMITS, maxBytes: 4 }, /input byte limit/],
    [{ ...DATAFRAME_LIMITS, maxDecodedBytes: 64 }, /decoded byte limit/],
  ])
    await assert.rejects(csvArrow(source, limits), { name: CSV_UNREADABLE, message: reason });
  assert.equal((await rowsOf("a,b\n1,2\n3,4\n", { ...DATAFRAME_LIMITS, maxRows: 2 })).length, 2);
});

test("normalized bytes are Parquet unchanged, or Arrow IPC for a CSV", async () => {
  const parquet = { media_type: "application/vnd.apache.parquet", asset_id: "a".repeat(64) };
  const csv = { media_type: "text/csv", asset_id: "b".repeat(64) };
  const binary = { media_type: "application/octet-stream", asset_id: "c".repeat(64) };
  const bytes = encode("PAR1 not really");
  const options = { csvArrow: async () => csvArrow };
  assert.equal(await normalizedBytes(parquet, bytes, DATAFRAME_LIMITS, options), bytes);
  const ipc = await normalizedBytes(csv, encode("a\n1\n"), DATAFRAME_LIMITS, options);
  assert.ok(!isParquet(ipc), "Arrow IPC, told apart by the Parquet magic");
  assert.deepEqual([...columnRows(await parquetColumns(ipc, DATAFRAME_LIMITS))], [{ a: 1 }]);
  assert.equal(normalizedForm(binary), null);
  assert.equal(normalizedForm(binary, { asCsv: true }), "csv");
  await assert.rejects(
    normalizedBytes(binary, bytes, DATAFRAME_LIMITS, options),
    /can't show application\/octet-stream/,
  );
  const asCsv = await normalizedBytes(binary, encode("a\n1\n"), DATAFRAME_LIMITS, {
    ...options,
    asCsv: true,
  });
  assert.deepEqual([...asCsv], [...ipc]);
});
