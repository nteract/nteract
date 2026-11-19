// A module view's bound file in the frame: a file object (file-object.mjs)
// that asks its port for a range, the whole file or a table only when a
// member is called, and the host's whole-file total for a view's files.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { parquet_footer_length, parquet_footer_summary } from "#sift-wasm";
import { mountModuleOutput } from "@nteract/output-frame";
import { exposeFile, receiveFile } from "@nteract/output-frame/byte-source";
import { createFrameData, receiveDataChange } from "@nteract/output-frame/data";
import { fileObject } from "@nteract/output-frame/file-object";
import { NO_WHOLE_FILES, wholeFileTransition } from "@nteract/output-frame/whole-file-total";
import { preparePayload } from "../../../packages/output-frame/src/payload.mjs";
import { parquetFixture } from "./parquet-fixture.mjs";
import { parquetColumns } from "../viewer/parquet-columns.mjs";
import { csvArrow } from "../viewer/csv-arrow.mjs";
import { DATAFRAME_LIMITS } from "../viewer/sift-dataset.mjs";

const { createWidgetSession } = await import(
  new URL("./anywidget.mjs", import.meta.resolve("@nteract/output-frame/runtime"))
);

const text = (value) => new TextEncoder().encode(value);
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
async function until(predicate, message) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

// A file input over `bytes` that counts each kind of request it serves.
function memoryFile(bytes, { mimeType = "application/octet-stream", columns } = {}) {
  const served = { range: 0, bytes: 0, columns: 0 };
  return {
    served,
    input: {
      mimeType,
      byteLength: bytes.byteLength,
      async read(offset, length) {
        served.range++;
        return bytes.slice(offset, offset + length);
      },
      async bytes() {
        served.bytes++;
        return bytes.slice();
      },
      ...(columns && {
        async columns(format) {
          served.columns++;
          return columns(format);
        },
      }),
    },
  };
}

// The descriptor a host sends for `input`, with every message the frame
// posts on its port counted.
function exposed(input, lifetime) {
  const descriptor = exposeFile(input, lifetime);
  const sent = [];
  const post = descriptor.port.postMessage.bind(descriptor.port);
  descriptor.port.postMessage = (message, transfer) => {
    sent.push(message);
    post(message, transfer);
  };
  return { descriptor, sent };
}

const parquetInput = async (days) => {
  const parquet = parquetFixture({ days });
  const set = await parquetColumns(parquet, DATAFRAME_LIMITS);
  return memoryFile(parquet, { mimeType: "application/vnd.apache.parquet", columns: () => set });
};

test("a file object knows its name, type and size and asks nothing until called", async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const { input, served } = memoryFile(text('{"greeting":"hi"}'));
  const { descriptor, sent } = exposed(input, lifetime.signal);
  const file = fileObject("config", descriptor, lifetime.signal);
  assert.ok(Object.isFrozen(file));
  assert.deepEqual(
    { name: file.name, mimeType: file.mimeType, size: file.size, byteLength: file.byteLength },
    { name: "config", mimeType: "application/octet-stream", size: 17, byteLength: 17 },
  );
  assert.deepEqual(Object.keys(file).sort(), [
    "arrayBuffer",
    "byteLength",
    "csv",
    "json",
    "mimeType",
    "name",
    "parquet",
    "read",
    "size",
    "slice",
    "text",
  ]);
  await tick();
  assert.deepEqual(sent, [], "no request before a member is called");
  assert.deepEqual(served, { range: 0, bytes: 0, columns: 0 });
  // text(), json() and arrayBuffer() share one whole-file request.
  assert.equal(file.text(), file.text(), "the same promise");
  assert.equal(file.json(), file.json());
  assert.deepEqual(await file.json(), { greeting: "hi" });
  const first = await file.arrayBuffer();
  new Uint8Array(first).fill(0);
  const second = await file.arrayBuffer();
  assert.notEqual(first, second, "a fresh copy per call");
  assert.equal(await file.text(), '{"greeting":"hi"}', "a written copy changes nothing else");
  assert.equal(new TextDecoder().decode(second), '{"greeting":"hi"}');
  assert.deepEqual(served, { range: 0, bytes: 1, columns: 0 });
  assert.deepEqual(
    sent.map(({ kind }) => kind),
    ["bytes"],
  );
  // Not Parquet, and options refused rather than ignored.
  await assert.rejects(file.parquet(), { message: "This file is not Parquet." });
  await assert.rejects(file.parquet({ columns: ["a"] }), /takes no options yet/);
  await assert.rejects(file.csv(), { message: "This file is not CSV." });
});

