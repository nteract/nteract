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
        async columns() {
          served.columns++;
          return columns();
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

test("the whole-file total keeps delivered shares, frees failed and replaced ones", () => {
  const limit = 10;
  let state = NO_WHOLE_FILES;
  const step = (event) => {
    const result = wholeFileTransition(state, { limit, ...event });
    state = result.state;
    return result.refused;
  };
  assert.equal(step({ type: "reserve", file: "a", size: 6 }), null);
  assert.equal(step({ type: "reserve", file: "a", size: 6 }), null, "a held share is kept");
  assert.match(step({ type: "reserve", file: "b", size: 5 }), /exceed 0?\.?0*\d* ?MiB|exceed/);
  assert.equal(step({ type: "failed", file: "a" }), null);
  assert.deepEqual(state, {});
  step({ type: "reserve", file: "a", size: 6 });
  step({ type: "delivered", file: "a" });
  step({ type: "failed", file: "a" });
  assert.deepEqual(state, { a: { size: 6, delivered: true } }, "a delivered share stays");
  assert.ok(step({ type: "reserve", file: "b", size: 5 }));
  step({ type: "replaced", file: "a" });
  assert.equal(step({ type: "reserve", file: "b", size: 5 }), null);
  const unchanged = state;
  step({ type: "replaced", file: "zzz" });
  step({ type: "delivered", file: "zzz" });
  assert.equal(state, unchanged, "unknown files change nothing");
  assert.ok(Object.isFrozen(state) && Object.isFrozen(state.b));
});

function mountWithFakeFrame(t, files) {
  const dom = new JSDOM("<main></main>", { url: "https://host.example/" });
  const output = mountModuleOutput(dom.window.document.querySelector("main"), modulePayload, {
    frameUrl: "https://outputs.example/frame/v2/",
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
  assert.equal(frame.connect.type, "nteract-output-connect-v3");
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
  // A file already held reads again without counting twice.
  await files["data/f0"].request({ kind: "bytes" });
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
