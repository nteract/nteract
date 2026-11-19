// The output frame's bootstrap document (@nteract/output-frame/bootstrap) and
// the host's boot step. The bootstrap runs in a jsdom window that executes its
// script as a browser would; scripts/output-smoke.mjs runs it in Chromium,
// Firefox and WebKit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { VirtualTimeScheduler } from "rxjs";
import {
  BOOTSTRAP_HTML,
  BOOTSTRAP_SCRIPT,
  BOOT_FAILED_MESSAGE,
  BOOT_MESSAGE,
  RUNTIME_ENTRY,
} from "@nteract/output-frame/bootstrap";
import {
  BOOT_FAILURE,
  OUTPUT_STATES,
  START_TIMEOUT_FAILURE,
  connectMessageType,
  outputTransition,
  startupFailure,
} from "@nteract/output-frame/lifecycle";
import { mountModuleOutput } from "@nteract/output-frame";
import { frameRuntimeText } from "../scripts/build-output.mjs";

const NONCE = "mount-nonce";
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check, message) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  assert.fail(message);
}

// A frame document holding the bootstrap, as the output Worker serves it.
// `failures` counts the bootstrap's failure messages to its parent, which in
// a top-level window is the window itself.
function bootstrapFrame(t) {
  const virtualConsole = new VirtualConsole();
  const scriptErrors = [];
  virtualConsole.on("jsdomError", (error) => scriptErrors.push(error));
  const dom = new JSDOM(BOOTSTRAP_HTML, {
    runScripts: "dangerously",
    url: `https://outputs.example/frame/v3/#${NONCE}`,
    virtualConsole,
  });
  const window = dom.window;
  const frame = { window, scriptErrors, failures: [] };
  window.addEventListener("message", ({ data }) => {
    if (data?.type === BOOT_FAILED_MESSAGE) frame.failures.push(data);
  });
  frame.boot = (data, { source = window, ports = [] } = {}) => {
    const event = new window.MessageEvent("message", { data, source, ports });
    window.dispatchEvent(event);
    return event;
  };
  t.after(() => window.close());
  return frame;
}

// Runtime text that counts its runs and keeps the event its entry receives.
const countingRuntime = `window.runs = (window.runs ?? 0) + 1;
window.${RUNTIME_ENTRY} = (event) => { (window.entered ??= []).push(event); };`;
const boot = (runtime, extra = {}) => ({ type: BOOT_MESSAGE, runtime, ...extra });

test("the bootstrap is one small classic script after <main>", () => {
  const scripts = [...BOOTSTRAP_HTML.matchAll(/<script([^>]*)>/g)];
  assert.deepEqual(
    scripts.map((match) => match[1]),
    [""],
  );
  assert.match(BOOTSTRAP_HTML, /<\/head><body><main><\/main><script>"use strict";/);
  assert.ok(BOOTSTRAP_HTML.includes(`<script>${BOOTSTRAP_SCRIPT}</script>`));
  assert.ok(Buffer.byteLength(BOOTSTRAP_HTML) < 1536, `${Buffer.byteLength(BOOTSTRAP_HTML)} bytes`);
  // It names no protocol version, port meaning, view, data or catalog.
  assert.doesNotMatch(BOOTSTRAP_SCRIPT, /connect-v|PROTOCOL|catalog|importmap|ports|nonce/i);
});

test("a boot message from anything but the parent is ignored", async (t) => {
  const frame = bootstrapFrame(t);
  const other = new JSDOM("", { url: "https://elsewhere.example/" });
  t.after(() => other.window.close());
  frame.boot(boot(countingRuntime), { source: other.window });
  frame.boot(boot(countingRuntime), { source: null });
  assert.equal(frame.window.runs, undefined);
  // The parent's boot still works afterwards.
  frame.boot(boot(countingRuntime));
  assert.equal(frame.window.runs, 1);
});