test("parquet() gives the table once, and a file object is a Sift byte source", async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const { input, served } = await parquetInput(6);
  const { descriptor } = exposed(input, lifetime.signal);
  const file = fileObject("activity", descriptor, lifetime.signal);
  const table = file.parquet();
  assert.equal(file.parquet(), table, "the same promise");
  assert.equal((await table).numRows, 6);
  assert.deepEqual(
    (await table).schema.fields.map((field) => field.name),
    ["day", "at", "at_ms", "people", "name", "score"],
  );
  assert.equal(served.columns, 1);
  // The byte-source shape Sift takes: a byteLength and a read that gives
  // that range as a Uint8Array.
  assert.equal(typeof file.byteLength, "number");
  const head = await file.read(0, 4);
  assert.ok(head instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(head), "PAR1");
  await assert.rejects(file.read(-1, 2), { message: "Invalid file read." });
  // Sift's WASM reads the Parquet footer from the file object's ranges, as
  // its ranged loader begins. (loadTableFile itself needs a canvas.)
  const footer = parquet_footer_length(await file.read(file.byteLength - 8, 8));
  assert.ok(footer > 0 && footer < file.byteLength);
  const tail = await file.read(file.byteLength - 8 - footer, footer + 8);
  const summary = parquet_footer_summary(tail, file.byteLength);
  assert.ok(summary && typeof summary === "object", "Sift reads the footer from read()");
});

// A file input over CSV `source` that decodes as the Page does: Sift's CSV
// parser to Arrow IPC (csv-arrow.mjs), then the ColumnSet the frame reads.
// It answers a Parquet request as the Page does for a file that is not one.
const csvInput = (source, mimeType = "text/csv") =>
  memoryFile(text(source), {
    mimeType,
    columns: async (format) => {
      if (format !== "csv") throw Error("This file is not Parquet.");
      return parquetColumns(await csvArrow(text(source), DATAFRAME_LIMITS), DATAFRAME_LIMITS);
    },
  });

test("csv() gives typed rows with columns, once per file object", async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const { input, served } = csvInput(
    "city,people,share,open,day\nOslo,3,0.5,true,2024-05-01\nBergen,,1.25,FALSE,\n",
  );
  const { descriptor, sent } = exposed(input, lifetime.signal);
  const file = fileObject("cities", descriptor, lifetime.signal);
  await tick();
  assert.deepEqual(sent, [], "nothing is asked until csv() is called");
  const rows = file.csv();
  assert.equal(file.csv(), rows, "the same promise while pending");
  assert.equal(file.csv({ typed: true }), rows, "{ typed: true } is the same call");
  assert.equal(file.csv({}), rows, "an empty options object is the same call");
  const data = await rows;
  assert.ok(Array.isArray(data));
  assert.deepEqual(data.columns, ["city", "people", "share", "open", "day"]);
  assert.deepEqual(data[0], {
    city: "Oslo",
    people: 3,
    share: 0.5,
    open: true,
    day: new Date("2024-05-01T00:00:00Z"),
  });
  assert.deepEqual(data[1], { city: "Bergen", people: null, share: 1.25, open: false, day: null });
  // Code written for Observable's FileAttachment.csv reads it as it is.
  assert.deepEqual(
    data.filter((row) => row.open).map((row) => row.city),
    ["Oslo"],
  );
  assert.equal(file.csv(), rows, "the same promise after it resolves");
  assert.equal(served.columns, 1);
  assert.deepEqual(sent, [{ kind: "columns", format: "csv" }]);
  // parquet() asks for its own format, and the Page refuses a CSV.
  await assert.rejects(file.parquet(), { message: "This file is not Parquet." });
});

