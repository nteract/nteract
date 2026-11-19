// Data changes reach a mounted output without a remount: the host's queue,
// the frame's inputs and the model each view sees.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { mountModuleOutput } from "@nteract/output-frame";
import { OUTPUT_STATES, dataTransition } from "@nteract/output-frame/lifecycle";
import { receiveByteSource } from "@nteract/output-frame/byte-source";
import { READ_CONCURRENCY } from "@nteract/output-frame/read-budget";
import { createFrameData, dataDecision, receiveDataChange } from "@nteract/output-frame/data";
import { preparePayload } from "../../../packages/output-frame/src/payload.mjs";
// The installed package's session, as test/anywidget.test.mjs loads it.
const { createWidgetSession } = await import(
  new URL("./anywidget.mjs", import.meta.resolve("@nteract/output-frame/runtime"))
);

const text = (value) => new TextEncoder().encode(value);
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
async function until(predicate, message) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(message);
}

test("data waits for ready, flushes latest per name, and drops after failure or disposal", () => {
  const a1 = ["a", 1];
  const a2 = ["a", 2];
  const b1 = ["b", 1];
  for (const state of OUTPUT_STATES) {
    for (const pending of [[], [b1, a1]]) {
      for (const change of [undefined, a2]) {
        const result = dataTransition(state, Object.freeze(pending), change);
        assert.ok(Object.isFrozen(result.pending), state);
        assert.ok(Object.isFrozen(result.send), state);
        const merged = change ? [...pending.filter(([name]) => name !== "a"), change] : pending;
        if (state === "failed" || state === "disposed") {
          assert.deepEqual(result, { pending: [], send: [] }, state);
        } else if (state === "ready") {
          assert.deepEqual(result.pending, [], state);
          assert.deepEqual(result.send, merged, state);
        } else {
          assert.deepEqual(result.pending, merged, state);
          assert.deepEqual(result.send, [], state);
        }
      }
    }
  }
  // The latest value per name wins, in the order of its latest arrival.
  let pending = [];
  for (const change of [a1, b1, a2]) pending = dataTransition("rendering", pending, change).pending;
  assert.deepEqual(pending, [b1, a2]);
  assert.deepEqual(dataTransition("ready", pending).send, [b1, a2]);
});

// A parent page with a fake frame: the port the host hands to the iframe is
// answered here, phase by phase, as the runtime would.
function mountWithFakeFrame(t, payload, options = {}) {
  const dom = new JSDOM("<main></main>", { url: "https://host.example/" });
  const states = [];
  const output = mountModuleOutput(dom.window.document.querySelector("main"), payload, {
    frameUrl: "https://outputs.example/frame/v2/",
    hostContext: { theme: "light" },
    onState: (state) => states.push(state),
    ...options,
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
        frame.port = port;
        port.onmessage = ({ data }) => frame.messages.push(data);
        port.postMessage({ type: "connected" });
      },
    },
  });
  output.frame.dispatchEvent(new dom.window.Event("load"));
  frame.phase = (event) => frame.port.postMessage({ type: "phase", event });
  frame.render = async () => {
    await until(() => frame.messages.some((m) => m.type === "mount"), "no mount message");
    for (const event of ["loaded", "initialized", "rendered"]) frame.phase(event);
    await until(() => output.state === "ready", "the output never became ready");
  };
  frame.data = () => frame.messages.filter((m) => m.type === "data");
  return { output, frame, states };
}

const modulePayload = {
  kind: "module",
  assets: { entry: { bytes: text("export function render() {}"), mediaType: "text/javascript" } },
};