test("other messages are ignored and the bootstrap keeps waiting", (t) => {
  const frame = bootstrapFrame(t);
  for (const data of [
    null,
    "text",
    { type: "nteract-output-connect-v3", runtime: countingRuntime },
    { type: BOOT_MESSAGE },
    { type: BOOT_MESSAGE, runtime: 42 },
  ])
    frame.boot(data);
  assert.equal(frame.window.runs, undefined);
  frame.boot(boot(countingRuntime));
  assert.equal(frame.window.runs, 1);
});

test("the runtime runs exactly once and a second boot is ignored", async (t) => {
  const frame = bootstrapFrame(t);
  const first = frame.boot(boot(countingRuntime));
  frame.boot(boot(countingRuntime));
  frame.boot(boot("window.other = true"));
  assert.equal(frame.window.runs, 1);
  assert.equal(frame.window.other, undefined);
  assert.equal(frame.window.entered.length, 1);
  assert.equal(frame.window.entered[0], first);
  // The bootstrap removes the entry point once it has called it.
  assert.equal(frame.window[RUNTIME_ENTRY], undefined);
  await tick();
  assert.deepEqual(frame.failures, []);
});

test("a second boot is ignored even after a first one failed", async (t) => {
  const frame = bootstrapFrame(t);
  frame.boot(boot("throw Error('first')"));
  frame.boot(boot(countingRuntime));
  assert.equal(frame.window.runs, undefined);
  await until(() => frame.failures.length === 1, "no failure message");
  await tick();
  assert.equal(frame.failures.length, 1);
});

test("a runtime that does not start produces the one failure message", async (t) => {
  for (const runtime of [
    "throw Error('the runtime throws')",
    "this is not JavaScript (",
    "window.started = true", // defines no entry point
    `window.${RUNTIME_ENTRY} = () => { throw Error('the entry throws') }`,
  ]) {
    const frame = bootstrapFrame(t);
    frame.boot(boot(runtime));
    await until(() => frame.failures.length === 1, runtime);
    assert.deepEqual(
      frame.failures.map((data) => ({ ...data })),
      [{ type: BOOT_FAILED_MESSAGE }],
      runtime,
    );
  }
});

test("ports and every other field reach the runtime untouched", (t) => {
  const frame = bootstrapFrame(t);
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  const data = boot(countingRuntime, {
    connect: "nteract-output-connect-v3",
    nonce: NONCE,
    anything: { nested: [1, 2] },
  });
  const event = frame.boot(data, { ports: [port2] });
  const [entered] = frame.window.entered;
  assert.equal(entered, event);
  assert.equal(entered.data, data);
  assert.deepEqual(entered.data.anything, { nested: [1, 2] });
  assert.equal(entered.ports.length, 1);
  assert.equal(entered.ports[0], port2);
});

test("the same bootstrap boots a runtime of any port protocol version", async (t) => {
  // A stand-in for a future runtime: its own connect version, its own port
  // messages. The bootstrap passes it everything and interprets nothing.
  const frame = bootstrapFrame(t);
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  const reply = new Promise((resolve) => (port1.onmessage = ({ data }) => resolve(data)));
  frame.boot(
    boot(
      `window.${RUNTIME_ENTRY} = (event) => event.ports[0].postMessage({ type: "hello-v99", connect: event.data.connect });`,
      { connect: "nteract-output-connect-v99", nonce: NONCE },
    ),
    { ports: [port2] },
  );
  assert.deepEqual(await reply, { type: "hello-v99", connect: "nteract-output-connect-v99" });
  await tick();
  assert.deepEqual(frame.failures, []);
});