test("csv() takes {} or { typed: true } and refuses any other option, naming it", async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const { input, served } = csvInput("a\n1\n");
  const file = fileObject("a", exposed(input, lifetime.signal).descriptor, lifetime.signal);
  for (const [options, message] of [
    [[{ typed: false }], /typed option must be true/],
    [[{ typed: "auto" }], /typed option must be true/],
    [[{ typed: undefined }], /typed option must be true/],
    [[{ array: true }], /csv\(\) has no array option/],
    [[{ typed: true, delimiter: ";" }], /csv\(\) has no delimiter option/],
    [[true], /takes an options object/],
    [[[]], /takes an options object/],
    [[{ typed: true }, {}], /takes one options object/],
  ])
    await assert.rejects(file.csv(...options), message, JSON.stringify(options));
  assert.equal(served.columns, 0, "a refused call asks nothing");
  assert.deepEqual((await file.csv(undefined)).columns, ["a"]);
  assert.deepEqual((await file.csv({})).columns, ["a"]);
});

test("csv() reads a file of any media type, and one that does not parse rejects plainly", async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const binary = csvInput("name,n\nx,1\n", "application/octet-stream");
  const file = fileObject(
    "old",
    exposed(binary.input, lifetime.signal).descriptor,
    lifetime.signal,
  );
  assert.deepEqual(
    await file.csv(),
    Object.assign([{ name: "x", n: 1 }], { columns: ["name", "n"] }),
  );
  const ragged = csvInput("a,b\n1\n");
  const broken = fileObject(
    "bad",
    exposed(ragged.input, lifetime.signal).descriptor,
    lifetime.signal,
  );
  const first = broken.csv();
  await assert.rejects(
    first,
    /^Error: This file can't be read as CSV: Encountered unequal lengths/,
  );
  assert.notEqual(broken.csv(), first, "a rejection is dropped, so the next call asks again");
  await assert.rejects(broken.csv(), /can't be read as CSV/);
  assert.equal(ragged.served.columns, 2);
});

test("parquet() and csv() on one file each read their own format once", async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const set = {
    numRows: 1,
    columns: [{ name: "n", type: "number", values: new Float64Array([7]) }],
  };
  const asked = [];
  const { input } = memoryFile(text("n\n7\n"), {
    columns: (format) => {
      asked.push(format);
      return set;
    },
  });
  const file = fileObject("both", exposed(input, lifetime.signal).descriptor, lifetime.signal);
  const [table, rows] = await Promise.all([file.parquet(), file.csv()]);
  assert.equal(table.numRows, 1);
  assert.deepEqual([...rows], [{ n: 7 }]);
  assert.deepEqual(await Promise.all([file.parquet(), file.csv()]), [table, rows]);
  assert.deepEqual(asked.sort(), ["csv", "parquet"]);
});

test("slice clamps as Blob.slice does and reads each range object once", async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const { input, served } = memoryFile(text("0123456789"));
  const { descriptor, sent } = exposed(input, lifetime.signal);
  const file = fileObject("digits", descriptor, lifetime.signal);
  const cases = [
    [[], "0123456789"],
    [[2, 5], "234"],
    [[-3], "789"],
    [[-3, -1], "78"],
    [[8, 99], "89"],
    [[-99, 2], "01"],
    [[1.9, 4.2], "123"],
  ];
  for (const [args, expected] of cases) {
    const range = file.slice(...args);
    assert.ok(Object.isFrozen(range));
    assert.deepEqual(Object.keys(range).sort(), ["arrayBuffer", "size", "text"]);
    assert.equal(range.size, expected.length, `${args} size`);
    assert.equal(await range.text(), expected, `${args}`);
  }
  // Start after end, or past the end: size 0 and no request.
  const before = sent.length;
  for (const range of [file.slice(6, 2), file.slice(20)]) {
    assert.equal(range.size, 0);
    assert.equal(await range.text(), "");
    assert.equal((await range.arrayBuffer()).byteLength, 0);
  }
  assert.equal(sent.length, before);
  // One request per range object, however often it is asked.
  const head = file.slice(0, 4);
  const asked = served.range;
  assert.equal(head.text(), head.text());
  await head.text();
  const a = await head.arrayBuffer();
  new Uint8Array(a).fill(0);
  assert.equal(new TextDecoder().decode(await head.arrayBuffer()), "0123");
  assert.equal(served.range, asked + 1);
});

