// A module view's Parquet data name: the page decodes the file to a
// ColumnSet (viewer/parquet-columns.mjs), and the frame's model holds a
// table over it (@nteract/output-frame/table); the data/ import still reads
// the file in ranges. The Parquet files are real: Sift's writer makes them
// (test/parquet-fixture.mjs) and Sift's decoder reads them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import * as Plot from "@observablehq/plot";
import {
  Bool,
  Decimal,
  Dictionary,
  Int32,
  List,
  Field,
  Float64,
  Table,
  Uint64,
  Utf8,
  makeData,
  makeVector,
  tableToIPC,
  vectorFromArray,
} from "apache-arrow";
import { mountModuleOutput } from "@nteract/output-frame";
import { exposeByteSource } from "@nteract/output-frame/byte-source";
import { checkColumnSet, copyColumnSet } from "@nteract/output-frame/column-set";
import { createFrameData, receiveDataChange } from "@nteract/output-frame/data";
import { columnTable } from "@nteract/output-frame/table";
import { preparePayload } from "../../../packages/output-frame/src/payload.mjs";
import { FIRST_DAY_MS, parquetFixture } from "./parquet-fixture.mjs";
import { arrowColumns, parquetColumns } from "../viewer/parquet-columns.mjs";
import { DATAFRAME_LIMITS } from "../viewer/sift-dataset.mjs";

const { createWidgetSession } = await import(
  new URL("./anywidget.mjs", import.meta.resolve("@nteract/output-frame/runtime"))
);

const DAY_MS = 86_400_000;
const noon = (i) => new Date(FIRST_DAY_MS + i * DAY_MS + DAY_MS / 2);
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
async function until(predicate, message) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

const fixture = async (options) => {
  const parquet = parquetFixture(options);
  return { parquet, columns: await parquetColumns(parquet, DATAFRAME_LIMITS) };
};
const file = (bytes) => ({
  byteLength: bytes.byteLength,
  read: async (offset, length) => bytes.slice(offset, offset + length),
});
// The descriptor a host sends for a Parquet file: a port serving its bytes
// and a copy of the ColumnSet decoded from it.
const tableDescriptor = ({ parquet, columns }, lifetime) => ({
  ...exposeByteSource(file(parquet), lifetime),
  columns: structuredClone(copyColumnSet(columns)[0]),
});
const typeOf = (set) => Object.fromEntries(set.columns.map(({ name, type }) => [name, type]));

test("a Parquet file through Sift becomes typed columns: dates, numbers, strings, nulls", async () => {
  const { columns } = await fixture({ days: 6, unsafe: true });
  assert.equal(columns.numRows, 6);
  assert.deepEqual(typeOf(columns), {
    day: "date",
    at: "date",
    at_ms: "date",
    people: "number",
    name: "string",
    score: "number",
    big: "bigint",
  });
  const byName = Object.fromEntries(columns.columns.map((column) => [column.name, column]));
  // date32 and microsecond and millisecond timestamps, in epoch milliseconds.
  assert.deepEqual(
    [...byName.day.values],
    [0, 1, 2, 3, 4, 5].map((i) => FIRST_DAY_MS + i * DAY_MS),
  );
  assert.deepEqual(
    [...byName.at.values],
    [0, 1, 2, 3, 4, 5].map((i) => noon(i).getTime()),
  );
  assert.deepEqual([...byName.at_ms.values], [...byName.at.values]);
  // A safe int64 column is numbers; one past 2^53 is exact BigInts.
  assert.ok(byName.people.values instanceof Float64Array);
  assert.deepEqual([...byName.big.values], [0n, 1n, 2n, 3n, 4n, 2n ** 60n]);
  assert.ok(byName.big.values instanceof BigInt64Array);
  assert.deepEqual(byName.name.values, ["day 1", null, "day 3", "day 4", "day 5", "day 6"]);
  assert.deepEqual([...byName.name.nulls], [1, 0, 1, 1, 1, 1]);
  assert.deepEqual([...byName.score.nulls], [1, 1, 0, 1, 1, 0]);
  assert.equal(byName.people.nulls, undefined, "no mask without nulls");
  assert.equal(checkColumnSet(columns), columns);
});