test("a data change is sent only after the frame has rendered, latest per name", async (t) => {
  const { output, frame } = mountWithFakeFrame(t, modulePayload, {
    byteSources: { "data/label": text("one"), "data/other": text("x") },
  });
  output.setData("data/label", text("two"));
  output.setData("data/other", text("y"));
  output.setData("data/label", text("three"));
  await until(() => frame.messages.some((m) => m.type === "mount"), "no mount");
  const mount = frame.messages.find((m) => m.type === "mount");
  assert.deepEqual(Object.keys(mount.files), ["data/label", "data/other"]);
  assert.equal(new TextDecoder().decode(mount.files["data/label"].bytes), "one");
  frame.phase("loaded");
  frame.phase("initialized");
  await tick();
  assert.deepEqual(frame.data(), [], "nothing before rendered");
  frame.phase("rendered");
  await until(() => frame.data().length === 2, "held data was not flushed");
  assert.deepEqual(
    frame.data().map(({ name, input }) => [name, new TextDecoder().decode(input.bytes)]),
    [
      ["data/other", "y"],
      ["data/label", "three"],
    ],
  );
  output.setData("data/label", text("four"));
  await until(() => frame.data().length === 3, "a change after ready was not sent");
  assert.equal(new TextDecoder().decode(frame.data()[2].input.bytes), "four");
});

test("unknown names and invalid values are refused; changes after disposal are dropped", async (t) => {
  const { output, frame } = mountWithFakeFrame(t, modulePayload, {
    byteSources: { "data/label": text("one") },
  });
  await frame.render();
  for (const name of ["data/missing", "label", "entry", "__proto__", 7])
    assert.throws(() => output.setData(name, text("x")), /Unknown data name/);
  assert.throws(() => output.setData("data/label", { byteLength: 1 }), /Uint8Array/);
  assert.throws(() => output.setData("data/label", new Uint8Array(5 * 1024 * 1024 + 1)), /5 MiB/);
  output.destroy();
  output.setData("data/label", text("late"));
  await tick();
  assert.deepEqual(frame.data(), []);
});

test("an anywidget view accepts bytes for its buffer names only", async (t) => {
  const payload = {
    spec: { _esm: "code", state: {}, buffers: ["clip"], buffer_paths: [["clip"]] },
    assets: {
      code: { bytes: text("export default {render(){}}"), mediaType: "text/javascript" },
      clip: { bytes: text("old"), mediaType: "application/octet-stream" },
    },
  };
  const { output, frame } = mountWithFakeFrame(t, payload);
  await frame.render();
  assert.throws(() => output.setData("code", text("x")), /Unknown data name/);
  assert.throws(() => output.setData("clip", { byteLength: 1, read() {} }), /Uint8Array/);
  output.setData("clip", text("new"));
  await until(() => frame.data().length === 1, "buffer change not sent");
  assert.equal(frame.data()[0].name, "clip");
  assert.equal(new TextDecoder().decode(frame.data()[0].input.bytes), "new");
});

// A ranged file whose reads wait until the test releases them.
function heldFile(byteLength) {
  const reads = [];
  return {
    reads,
    source: {
      byteLength,
      read(offset, length, signal) {
        return new Promise((resolve, reject) => {
          const read = { offset, length, signal, release: () => resolve(new Uint8Array(length)) };
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          reads.push(read);
        });
      },
    },
  };
}