const modulePayload = {
  kind: "module",
  assets: { entry: { bytes: text("export function render() {}"), mediaType: "text/javascript" } },
};

test("a data change aborts the old file object, sets a new one and fires change:<name>", async (t) => {
  const lifetime = new AbortController();
  const dom = new JSDOM("<main></main>");
  t.after(() => {
    lifetime.abort();
    dom.window.close();
  });
  const first = await parquetInput(5);
  const second = await parquetInput(9);
  // A first file whose whole-file read never finishes.
  first.input.bytes = () => new Promise(() => {});
  const frameData = createFrameData(
    { "data/activity": exposed(first.input, lifetime.signal).descriptor },
    lifetime.signal,
  );
  const old = frameData.initial["data/activity"];
  assert.equal(old.name, "activity");
  const range = old.slice(0, 4);
  const session = createWidgetSession(
    { ...preparePayload(modulePayload), state: { activity: old } },
    {
      document: dom.window.document,
      signal: lifetime.signal,
      loadModule: async () => ({
        async render({ model, el }) {
          const draw = async () =>
            (el.textContent = String((await model.get("activity").parquet()).numRows));
          model.on("change:activity", () => void draw());
          await draw();
        },
      }),
      diagnostic: () => {},
    },
  );
  await session.initialize();
  const el = dom.window.document.querySelector("main");
  await session.render(el);
  assert.equal(el.textContent, "5");
  const pending = old.text();
  pending.catch(() => {});
  const send = () => assert.fail("a listened change is never answered");
  assert.equal(
    receiveDataChange(
      { name: "data/activity", input: exposed(second.input, lifetime.signal).descriptor },
      { session, frameData, send },
    ),
    "apply",
  );
  await until(() => el.textContent === "9", "the listener redraws from the new file");
  await assert.rejects(pending, { name: "AbortError" });
  for (const call of [
    () => old.parquet(),
    () => old.csv(),
    () => old.text(),
    () => old.read(0, 4),
    () => range.text(),
  ])
    await assert.rejects(call(), { name: "AbortError" });
  assert.equal(second.served.columns, 1);
  // An invalid descriptor changes nothing.
  assert.throws(() =>
    receiveDataChange(
      { name: "data/activity", input: { mimeType: 7, size: 1, port: {} } },
      { session, frameData, send },
    ),
  );
  assert.equal(el.textContent, "9");
});

test("a malformed file descriptor is refused and its port closes", (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  for (const patch of [
    { mimeType: 1 },
    { mimeType: "x".repeat(256) },
    { size: -1 },
    { size: 1.5 },
  ]) {
    const { descriptor } = exposed(memoryFile(text("ab")).input, lifetime.signal);
    let closed = false;
    const close = descriptor.port.close.bind(descriptor.port);
    descriptor.port.close = () => {
      closed = true;
      close();
    };
    assert.throws(
      () => createFrameData({ "data/x": { ...descriptor, ...patch } }, lifetime.signal),
      /Invalid data input/,
    );
    assert.ok(closed);
  }
});