test("decimals, booleans, unsigned 64-bit, dictionaries and lists", () => {
  const rows = 3;
  // 1.25, -3.50 and 10.00 at scale 2, as 128-bit little-endian words.
  const words = new Uint32Array(rows * 4);
  [125, -350, 1000].forEach((value, row) => {
    const big = BigInt.asUintN(128, BigInt(value));
    for (let word = 0; word < 4; word++)
      words[row * 4 + word] = Number((big >> BigInt(32 * word)) & 0xffffffffn);
  });
  const dictionary = vectorFromArray(
    ["red", "blue", "red"],
    new Dictionary(new Utf8(), new Int32()),
  );
  const table = new Table({
    price: makeVector(makeData({ type: new Decimal(2, 10, 128), length: rows, data: words })),
    ok: vectorFromArray([true, null, false], new Bool()),
    small: makeVector(
      makeData({ type: new Uint64(), length: rows, data: new BigUint64Array([1n, 2n, 3n]) }),
    ),
    huge: makeVector(
      makeData({
        type: new Uint64(),
        length: rows,
        data: new BigUint64Array([1n, 2n ** 63n + 5n, 3n]),
      }),
    ),
    color: dictionary,
    tags: vectorFromArray([[1, 2], [], [3]], new List(new Field("item", new Int32()))),
  });
  const set = arrowColumns(tableToIPC(table, "stream"));
  assert.deepEqual(typeOf(set), {
    price: "number",
    ok: "boolean",
    small: "number",
    huge: "bigint",
    color: "string",
    tags: "other",
  });
  const byName = Object.fromEntries(set.columns.map((column) => [column.name, column]));
  assert.deepEqual([...byName.price.values], [1.25, -3.5, 10]);
  assert.deepEqual(byName.ok.values, [true, null, false]);
  assert.deepEqual([...byName.small.values], [1, 2, 3]);
  assert.ok(byName.huge.values instanceof BigUint64Array);
  assert.equal(byName.huge.values[1], 2n ** 63n + 5n, "exact");
  assert.deepEqual(byName.color.values, ["red", "blue", "red"]);
  assert.deepEqual(byName.tags.values, [[1, 2], [], [3]]);
  checkColumnSet(set);
  assert.deepEqual(structuredClone(set), set, "structured-cloneable");
});

test("a malformed ColumnSet is refused", () => {
  const good = () => ({
    numRows: 2,
    columns: [
      { name: "n", type: "number", values: new Float64Array([1, 2]) },
      { name: "s", type: "string", values: ["a", null], nulls: new Uint8Array([1, 0]) },
    ],
  });
  checkColumnSet(good());
  const cases = [
    null,
    [],
    { ...good(), numRows: -1 },
    { ...good(), numRows: 1.5 },
    { ...good(), columns: {} },
    {
      numRows: 0,
      columns: Array.from({ length: 257 }, (_, i) => ({
        name: "c" + i,
        type: "string",
        values: [],
      })),
    },
  ];
  const column = (patch, index = 0) => {
    const set = good();
    set.columns[index] = { ...set.columns[index], ...patch };
    return set;
  };
  cases.push(
    column({ values: new Float64Array([1]) }),
    column({ values: [1, 2] }),
    column({ type: "decimal" }),
    column({ type: "bigint" }),
    column({ name: 7 }),
    column({ name: "" }),
    column({ name: "x".repeat(257) }),
    column({ name: "__proto__" }),
    column({ name: "s" }),
    column({ nulls: new Uint8Array([1]) }),
    column({ nulls: new Uint8Array([1, 2]) }),
    column({ nulls: [1, 1] }),
    column({ values: ["a", 1], nulls: undefined }, 1),
    column({ values: ["a", "b"] }, 1),
    column({ type: "boolean", values: [true, "no"], nulls: undefined }, 1),
  );
  for (const set of cases) assert.throws(() => checkColumnSet(set), /Invalid column set/);
});