test("a swapped ranged file closes its old port and shares the view's read budget", async (t) => {
  const steady = heldFile(100);
  const before = heldFile(100);
  const after = heldFile(100);
  const { output, frame } = mountWithFakeFrame(t, modulePayload, {
    byteSources: { "data/steady": steady.source, "data/table": before.source },
  });
  await frame.render();
  const mount = frame.messages.find((m) => m.type === "mount");
  const lifetime = frame.lifetime.signal;
  const steadyFile = receiveByteSource(mount.files["data/steady"], lifetime);
  const oldFile = receiveByteSource(mount.files["data/table"], lifetime);
  // Fill every slot but one on the steady file, and the last on the old table.
  for (let i = 0; i < READ_CONCURRENCY - 1; i++) void steadyFile.read(i, 1).catch(() => {});
  void oldFile.read(0, 4).catch(() => {});
  await until(
    () => steady.reads.length === READ_CONCURRENCY - 1 && before.reads.length === 1,
    "reads did not start",
  );
  output.setData("data/table", after.source);
  await until(() => frame.data().length === 1, "swap not sent");
  const { input } = frame.data()[0];
  assert.equal(input.byteLength, 100);
  await until(
    () => before.reads[0].signal.aborted,
    "the old file's in-flight read was not aborted",
  );
  // The old port no longer serves reads.
  void oldFile.read(1, 1).catch(() => {});
  await tick();
  await tick();
  assert.equal(before.reads.length, 1);
  // The aborted read gives its slot back; a new read takes it, so the next
  // one waits on the shared budget until a steady read finishes.
  const newFile = receiveByteSource(input, lifetime);
  void newFile.read(0, 2).catch(() => {});
  await until(() => after.reads.length === 1, "the new file's first read did not start");
  void newFile.read(2, 2).catch(() => {});
  await tick();
  await tick();
  assert.equal(after.reads.length, 1, "the view's budget is shared across the swap");
  steady.reads[0].release();
  await until(() => after.reads.length === 2, "the waiting read never started");
});

test("frame data: bytes become a DataView, ranged files a handle; replacing aborts the old one", async () => {
  const mountLifetime = new AbortController();
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = ({ data, ports: [reply] }) => {
    reply.postMessage({ bytes: new Uint8Array(data.length).fill(7) });
    reply.close();
  };
  try {
    const frameData = createFrameData(
      { "data/label": { bytes: text("hello") }, "data/table": { byteLength: 64, port: port2 } },
      mountLifetime.signal,
    );
    const label = frameData.initial["data/label"];
    assert.ok(label.value instanceof DataView);
    assert.equal(new TextDecoder().decode(label.value), "hello");
    assert.equal(new TextDecoder().decode(await label.handle.read(1, 3)), "ell");
    await assert.rejects(label.handle.read(4, 2), /Invalid file read/);
    const table = frameData.initial["data/table"];
    assert.equal(table.value, table.handle, "the model and the import share one Parquet handle");
    assert.equal(table.value.byteLength, 64);
    assert.deepEqual([...(await table.value.read(0, 2))], [7, 7]);
    assert.equal(frameData.replace("data/missing", { bytes: text("x") }), undefined);
    assert.throws(() => frameData.replace("data/label", { url: "https://elsewhere.example" }));
    const next = frameData.replace("data/label", { bytes: text("bye") });
    assert.equal(new TextDecoder().decode(next.value), "bye");
    await assert.rejects(label.handle.read(0, 1), { name: "AbortError" });
    const pending = table.handle.read(0, 1);
    frameData.replace("data/table", { bytes: text("now whole") });
    await pending.then(
      () => {},
      (error) => assert.equal(error.name, "AbortError"),
    );
    await assert.rejects(table.handle.read(0, 1), { name: "AbortError" });
    assert.throws(() => createFrameData({ "../x": { bytes: text("x") } }, mountLifetime.signal));
  } finally {
    mountLifetime.abort();
    port1.close();
  }
});

function sessionFixture(t, payload, loadModule) {
  const dom = new JSDOM("<main></main>");
  const lifetime = new AbortController();
  t.after(() => {
    lifetime.abort();
    dom.window.close();
  });
  const session = createWidgetSession(payload, {
    document: dom.window.document,
    signal: lifetime.signal,
    loadModule,
    diagnostic: () => {},
  });
  return { session, el: dom.window.document.querySelector("main") };
}

const moduleView = (state) => ({ ...preparePayload(modulePayload), state });