test("a whole read is served once at a time and delivered once per file; its share counts toward the limit", () => {
  const limit = 10;
  let state = NO_WHOLE_FILES;
  const step = (event) => {
    const result = wholeFileTransition(state, { limit, ...event });
    state = result.state;
    return result.refused;
  };
  const phase = (file, kind) => state[file]?.[kind]?.phase ?? "none";
  const reserve = (file, kind = "bytes", size = 4) => step({ type: "reserve", file, kind, size });
  // none → reading; a second request while reading is refused.
  assert.equal(reserve("a"), null);
  assert.equal(phase("a", "bytes"), "reading");
  assert.equal(reserve("a"), "This file is already being read.");
  // reading → none on a failure or a cancel, queued or in flight; a retry
  // may start.
  step({ type: "failed", file: "a", kind: "bytes" });
  assert.equal(phase("a", "bytes"), "none");
  assert.deepEqual(state, {}, "nothing held");
  assert.equal(reserve("a"), null, "a retry after a failure");
  // reading → delivered; a request after delivery is refused, and failed or
  // delivered again change nothing.
  step({ type: "delivered", file: "a", kind: "bytes" });
  assert.equal(phase("a", "bytes"), "delivered");
  assert.equal(reserve("a"), "This file was already read whole; its file object keeps it.");
  const delivered = state;
  step({ type: "failed", file: "a", kind: "bytes" });
  step({ type: "delivered", file: "a", kind: "bytes" });
  assert.equal(state, delivered);
  // Reading and delivered shares both count toward the limit.
  assert.equal(reserve("b", "bytes", 6), null);
  assert.equal(
    reserve("c", "bytes", 1),
    `This view's files exceed ${limit / (1024 * 1024)} MiB read whole.`,
  );
  // A table share carries no bytes and has the same phases.
  assert.equal(reserve("c", "parquet", 999), null);
  assert.equal(reserve("c", "parquet"), "This file's table is already being read.");
  step({ type: "delivered", file: "c", kind: "parquet" });
  assert.equal(
    reserve("c", "parquet"),
    "This file's table was already read; its file object keeps it.",
  );
  assert.equal(reserve("a", "parquet"), null, "each kind has its own share");
  // Each table format is a share of its own: CSV reads while Parquet has
  // been delivered, and is delivered once.
  assert.equal(reserve("c", "csv"), null);
  assert.equal(reserve("c", "csv"), "This file's table is already being read.");
  step({ type: "delivered", file: "c", kind: "csv" });
  assert.equal(
    reserve("c", "csv"),
    "This file's table was already read; its file object keeps it.",
  );
  assert.equal(phase("c", "parquet"), "delivered");
  // none: failed and delivered without a reservation change nothing.
  const before = state;
  step({ type: "failed", file: "d", kind: "bytes" });
  step({ type: "delivered", file: "d", kind: "parquet" });
  step({ type: "delivered", file: "d", kind: "csv" });
  step({ type: "delivered", file: "d", kind: "stream" });
  assert.equal(reserve("d", "stream"), null);
  assert.equal(reserve("d", "columns"), null, "the request kind is no share");
  assert.equal(state, before, "an unknown kind or an unheld share changes nothing");
  // Replaced while reading: both shares go, and a late answer for the
  // replaced id changes nothing.
  step({ type: "replaced", file: "b" });
  assert.equal(phase("b", "bytes"), "none");
  const afterReplace = state;
  step({ type: "delivered", file: "b", kind: "bytes" });
  step({ type: "failed", file: "b", kind: "bytes" });
  step({ type: "replaced", file: "b" });
  assert.equal(state, afterReplace, "a late answer for a replaced file");
  assert.equal(reserve("e", "bytes", 6), null, "its bytes no longer count");
  // Replaced after delivery frees the delivered bytes.
  step({ type: "replaced", file: "a" });
  assert.equal(phase("a", "bytes"), "none");
  assert.equal(phase("a", "parquet"), "none");
  step({ type: "replaced", file: "c" });
  assert.equal(phase("c", "csv"), "none", "a new file drops every share");
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.e) && Object.isFrozen(state.e.bytes));
});