test("the table: names, rows and columns built once, nulls, Dates and BigInts; the interface is frozen, the values are the view's", async () => {
  const { columns } = await fixture({ days: 4, unsafe: true });
  const table = columnTable(columns);
  assert.ok(Object.isFrozen(table));
  assert.equal(table.numRows, 4);
  assert.equal(table.numCols, 7);
  assert.deepEqual(
    table.schema.fields.map((field) => field.name),
    ["day", "at", "at_ms", "people", "name", "score", "big"],
  );
  const at = table.getChild("at");
  assert.deepEqual(at.toArray(), [0, 1, 2, 3].map(noon));
  assert.ok(at.get(0) instanceof Date);
  assert.deepEqual({ ...at.type }, { typeId: 10, unit: 1, kind: "date" });
  const score = table.getChild("score");
  assert.deepEqual(score.toJSON(), [0, 0.5, null, 1.5]);
  assert.equal(score.nullCount, 1);
  assert.equal(score.length, 4);
  assert.equal(score.get(2), null);
  assert.equal(score.get(9), null, "out of range");
  assert.ok(table.getChild("people").toArray() instanceof Float64Array, "no nulls: typed array");
  assert.deepEqual([...table.getChild("people")], [3, 8, 13, 7]);
  assert.deepEqual([...table.getChild("big")], [0n, 1n, 2n, 2n ** 60n]);
  assert.equal(score.toArray(), score.toArray(), "built once");
  assert.ok(Object.isFrozen(score) && !Object.isFrozen(score.toArray()));
  assert.equal(table.getChild("missing"), null);
  assert.equal(table.getChildAt(7), null);
  assert.equal(table.getChildAt(1), at);
  const picked = table.select(["score", "missing", "day"]);
  assert.equal(picked.numCols, 2, "an unknown name is skipped");
  assert.equal(picked.getChild("score"), score, "select shares the columns");
  assert.equal(table.get(9), null);
  const rows = table.toArray();
  assert.equal(table.toArray(), rows, "built once");
  // A view may add a derived field to its rows, as with any array of objects.
  assert.ok(!Object.isFrozen(rows) && !Object.isFrozen(rows[0]));
  rows[0].derived = 1;
  assert.equal(table.toArray()[0].derived, 1);
  assert.deepEqual(rows[1], {
    day: new Date(FIRST_DAY_MS + DAY_MS),
    at: noon(1),
    at_ms: noon(1),
    people: 8,
    name: null,
    score: 0.5,
    big: 1n,
  });
  assert.equal(table.get(1), rows[1]);
  assert.deepEqual([...table], rows);
  assert.throws(() =>
    columnTable({ numRows: 1, columns: [{ name: "x", type: "date", values: [1] }] }),
  );
});

test("an author snippet reads our table as it reads an apache-arrow table of the same data", () => {
  const data = { x: [1, 2, null, 4], label: ["a", "b", "c", null] };
  const ours = columnTable({
    numRows: 4,
    columns: [
      {
        name: "x",
        type: "number",
        values: new Float64Array([1, 2, 0, 4]),
        nulls: new Uint8Array([1, 1, 0, 1]),
      },
      {
        name: "label",
        type: "string",
        values: ["a", "b", "c", null],
        nulls: new Uint8Array([1, 1, 1, 0]),
      },
    ],
  });
  const theirs = new Table({
    x: vectorFromArray(data.x, new Float64()),
    label: vectorFromArray(data.label, new Utf8()),
  });
  // What the reference says agrees: column values through toJSON and
  // iteration, numRows, numCols, field names, select, rows as plain values.
  const snippet = (table) => ({
    x: table.getChild("x").toJSON(),
    iterated: [...table.getChild("label")],
    numRows: table.numRows,
    rows: [...table].map((row) => ({ ...(row.toJSON?.() ?? row) })),
    names: table.schema.fields.map((f) => f.name),
    selected: table.select(["x"]).numCols,
    skipped: table.select(["x", "nope"]).numCols,
    missing: table.getChild("nope"),
    nullCount: table.getChild("x").nullCount,
    typeId: table.getChild("label").type.typeId,
    row: { ...(table.get(1).toJSON?.() ?? table.get(1)) },
  });
  assert.deepEqual(snippet(ours), snippet(theirs));
  assert.deepEqual(snippet(ours).x, [1, 2, null, 4]);
});

