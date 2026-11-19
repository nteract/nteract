import { receiveByteSource } from "./byte-source.mjs";
import { outputTransition } from "./lifecycle.mjs";
import { applyHostContext } from "./context.mjs";

import { createWidgetSession } from "./anywidget.mjs";

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
    event.data?.type !== "nteract-output-connect-v2" ||
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
      const catalog = document.getElementById("widget-catalog-map");
      const files = Object.entries(data.files ?? {});
      if (catalog || data.payload.imports || files.length) {
        const imports = catalog ? JSON.parse(catalog.textContent).imports : {};
        for (const [name, asset] of Object.entries(data.payload.imports ?? {})) {
          if (Object.hasOwn(imports, name))
            throw Error("Page module shadows a catalog import: " + name);
          const url = URL.createObjectURL(new Blob([asset.bytes], { type: "text/javascript" }));
          cleanup(() => URL.revokeObjectURL(url));
          imports[name] = url;
        }
        const bindings = [];
        for (const [name, descriptor] of files) {
          const url = URL.createObjectURL(
            new Blob(
              [
                "let file; export {file as default}; export const bind = value => { file ??= value }",
              ],
              { type: "text/javascript" },
            ),
          );
          cleanup(() => URL.revokeObjectURL(url));
          imports[name] = url;
          bindings.push([url, receiveByteSource(descriptor, lifetime.signal)]);
        }
        const script = document.createElement("script");
        script.type = "importmap";
        script.textContent = JSON.stringify({ imports });
        document.head.append(script);
        for (const [url, source] of bindings) (await import(url)).bind(source);
      }
      if (data.payload.kind === "module") {
        const url = URL.createObjectURL(
          new Blob([data.payload.assets.entry.bytes], { type: "text/javascript" }),
        );
        cleanup(() => URL.revokeObjectURL(url));
        phase("loaded");
        const { render } = await import(url);
        lifetime.signal.throwIfAborted();
        if (typeof render !== "function") throw Error("Export a render({el, signal}) function.");
        phase("initialized");
        cleanup(await render({ el: document.querySelector("main"), signal: lifetime.signal }));
      } else {
        const session = createWidgetSession(data.payload, {
          document,
          signal: lifetime.signal,
          contextHost: {
            getContext: () => context,
            onContextChange(listener) {
              contextListeners.add(listener);
              return () => contextListeners.delete(listener);
            },
          },
        });
        phase("loaded");
        await session.initialize();
        lifetime.signal.throwIfAborted();
        phase("initialized");
        await session.render(document.querySelector("main"));
      }
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
