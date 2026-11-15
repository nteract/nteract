import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { VirtualTimeScheduler } from "rxjs";
import { checkAnywidgetSpec, widgetState } from "../../../packages/output-frame/src/schema.mjs";
import { preparePayload } from "../../../packages/output-frame/src/payload.mjs";
// Resolve the installed package, whose dependencies belong to the Pages install.
// A direct checkout import accidentally relies on root-level node_modules.
const {
  createWidgetSession,
  localModel,
  WIDGET_STATES,
  widgetTransition,
  VIEW_STATES,
  viewTransition,
} = await import(new URL("./anywidget.mjs", import.meta.resolve("@nteract/output-frame/runtime")));

const asset = (text, mediaType = "text/javascript") => ({
  bytes: new TextEncoder().encode(text),
  mediaType,
});
function fixture(
  t,
  { spec = { _esm: "code" }, assets = { code: asset("root") }, loadModule, ...options } = {},
) {
  const dom = new JSDOM("<main></main>");
  const lifetime = new AbortController();
  t.after(() => {
    lifetime.abort();
    dom.window.close();
  });
  const payload = preparePayload({ spec, assets });
  const errors = [];
  const session = createWidgetSession(payload, {
    document: dom.window.document,
    signal: lifetime.signal,
    loadModule,
    diagnostic: (error) => errors.push(error),
    ...options,
  });
  return {
    session,
    lifetime,
    errors,
    el: dom.window.document.querySelector("main"),
    doc: dom.window.document,
  };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

test("AFM local changes and listener removal never require a backend", () => {
  const model = localModel({ count: 0 });
  let calls = 0;
  const changed = (...args) => {
    assert.equal(args.length, 0);
    calls++;
  };
  model.on("change:count", changed);
  model.on("change:other", changed);
  model.set("count", 1);
  model.set("count", 1);
  model.save_changes();
  assert.equal(calls, 1);
  assert.equal(model.get("count"), 1);
  model.off(null, changed);
  model.set("other", 2);
  assert.equal(calls, 1);
  assert.throws(() => model.send({ action: "calculate" }), /no backend/);
  model.on("msg:custom", () => assert.fail("No backend messages should be invented"));
  model.save_changes();
});

test("schema binds CSS, shared modules, nested binary state and child models", () => {
  const spec = {
    _esm: "code",
    _css: "style",
    state: { nested: { values: [null] } },
    buffers: ["data"],
    buffer_paths: [["nested", "values", 0]],
    models: { child: { _esm: "code" } },
  };
  assert.deepEqual(checkAnywidgetSpec(spec), { ok: true, names: ["code", "style", "data"] });
  const payload = preparePayload({
    spec,
    assets: {
      code: asset("export default {}"),
      style: asset("button { color:red }", "text/css"),
      data: {
        bytes: new Uint8Array([99, 42, 99]).subarray(1, 2),
        mediaType: "application/octet-stream",
      },
    },
  });
  const state = widgetState(spec, payload.assets);
  assert.ok(state.nested.values[0] instanceof DataView);
  assert.equal(state.nested.values[0].getUint8(0), 42);
  assert.equal(state.nested.values[0].buffer.byteLength, 1);
  assert.equal(spec.state.nested.values[0], null);
  assert.equal(state._css, "button { color:red }");
  for (const path of [
    ["__proto__", "polluted"],
    ["constructor", "prototype"],
    ["nested", "values", 2],
    ["nested", "missing", "data"],
    ["nested", "values", "0"],
    ["_esm"],
    [],
  ])
    assert.equal(
      checkAnywidgetSpec({ ...spec, buffer_paths: [path] }).ok,
      false,
      JSON.stringify(path),
    );
  assert.equal(
    checkAnywidgetSpec({ _esm: "code", buffers: ["data", "data"], buffer_paths: [["a"], ["a"]] })
      .ok,
    false,
  );
  assert.equal(checkAnywidgetSpec({ _esm: "code", models: { root: { _esm: "code" } } }).ok, false);
  assert.throws(
    () => preparePayload({ spec: { _esm: "code", _css: "code" }, assets: { code: asset("x") } }),
    /text\/css/,
  );
  assert.throws(
    () =>
      preparePayload({
        spec: { _esm: "code" },
        assets: { code: asset("x"), extra: asset("secret") },
      }),
    /exactly/,
  );
});

test("factory and initialization run once; composition shares models and exports across views", async (t) => {
  let factories = 0,
    initialized = 0,
    disposed = 0,
    childModel,
    host;
  const signals = [];
  const f = fixture(t, {
    spec: {
      _esm: "code",
      state: { child: "anywidget:child" },
      models: { child: { _esm: "child", _css: "style", state: { count: 0 } } },
    },
    assets: {
      code: asset("root"),
      child: asset("child"),
      style: asset("button { color: red }", "text/css"),
    },
    loadModule: async (code) =>
      code === "root"
        ? {
            default: {
              render(props) {
                host = props.host;
              },
            },
          }
        : {
            default: async () => {
              factories++;
              return {
                async initialize({ model, signal }) {
                  initialized++;
                  childModel = model;
                  signal.addEventListener("abort", () => disposed++);
                  return { getCount: () => model.get("count") };
                },
                render({ model, el, signal }) {
                  signals.push(signal);
                  el.textContent = model.get("count");
                  return () => {
                    assert.equal(signal.aborted, true);
                    disposed++;
                  };
                },
              };
            },
          },
  });
  await f.session.render(f.el);
  const [a, b] = await Promise.all([
    host.getWidget("anywidget:child"),
    host.getWidget("anywidget:child"),
  ]);
  assert.equal(factories, 1);
  assert.equal(initialized, 1);
  assert.equal((await host.getModel("anywidget:child")).get("count"), childModel.get("count"));
  childModel.set("count", 7);
  childModel.save_changes();
  assert.equal(a.exports.getCount(), 7);
  const left = f.el.appendChild(f.doc.createElement("div")),
    right = f.el.appendChild(f.doc.createElement("div"));
  const viewLifetime = new AbortController();
  await a.render({ el: left, signal: viewLifetime.signal });
  await b.render({ el: right });
  assert.equal(right.textContent, "7");
  viewLifetime.abort();
  await settle();
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  assert.equal(disposed, 1);
  await assert.rejects(host.getWidget("missing"), /Invalid.*missing/);
  await assert.rejects(host.getModel("anywidget:unknown"), /Unknown.*unknown/);
  assert.equal(f.doc.querySelectorAll("style[data-widget-id]").length, 1);
  f.lifetime.abort();
  await settle();
  assert.equal(disposed, 3);
  assert.equal(f.doc.querySelectorAll("style[data-widget-id]").length, 0);
  assert.deepEqual(f.errors, []);
});

test("removed views abort their signal and late render cleanup runs exactly once", async (t) => {
  let finish,
    signal,
    cleaned = 0;
  const f = fixture(t, {
    loadModule: async () => ({
      default: {
        render(props) {
          signal = props.signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    }),
  });
  await f.session.initialize();
  const pending = f.session.render(f.el);
  await settle();
  f.el.remove();
  await settle();
  assert.equal(signal.aborted, true);
  const rejected = assert.rejects(pending, /abort/i);
  finish(() => cleaned++);
  await rejected;
  await settle();
  f.lifetime.abort();
  await settle();
  assert.equal(cleaned, 1);
});

test("theme subscriptions follow each view lifetime and unsubscribe independently", async (t) => {
  let rootHost;
  const hosts = [],
    calls = [0, 0],
    listeners = new Set();
  let removals = 0;
  const notify = () => {
    for (const listener of listeners) listener({ theme: "dark" });
  };
  const f = fixture(t, {
    spec: { _esm: "root", models: { child: { _esm: "child" } } },
    assets: { root: asset("root"), child: asset("child") },
    contextHost: {
      onContextChange(listener) {
        listeners.add(listener);
        return () => {
          removals++;
          listeners.delete(listener);
        };
      },
    },
    loadModule: async (code) => ({
      default: {
        render({ host }) {
          if (code === "root") {
            rootHost = host;
            return;
          }
          const index = hosts.length;
          hosts.push(host);
          host.onContextChange(() => calls[index]++);
        },
      },
    }),
  });
  await f.session.render(f.el);
  const child = await rootHost.getWidget("anywidget:child");
  const left = f.el.appendChild(f.doc.createElement("div"));
  const right = f.el.appendChild(f.doc.createElement("div"));
  const controller = new AbortController();
  await child.render({ el: left, signal: controller.signal });
  await child.render({ el: right });
  notify();
  assert.deepEqual(calls, [1, 1]);
  controller.abort();
  notify(); // Even before asynchronous cleanup, an aborted view receives nothing.
  assert.deepEqual(calls, [1, 2]);
  await settle();
  assert.equal(listeners.size, 1);
  assert.throws(() => hosts[0].onContextChange(() => {}), /abort/i);
  right.remove();
  await settle();
  notify();
  assert.deepEqual(calls, [1, 2]);
  assert.equal(listeners.size, 0);
  assert.throws(() => hosts[1].onContextChange(() => {}), /abort/i);
  const unsubscribe = rootHost.onContextChange(() => assert.fail("unsubscribed"));
  unsubscribe();
  unsubscribe();
  notify();
  assert.equal(removals, 3);
  rootHost.onContextChange(() => assert.fail("disposed root"));
  f.lifetime.abort();
  notify();
  await settle();
  assert.equal(listeners.size, 0);
  assert.equal(removals, 4);
});

test("failed initialization is not retried and no view renders", async (t) => {
  let calls = 0,
    initSignal;
  const f = fixture(t, {
    loadModule: async () => ({
      default: {
        initialize({ signal }) {
          initSignal = signal;
          calls++;
          throw Error("bad init");
        },
        render() {
          assert.fail("must not render");
        },
      },
    }),
  });
  await assert.rejects(f.session.render(f.el), /bad init/);
  await assert.rejects(f.session.render(f.el), /bad init/);
  assert.equal(initSignal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(f.errors.length, 1);
});

test("initialization timeout aborts and cleans late completion using virtual time", async (t) => {
  const clock = new VirtualTimeScheduler();
  let finish,
    initSignal,
    cleaned = 0;
  const f = fixture(t, {
    scheduler: clock,
    timeoutMs: 50,
    loadModule: async () => ({
      default: {
        initialize({ signal }) {
          initSignal = signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    }),
  });
  const pending = f.session.initialize();
  const rejected = assert.rejects(pending, /timed out/);
  await settle();
  clock.flush();
  await rejected;
  assert.equal(initSignal.aborted, true);
  finish(() => cleaned++);
  await settle();
  assert.equal(cleaned, 1);
});

test("widget and view transitions are exhaustive and terminal phases cannot revive", () => {
  for (const [states, transition, successors] of [
    [
      WIDGET_STATES,
      widgetTransition,
      {
        idle: { load: "importing" },
        importing: { loaded: "initializing" },
        initializing: { initialized: "ready" },
      },
    ],
    [
      VIEW_STATES,
      viewTransition,
      { initializing: { initialized: "rendering" }, rendering: { rendered: "ready" } },
    ],
  ])
    for (const state of states)
      for (const event of [
        "load",
        "loaded",
        "initialized",
        "rendered",
        "fail",
        "dispose",
        "unknown",
      ])
        assert.equal(
          transition(state, event),
          state === "disposed"
            ? state
            : event === "dispose"
              ? "disposed"
              : state === "failed"
                ? state
                : event === "fail"
                  ? "failed"
                  : (successors[state]?.[event] ?? state),
          `${state}/${event}`,
        );
});

test("removing one view cleans only its listeners, including subscriptions via getModel", async (t) => {
  let host,
    initialized,
    renders = 0;
  const calls = [0, 0],
    offCalls = [0, 0];
  const f = fixture(t, {
    spec: { _esm: "root", models: { child: { _esm: "child", state: { count: 0 } } } },
    assets: { root: asset("root"), child: asset("child") },
    loadModule: async (code) => ({
      default:
        code === "root"
          ? {
              render(props) {
                host = props.host;
              },
            }
          : {
              initialize({ model }) {
                initialized = model;
              },
              async render({ model, host, signal }) {
                const index = renders++;
                // Legacy widgets need not know the host's lifecycle machinery.
                model.on("change:count", () => calls[index]++);
                const same = await host.getModel("anywidget:child");
                assert.equal(same, await host.getModel("anywidget:child"));
                same.on("change:count", () => offCalls[index]++);
                return () => {
                  assert.equal(signal.aborted, true);
                  model.off();
                };
              },
            },
    }),
  });
  await f.session.render(f.el);
  const child = await host.getWidget("anywidget:child");
  const left = f.el.appendChild(f.doc.createElement("div")),
    right = f.el.appendChild(f.doc.createElement("div"));
  await child.render({ el: left });
  await child.render({ el: right });
  initialized.set("count", 1);
  assert.deepEqual(calls, [1, 1]);
  assert.deepEqual(offCalls, [1, 1]);
  left.remove();
  await settle();
  initialized.set("count", 2);
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(offCalls, [1, 2]);
  f.lifetime.abort();
  await settle();
  initialized.set("count", 3);
  assert.deepEqual(calls, [1, 2]);
});

test("a child with its own signal and external DOM still follows its parent view", async (t) => {
  let host,
    childSignal,
    cleaned = 0;
  const own = new AbortController(),
    parent = new AbortController();
  const f = fixture(t, {
    spec: { _esm: "root", models: { parent: { _esm: "parent" }, child: { _esm: "child" } } },
    assets: { root: asset("root"), parent: asset("parent"), child: asset("child") },
    loadModule: async (code) => ({
      default: {
        async render(props) {
          if (code === "root") {
            host = props.host;
            return;
          }
          if (code === "parent") {
            const child = await props.host.getWidget("anywidget:child");
            const outside = f.doc.body.appendChild(f.doc.createElement("aside"));
            await child.render({ el: outside, signal: own.signal });
            return;
          }
          childSignal = props.signal;
          return () => cleaned++;
        },
      },
    }),
  });
  await f.session.render(f.el);
  const widget = await host.getWidget("anywidget:parent");
  await widget.render({ el: f.el.appendChild(f.doc.createElement("div")), signal: parent.signal });
  parent.abort();
  await settle();
  assert.equal(own.signal.aborted, false);
  assert.equal(childSignal.aborted, true);
  assert.equal(cleaned, 1);
});

test("removal during the initialization wait prevents rendering but preserves the shared model", async (t) => {
  let finish,
    modelSignal,
    rendered = 0;
  const f = fixture(t, {
    loadModule: async () => ({
      default: {
        initialize({ signal }) {
          modelSignal = signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        render() {
          rendered++;
        },
      },
    }),
  });
  const pending = f.session.render(f.el);
  const rejected = assert.rejects(pending, /abort/i);
  await settle();
  f.el.remove();
  await rejected;
  assert.equal(modelSignal.aborted, false);
  finish();
  await settle();
  assert.equal(rendered, 0);
  const replacement = f.doc.body.appendChild(f.doc.createElement("main"));
  await f.session.render(replacement);
  assert.equal(rendered, 1);
});

test("removal immediately after render of an initialized child prevents a detached view", async (t) => {
  let host,
    rendered = 0;
  const f = fixture(t, {
    spec: { _esm: "root", models: { child: { _esm: "child" } } },
    assets: { root: asset("root"), child: asset("child") },
    loadModule: async (code) => ({
      default: {
        render(props) {
          if (code === "root") host = props.host;
          else rendered++;
        },
      },
    }),
  });
  await f.session.render(f.el);
  const child = await host.getWidget("anywidget:child");
  const el = f.el.appendChild(f.doc.createElement("div"));
  const pending = child.render({ el });
  const rejected = assert.rejects(pending, /abort/i);
  el.remove();
  await rejected;
  assert.equal(rendered, 0);
});