test("Plot draws the table:a string x and int64 y, a time axis, and a column with nulls", async () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const { columns } = await fixture({ days: 6 });
  const table = columnTable(columns);
  const bars = Plot.barY(table, { x: "name", y: "people" }).plot({ document: window.document });
  assert.equal(bars.scale("x").type, "band");
  assert.equal(bars.querySelectorAll("g[aria-label='bar'] rect").length, 6, "a bar per row");
  // The same chart Plot draws from plain rows, a null name included.
  const plain = Plot.barY(
    table.toArray().map((row) => ({ ...row })),
    {
      x: "name",
      y: "people",
    },
  ).plot({ document: window.document });
  assert.deepEqual(bars.scale("x").domain, plain.scale("x").domain);
  assert.ok(bars.scale("x").domain.includes("day 6"));
  assert.deepEqual(bars.scale("y").domain, [0, 13]);
  const dots = Plot.plot({
    document: window.document,
    marks: [Plot.dot(table, { x: "at", y: "score" }), Plot.lineY(table, { x: "day", y: "score" })],
  });
  assert.equal(dots.scale("x").type, "utc");
  assert.deepEqual(dots.scale("x").domain, [new Date(FIRST_DAY_MS), noon(5)]);
  assert.equal(dots.querySelectorAll("circle").length, 4, "a dot per present score");
  assert.ok(dots.querySelector("path"));
  // A function channel reads rows.
  const text = Plot.text(table, { x: "at", y: "people", text: (d) => d.name ?? "none" }).plot({
    document: window.document,
  });
  assert.deepEqual(
    [...text.querySelectorAll("text")]
      .map((node) => node.textContent)
      .filter((t) => /^day|none/.test(t)),
    ["day 1", "none", "day 3", "day 4", "day 5", "day 6"],
  );
});

const modulePayload = {
  kind: "module",
  assets: {
    entry: {
      bytes: new TextEncoder().encode("export function render() {}"),
      mediaType: "text/javascript",
    },
  },
};

test("frame data: a Parquet input is a table on the model and a ranged import", async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const first = await fixture({ days: 5 });
  const frameData = createFrameData(
    { "data/activity": tableDescriptor(first, lifetime.signal) },
    lifetime.signal,
  );
  const { handle, value } = frameData.initial["data/activity"];
  assert.equal(value.numRows, 5);
  assert.equal(handle.byteLength, first.parquet.byteLength);
  assert.equal(new TextDecoder().decode(await handle.read(0, 4)), "PAR1");
  const end = first.parquet.byteLength;
  assert.equal(new TextDecoder().decode(await handle.read(end - 4, 4)), "PAR1");
});

test("a malformed ColumnSet in a descriptor is refused and its port closes", async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const good = await fixture();
  for (const columns of [
    "x",
    null,
    { numRows: 1, columns: [{ name: "a", type: "number", values: [1] }] },
  ]) {
    const descriptor = { ...exposeByteSource(file(good.parquet), lifetime.signal), columns };
    let closed = false;
    const close = descriptor.port.close.bind(descriptor.port);
    descriptor.port.close = () => {
      closed = true;
      close();
    };
    assert.throws(() => createFrameData({ "data/activity": descriptor }, lifetime.signal));
    assert.ok(closed, `the port closes for ${JSON.stringify(columns)}`);
  }
});