test("this build's runtime connects through the bootstrap and checks its version", async (t) => {
  const runtime = await frameRuntimeText();
  const answer = async (connect, nonce = NONCE) => {
    const frame = bootstrapFrame(t);
    const { port1, port2 } = new MessageChannel();
    t.after(() => {
      port1.close();
      port2.close();
    });
    const reply = new Promise((resolve) => (port1.onmessage = ({ data }) => resolve(data)));
    frame.boot(boot(runtime, { connect, nonce }), { ports: [port2] });
    await tick();
    assert.deepEqual(frame.failures, []);
    assert.deepEqual(frame.scriptErrors, []);
    // The runtime's stylesheet comes first in <head>.
    assert.match(frame.window.document.head.firstElementChild.textContent, /--background/);
    return Promise.race([reply, until(() => false, "no reply").catch(() => "no reply")]);
  };
  assert.deepEqual(await answer(connectMessageType()), { type: "connected" });
  const older = await answer(connectMessageType(2));
  assert.equal(older.type, "error");
  assert.match(older.message, /protocol v3 and the page sent v2/);
  assert.equal(await answer(connectMessageType(), "another-nonce"), "no reply");
});

test("the boot state: every state and event, and the startup failure texts", () => {
  const events = [
    "boot",
    "connected",
    "mount",
    "loaded",
    "initialized",
    "rendered",
    "fail",
    "dispose",
    "unknown",
  ];
  const expected = {
    connecting: { boot: "booting" },
    booting: { connected: "loading" },
    loading: { mount: "importing" },
    importing: { loaded: "initializing" },
    initializing: { initialized: "rendering" },
    rendering: { rendered: "ready" },
  };
  for (const state of OUTPUT_STATES)
    for (const event of events) {
      const want =
        state === "disposed"
          ? "disposed"
          : event === "dispose"
            ? "disposed"
            : event === "fail"
              ? "failed"
              : (expected[state]?.[event] ?? state);
      assert.equal(outputTransition(state, event), want, `${state} + ${event}`);
    }
  for (const state of OUTPUT_STATES)
    assert.equal(
      startupFailure(state),
      state === "booting" ? BOOT_FAILURE : START_TIMEOUT_FAILURE,
      state,
    );
  assert.notEqual(BOOT_FAILURE, START_TIMEOUT_FAILURE);
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

// A host page whose frame is another jsdom window. `frame.answer` decides
// what the frame does with the boot message: nothing, by default.
function mountWithFrame(t, options = {}) {
  const dom = new JSDOM("<main></main>", { url: "https://host.example/" });
  const child = new JSDOM("", { url: "https://outputs.example/frame/v3/" });
  const clock = new VirtualTimeScheduler();
  const states = [];
  const frame = { boots: [], answer: () => {} };
  const output = mountModuleOutput(dom.window.document.querySelector("main"), modulePayload, {
    frameUrl: "https://outputs.example/frame/v3/",
    runtime: "the runtime text",
    hostContext: { theme: "light" },
    scheduler: clock,
    onState: (state, error) => states.push(error ? [state, error] : state),
    ...options,
  });
  Object.defineProperty(output.frame, "contentWindow", { value: child.window });
  Object.defineProperty(child.window, "postMessage", {
    value(message, _origin, transfer) {
      frame.boots.push(message);
      frame.answer(message, transfer);
    },
  });
  t.after(() => {
    output.destroy();
    child.window.close();
    dom.window.close();
  });
  frame.load = () => output.frame.dispatchEvent(new dom.window.Event("load"));
  // The bootstrap's failure message, from the frame's window.
  frame.reportFailure = () =>
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: { type: BOOT_FAILED_MESSAGE },
        source: child.window,
      }),
    );
  return { output, frame, clock, states, dom, child };
}

test("the host boots after load with one message carrying the runtime and the port", async (t) => {
  const { output, frame } = mountWithFrame(t);
  assert.equal(output.state, "connecting");
  frame.load();
  assert.equal(output.state, "booting");
  await until(() => frame.boots.length === 1, "no boot message");
  const [message] = frame.boots;
  assert.deepEqual(Object.keys(message).sort(), ["connect", "nonce", "runtime", "type"]);
  assert.equal(message.type, BOOT_MESSAGE);
  assert.equal(message.runtime, "the runtime text");
  assert.equal(message.connect, connectMessageType());
  assert.equal(message.nonce, new URL(output.frame.src).hash.slice(1));
});