test("a module view's named render gets a model whose data changes fire change events", async (t) => {
  const handle = { byteLength: 3, read: async () => new Uint8Array(3) };
  const label = new DataView(text("first").buffer);
  const seen = [];
  const { session, el } = sessionFixture(t, moduleView({ label, table: handle }), async () => ({
    render({ model, el, signal }) {
      assert.ok(signal instanceof AbortSignal);
      seen.push(["render", model.get("label"), model.get("table")]);
      model.on("change:label", () => {
        el.textContent = new TextDecoder().decode(model.get("label"));
        seen.push(["change:label", model.get("label")]);
      });
    },
  }));
  await session.initialize();
  await session.render(el);
  assert.deepEqual(seen, [["render", label, handle]]);
  const next = new DataView(text("second").buffer);
  assert.equal(session.setValue("label", next), true);
  assert.deepEqual(seen.at(-1), ["change:label", next]);
  assert.equal(el.textContent, "second");
  assert.equal(session.setValue("unknown", next), false);
  assert.equal(session.setBuffer("label", text("x")), false);
});

test("a module view whose default export is an AFM object or factory mounts with a model", async (t) => {
  for (const exported of [
    (calls) => ({
      default: {
        initialize: ({ model }) => calls.push(["initialize", model.get("label")]),
        render: ({ model }) => calls.push(["render", model.get("label")]),
      },
    }),
    (calls) => ({
      default: async () => ({ render: ({ model }) => calls.push(["render", model.get("label")]) }),
    }),
  ]) {
    const calls = [];
    const { session, el } = sessionFixture(t, moduleView({ label: "v" }), async () =>
      exported(calls),
    );
    await session.initialize();
    await session.render(el);
    assert.deepEqual(calls.at(-1), ["render", "v"]);
  }
  const { session } = sessionFixture(t, moduleView({}), async () => ({ helper() {} }));
  await assert.rejects(session.initialize(), /Export render\(\{model, el, signal\}\)/);
});

test("an anywidget buffer change replaces each bound path and fires change once per key", async (t) => {
  const payload = preparePayload({
    spec: {
      _esm: "code",
      state: { audio: { name: "clip", bytes: null }, pair: [null, null] },
      buffers: ["clip", "clip", "clip"],
      buffer_paths: [
        ["audio", "bytes"],
        ["pair", 0],
        ["pair", 1],
      ],
    },
    assets: {
      code: { bytes: text("code"), mediaType: "text/javascript" },
      clip: { bytes: text("old"), mediaType: "application/octet-stream" },
    },
  });
  const changes = [];
  let model;
  const { session, el } = sessionFixture(t, payload, async () => ({
    default: {
      render(props) {
        model = props.model;
        for (const key of ["audio", "pair"]) model.on(`change:${key}`, () => changes.push(key));
      },
    },
  }));
  await session.initialize();
  await session.render(el);
  model.set("audio", { ...model.get("audio"), name: "kept locally" });
  changes.length = 0;
  assert.equal(session.setBuffer("clip", text("new")), true);
  assert.deepEqual(changes, ["audio", "pair"]);
  assert.equal(model.get("audio").name, "kept locally");
  assert.equal(new TextDecoder().decode(model.get("audio").bytes), "new");
  assert.deepEqual(
    model.get("pair").map((view) => new TextDecoder().decode(view)),
    ["new", "new"],
  );
  assert.equal(session.setBuffer("code", text("x")), false, "code is never data");
});

test("the data decision applies when any affected key listens and is unhandled when none does", () => {
  assert.equal(dataDecision([]), "unknown");
  assert.equal(dataDecision([false]), "unhandled");
  assert.equal(dataDecision([false, false]), "unhandled");
  assert.equal(dataDecision([true]), "apply");
  assert.equal(dataDecision([false, true]), "apply");
});