test("a Parquet data change swaps the table and fires change:<alias>; a bad one keeps the old", async (t) => {
  const lifetime = new AbortController();
  const dom = new JSDOM("<main></main>");
  t.after(() => {
    lifetime.abort();
    dom.window.close();
  });
  const first = await fixture({ days: 5 });
  const second = await fixture({ days: 9 });
  const frameData = createFrameData(
    { "data/activity": tableDescriptor(first, lifetime.signal) },
    lifetime.signal,
  );
  const imported = frameData.initial["data/activity"].handle;
  const session = createWidgetSession(
    {
      ...preparePayload(modulePayload),
      state: { activity: frameData.initial["data/activity"].value },
    },
    {
      document: dom.window.document,
      signal: lifetime.signal,
      loadModule: async () => ({
        render({ model, el }) {
          const draw = () => (el.textContent = String(model.get("activity").numRows));
          model.on("change:activity", draw);
          draw();
        },
      }),
      diagnostic: () => {},
    },
  );
  await session.initialize();
  const el = dom.window.document.querySelector("main");
  await session.render(el);
  assert.equal(el.textContent, "5");
  const send = () => assert.fail("a listened change is never answered");
  const change = (input) =>
    receiveDataChange({ name: "data/activity", input }, { session, frameData, send });
  // A ColumnSet the frame refuses changes nothing: the table and the import stay.
  assert.throws(() =>
    change({ ...exposeByteSource(file(second.parquet), lifetime.signal), columns: { numRows: 1 } }),
  );
  assert.equal(el.textContent, "5");
  assert.equal(new TextDecoder().decode(await imported.read(0, 4)), "PAR1");
  assert.equal(change(tableDescriptor(second, lifetime.signal)), "apply");
  assert.equal(el.textContent, "9");
  // The import stays bound to the mount-time file, whose reads now abort.
  await assert.rejects(imported.read(0, 4), { name: "AbortError" });
});

function mountWithFakeFrame(t, byteSources) {
  const dom = new JSDOM("<main></main>", { url: "https://host.example/" });
  const output = mountModuleOutput(dom.window.document.querySelector("main"), modulePayload, {
    frameUrl: "https://outputs.example/frame/v2/",
    hostContext: { theme: "light" },
    byteSources,
  });
  const frame = { port: null, messages: [] };
  t.after(() => {
    output.destroy();
    frame.port?.close();
    dom.window.close();
  });
  Object.defineProperty(output.frame, "contentWindow", {
    value: {
      postMessage(message, _origin, [port]) {
        frame.port = port;
        port.onmessage = ({ data }) => frame.messages.push(data);
        port.postMessage({ type: "connected" });
      },
    },
  });
  output.frame.dispatchEvent(new dom.window.Event("load"));
  return { output, frame };
}

test("the host sends a Parquet input as one descriptor: a file port and a copy of its columns", async (t) => {
  const first = await fixture({ days: 4 });
  const second = await fixture({ days: 6 });
  const input = { file: file(first.parquet), columns: first.columns };
  const { output, frame } = mountWithFakeFrame(t, { "data/activity": input });
  await until(() => frame.messages.some((m) => m.type === "mount"), "no mount message");
  const sent = frame.messages.find((m) => m.type === "mount").files["data/activity"];
  assert.deepEqual(Object.keys(sent).sort(), ["byteLength", "columns", "port"]);
  assert.equal(sent.byteLength, first.parquet.byteLength);
  assert.deepEqual(sent.columns, first.columns);
  // The typed arrays went as transferred copies: the cached set is intact.
  assert.equal(first.columns.columns[0].values.length, 4);
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const frameData = createFrameData({ "data/activity": sent }, lifetime.signal);
  assert.equal(frameData.initial["data/activity"].value.numRows, 4);
  assert.equal(
    new TextDecoder().decode(await frameData.initial["data/activity"].handle.read(0, 4)),
    "PAR1",
  );
  for (const bad of [
    { file: file(second.parquet), columns: "x" },
    {
      file: file(second.parquet),
      columns: { numRows: 2, columns: [{ name: "a", type: "x", values: [] }] },
    },
    { file: { byteLength: 1 }, columns: second.columns },
    { columns: second.columns },
  ])
    assert.throws(() => output.setData("data/activity", bad), /column set|\{file, columns\} table/);
  for (const event of ["loaded", "initialized", "rendered"])
    frame.port.postMessage({ type: "phase", event });
  await until(() => output.state === "ready", "never ready");
  output.setData("data/activity", { file: file(second.parquet), columns: second.columns });
  await until(() => frame.messages.some((m) => m.type === "data"), "the change was not sent");
  const change = frame.messages.find((m) => m.type === "data");
  assert.equal(change.input.byteLength, second.parquet.byteLength);
  assert.equal(frameData.replace("data/activity", change.input).value.numRows, 6);
});