test("no answer within the boot bound fails with the boot text", async (t) => {
  const { output, frame, clock, states } = mountWithFrame(t, {
    bootTimeoutMs: 100,
    timeoutMs: 1000,
  });
  frame.load();
  await until(() => frame.boots.length === 1, "no boot message");
  clock.flush();
  assert.equal(output.state, "failed");
  assert.equal(clock.now(), 100, "the boot bound, not the startup limit");
  assert.deepEqual(states, ["connecting", "booting", ["failed", BOOT_FAILURE]]);
});

test("the startup limit ending while booting also reads as a boot failure", async (t) => {
  const { output, frame, clock, states } = mountWithFrame(t, {
    bootTimeoutMs: 5000,
    timeoutMs: 100,
  });
  frame.load();
  await until(() => frame.boots.length === 1, "no boot message");
  clock.flush();
  assert.equal(output.state, "failed");
  assert.deepEqual(states.at(-1), ["failed", BOOT_FAILURE]);
});

test("a frame document that never loads fails with the startup text", (t) => {
  const { output, clock, states } = mountWithFrame(t, { bootTimeoutMs: 50, timeoutMs: 100 });
  clock.flush();
  assert.equal(output.state, "failed");
  assert.deepEqual(states, ["connecting", ["failed", START_TIMEOUT_FAILURE]]);
});

test("the bootstrap's failure message fails the mount at once", async (t) => {
  const { output, frame, clock, states, dom } = mountWithFrame(t);
  frame.load();
  await until(() => frame.boots.length === 1, "no boot message");
  // From any other window, the same message is ignored.
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { type: BOOT_FAILED_MESSAGE },
      source: dom.window,
    }),
  );
  assert.equal(output.state, "booting");
  frame.reportFailure();
  assert.equal(output.state, "failed");
  assert.equal(clock.now(), 0);
  assert.deepEqual(states.at(-1), ["failed", BOOT_FAILURE]);
});

test("a runtime that answers in time leaves the boot state; the startup limit still applies", async (t) => {
  const { output, frame, clock, states } = mountWithFrame(t, {
    bootTimeoutMs: 100,
    timeoutMs: 1000,
  });
  frame.answer = (_message, [port]) => {
    frame.port = port;
    port.postMessage({ type: "connected" });
  };
  t.after(() => frame.port?.close());
  frame.load();
  await until(() => output.state === "importing", "the runtime's answer was not taken");
  // A late failure message from the bootstrap changes nothing now.
  frame.reportFailure();
  assert.equal(output.state, "importing");
  clock.flush();
  assert.equal(clock.now(), 1000);
  assert.deepEqual(states, [
    "connecting",
    "booting",
    "loading",
    "importing",
    ["failed", START_TIMEOUT_FAILURE],
  ]);
});

test("a runtime the embedder loads lazily is sent once it resolves", async (t) => {
  let resolve;
  const loaded = new Promise((done) => (resolve = done));
  let calls = 0;
  const { output, frame } = mountWithFrame(t, {
    runtime: () => {
      calls++;
      return loaded;
    },
  });
  await tick();
  assert.equal(calls, 1, "asked for at mount, before the frame loads");
  frame.load();
  await tick();
  assert.deepEqual(frame.boots, []);
  resolve("lazy runtime");
  await until(() => frame.boots.length === 1, "no boot message");
  assert.equal(frame.boots[0].runtime, "lazy runtime");
  assert.equal(output.state, "booting");
});

test("a runtime that fails to load fails the mount with its reason", async (t) => {
  const { output, frame, states } = mountWithFrame(t, {
    runtime: () => Promise.reject(Error("chunk failed")),
  });
  frame.load();
  await until(() => output.state === "failed", "the mount did not fail");
  assert.deepEqual(frame.boots, []);
  assert.deepEqual(states.at(-1), ["failed", "chunk failed"]);
  assert.throws(
    () =>
      mountModuleOutput(new JSDOM("<main></main>").window.document.body, modulePayload, {
        frameUrl: "https://outputs.example/frame/v3/",
        hostContext: { theme: "light" },
      }),
    /runtime is required/,
  );
});