test("a failed call is asked again; a pending or settled one is shared", async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const { input, served } = memoryFile(text('{"n":1}'));
  let failures = 1;
  const bytes = input.bytes;
  input.bytes = async (signal) => {
    if (failures-- > 0) throw Error("Too many file reads are waiting.");
    return bytes(signal);
  };
  const set = {
    numRows: 1,
    columns: [{ name: "n", type: "number", values: new Float64Array([1]) }],
  };
  let tableFailures = 1;
  input.columns = async () => {
    served.columns++;
    if (tableFailures-- > 0) throw Error("busy");
    return set;
  };
  const file = fileObject("n", exposed(input, lifetime.signal).descriptor, lifetime.signal);
  const first = file.text();
  assert.equal(file.text(), first, "the same promise while pending");
  const viaJson = file.json();
  await assert.rejects(first, /Too many file reads/);
  await assert.rejects(viaJson, /Too many file reads/, "json() shared the pending read");
  const second = file.text();
  assert.notEqual(second, first, "a new request after a rejection");
  assert.equal(await second, '{"n":1}');
  assert.equal(file.text(), second, "the same promise after it resolves");
  assert.deepEqual(await file.json(), { n: 1 });
  await assert.rejects(file.parquet(), /busy/);
  const table = file.parquet();
  assert.equal((await table).numRows, 1);
  assert.equal(file.parquet(), table);
  assert.equal(served.columns, 2);
});

function mountWithFakeFrame(t, files) {
  const dom = new JSDOM("<main></main>", { url: "https://host.example/" });
  const output = mountModuleOutput(dom.window.document.querySelector("main"), modulePayload, {
    frameUrl: "https://outputs.example/frame/v2/",
    runtime: "runtime text",
    hostContext: { theme: "light" },
    files,
  });
  const frame = { port: null, messages: [], lifetime: new AbortController() };
  t.after(() => {
    output.destroy();
    frame.lifetime.abort();
    frame.port?.close();
    dom.window.close();
  });
  Object.defineProperty(output.frame, "contentWindow", {
    value: {
      postMessage(message, _origin, [port]) {
        frame.connect = message;
        frame.port = port;
        port.onmessage = ({ data }) => frame.messages.push(data);
        port.postMessage({ type: "connected" });
      },
    },
  });
  output.frame.dispatchEvent(new dom.window.Event("load"));
  return { output, frame };
}

test("the host sends {mimeType, size, port} per file and refuses whole reads past 32 MiB", async (t) => {
  const MiB = 1024 * 1024;
  const inputs = Object.fromEntries(
    Array.from({ length: 7 }, (_, i) => [`data/f${i}`, memoryFile(new Uint8Array(5 * MiB)).input]),
  );
  const { output, frame } = mountWithFakeFrame(t, inputs);
  await until(() => frame.messages.some((m) => m.type === "mount"), "no mount");
  assert.equal(frame.connect.type, "nteract-output-boot");
  assert.equal(frame.connect.connect, "nteract-output-connect-v3");
  const mount = frame.messages.find((m) => m.type === "mount");
  for (const descriptor of Object.values(mount.files))
    assert.deepEqual(Object.keys(descriptor).sort(), ["mimeType", "port", "size"]);
  const files = Object.fromEntries(
    Object.entries(mount.files).map(([name, descriptor]) => [
      name,
      receiveFile(descriptor, frame.lifetime.signal),
    ]),
  );
  assert.deepEqual(Object.keys(files), Object.keys(inputs));
  for (let i = 0; i < 6; i++) await files[`data/f${i}`].request({ kind: "bytes" });
  await assert.rejects(files["data/f6"].request({ kind: "bytes" }), /exceed 32 MiB read whole/);
  // A file is delivered whole once, so a second whole read is refused and
  // counts nothing.
  await assert.rejects(files["data/f0"].request({ kind: "bytes" }), /already read whole/);
  // A new file under a name gives its share back.
  for (const event of ["loaded", "initialized", "rendered"])
    frame.port.postMessage({ type: "phase", event });
  await until(() => output.state === "ready", "never ready");
  output.setData("data/f0", memoryFile(text("small")).input);
  await until(() => frame.messages.some((m) => m.type === "data"), "the change was not sent");
  assert.equal((await files["data/f6"].request({ kind: "bytes" })).byteLength, 5 * MiB);
  // Host inputs of the wrong shape are refused.
  for (const bad of [text("x"), { byteLength: 1, read() {} }, { ...inputs["data/f1"], columns: 1 }])
    assert.throws(() => output.setData("data/f1", bad), /A data input is \{mimeType/);
});
