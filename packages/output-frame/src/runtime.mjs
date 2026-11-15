import { outputTransition } from "./lifecycle.mjs";
import { applyHostContext } from "./context.mjs";

// No host APIs or credentials exist in this realm. AFM model changes are
// session-local. The only messages to the parent are lifecycle and height.
function localModel(initial) {
  const values = new Map(Object.entries(initial));
  const listeners = new Map();
  return {
    get: (key) => values.get(key),
    set(key, value) {
      values.set(key, value);
      for (const fn of listeners.get(`change:${key}`) ?? []) fn();
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      if (event == null) listeners.clear();
      else if (fn) listeners.get(event)?.delete(fn);
      else listeners.delete(event);
    },
    save_changes() {}, // Local profile: no persistence or remote runtime.
    send() {
      throw Error("This output profile has no runtime messaging.");
    },
  };
}

let state = "connecting";
const lifetime = new AbortController();
let context;
const contextListeners = new Set();
lifetime.signal.addEventListener("abort", () => contextListeners.clear(), { once: true });
const stop = () => {
  state = outputTransition(state, "dispose");
  lifetime.abort();
};
window.addEventListener("pagehide", stop, { once: true });

function connect(event) {
  if (
    state !== "connecting" ||
    event.source !== window.parent ||
    event.data?.type !== "nteract-output-connect-v1" ||
    event.data.nonce !== location.hash.slice(1) ||
    event.ports.length !== 1
  )
    return;
  window.removeEventListener("message", connect);
  const port = event.ports[0];
  state = outputTransition(outputTransition(state, "connect"), "connected");
  const send = (message) => port.postMessage(message);
  const phase = (event) => {
    state = outputTransition(state, event);
    send({ type: "phase", event });
  };
  const cleanup = (fn) => {
    if (typeof fn !== "function") return;
    if (lifetime.signal.aborted)
      void Promise.resolve()
        .then(fn)
        .catch(() => {});
    else
      lifetime.signal.addEventListener(
        "abort",
        () => {
          void Promise.resolve()
            .then(fn)
            .catch(() => {});
        },
        { once: true },
      );
  };
  port.onmessage = async ({ data }) => {
    if (data?.type === "context" && !lifetime.signal.aborted) {
      context = applyHostContext(document, data.context);
      for (const listener of contextListeners) {
        try {
          listener(context);
        } catch (error) {
          console.error("Output theme listener failed", error);
        }
      }
      return;
    }
    if (state !== "loading" || data?.type !== "mount") return;
    // Transition before the first interruptible step: duplicate mount
    // messages cannot import another module or replay initialize.
    state = outputTransition(state, "mount");
    try {
      context = applyHostContext(document, data.context ?? { theme: "light" });
      const { payload } = data;
      const code = new TextDecoder("utf-8", { fatal: true }).decode(payload.module.bytes);
      const moduleUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      let module;
      try {
        module = await import(/* @vite-ignore */ moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      lifetime.signal.throwIfAborted();
      const widget = typeof module.default === "function" ? await module.default() : module.default;
      lifetime.signal.throwIfAborted();
      if (!widget || typeof widget.render !== "function")
        throw Error("The ESM default export needs a render function.");
      phase("loaded");
      const inputs = Object.fromEntries(
        Object.entries(payload.inputs).map(([name, input]) => [
          name,
          {
            ...input,
            bytes: new DataView(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
          },
        ]),
      );
      const model = localModel({
        ...payload.state,
        ...Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.bytes])),
      });
      cleanup(() => model.off());
      cleanup(await widget.initialize?.({ model, signal: lifetime.signal }));
      lifetime.signal.throwIfAborted();
      phase("initialized");
      const el = document.querySelector("main");
      const host = Object.freeze({
        getContext: () => context,
        onContextChange(listener) {
          contextListeners.add(listener);
          return () => contextListeners.delete(listener);
        },
        getWidget: async () => {
          throw Error("Widget composition isn't supported by this profile.");
        },
        getModel: async () => {
          throw Error("Widget composition isn't supported by this profile.");
        },
      });
      cleanup(
        await widget.render({
          model,
          el,
          signal: lifetime.signal,
          host,
          output: Object.freeze({ inputs }),
        }),
      );
      lifetime.signal.throwIfAborted();
      phase("rendered");
      // The shell owns normal-flow layout. Measuring its flow-root body includes
      // child margins, floats and padding without a viewport-height feedback loop.
      const observer = new ResizeObserver(() =>
        send({ type: "height", height: document.body.getBoundingClientRect().height }),
      );
      observer.observe(document.body);
      cleanup(() => observer.disconnect());
    } catch (error) {
      if (!lifetime.signal.aborted) {
        state = outputTransition(state, "fail");
        send({ type: "error", message: String(error?.message ?? error).slice(0, 500) });
        lifetime.abort();
      }
    }
  };
  lifetime.signal.addEventListener("abort", () => port.close(), { once: true });
  send({ type: "connected" });
}
window.addEventListener("message", connect);