test("a module view applies a data change only for a key with a change listener", async (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const frameData = createFrameData(
    { "data/label": { bytes: text("first") }, "data/once": { bytes: text("read once") } },
    lifetime.signal,
  );
  const state = Object.fromEntries(
    Object.entries(frameData.initial).map(([name, input]) => [name.slice(5), input.value]),
  );
  let model;
  const fired = [];
  const { session, el } = sessionFixture(t, moduleView(state), async () => ({
    render(props) {
      model = props.model;
      model.on("change:label", () => fired.push(new TextDecoder().decode(model.get("label"))));
    },
  }));
  await session.initialize();
  await session.render(el);
  const sent = [];
  const send = (message) => sent.push(message);
  const receive = (name, value) =>
    receiveDataChange({ name, input: { bytes: text(value) } }, { session, frameData, send });

  assert.equal(receive("data/label", "second"), "apply");
  assert.deepEqual(fired, ["second"]);
  assert.deepEqual(sent, []);

  const before = model.get("once");
  const oldHandle = frameData.initial["data/once"].handle;
  assert.equal(receive("data/once", "changed"), "unhandled");
  assert.deepEqual(sent, [{ type: "unhandled-data", name: "data/once" }]);
  assert.equal(model.get("once"), before, "nothing is applied");
  assert.equal(
    new TextDecoder().decode(await oldHandle.read(0, 4)),
    "read",
    "the import still reads",
  );

  assert.equal(receive("data/missing", "x"), "unknown");
  assert.equal(receive("label", "x"), "unknown");
  assert.equal(sent.length, 1);
});

test("an anywidget buffer change applies to every bound key when one of them listens", async (t) => {
  const payload = preparePayload({
    spec: {
      _esm: "code",
      state: { heard: null, silent: null, alone: null },
      buffers: ["clip", "clip", "solo"],
      buffer_paths: [["heard"], ["silent"], ["alone"]],
    },
    assets: {
      code: { bytes: text("code"), mediaType: "text/javascript" },
      clip: { bytes: text("old"), mediaType: "application/octet-stream" },
      solo: { bytes: text("solo"), mediaType: "application/octet-stream" },
    },
  });
  let model;
  const fired = [];
  const { session, el } = sessionFixture(t, payload, async () => ({
    default: {
      render(props) {
        model = props.model;
        model.on("change:heard", () => fired.push("heard"));
      },
    },
  }));
  await session.initialize();
  await session.render(el);
  const sent = [];
  const receive = (name, value) =>
    receiveDataChange(
      { name, input: { bytes: text(value) } },
      { session, send: (message) => sent.push(message) },
    );
  assert.equal(receive("clip", "new"), "apply");
  assert.deepEqual(fired, ["heard"]);
  for (const key of ["heard", "silent"])
    assert.equal(new TextDecoder().decode(model.get(key)), "new", key);
  assert.deepEqual(sent, []);
  const alone = model.get("alone");
  assert.equal(receive("solo", "changed"), "unhandled");
  assert.equal(model.get("alone"), alone);
  assert.deepEqual(sent, [{ type: "unhandled-data", name: "solo" }]);
  assert.equal(receive("code", "x"), "unknown");
});

test("the host reports unhandled data only once ready and only for declared names", async (t) => {
  const unhandled = [];
  const { output, frame } = mountWithFakeFrame(t, modulePayload, {
    byteSources: { "data/label": text("one") },
    onUnhandledData: (name) => unhandled.push(name),
  });
  await until(() => frame.messages.some((m) => m.type === "mount"), "no mount");
  frame.port.postMessage({ type: "unhandled-data", name: "data/label" });
  await tick();
  assert.deepEqual(unhandled, [], "not before ready");
  await frame.render();
  for (const name of ["data/missing", "label", 7, "__proto__"])
    frame.port.postMessage({ type: "unhandled-data", name });
  frame.port.postMessage({ type: "unhandled-data", name: "data/label" });
  await until(() => unhandled.length > 0, "a declared name was not reported");
  await tick();
  assert.deepEqual(unhandled, ["data/label"]);
  output.destroy();
  assert.deepEqual(unhandled, ["data/label"]);
});
