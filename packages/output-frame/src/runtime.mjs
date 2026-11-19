import { createFrameData, dataAlias, receiveDataChange } from "./data.mjs";
import { PROTOCOL_VERSION, connectVersion, outputTransition } from "./lifecycle.mjs";
import { applyHostContext } from "./context.mjs";

import { createWidgetSession } from "./anywidget.mjs";

let state = "connecting";
const lifetime = new AbortController();
let context;
// The rendered session, and a module view's data inputs by declared name.
let session;
let frameData;
const contextListeners = new Set();
lifetime.signal.addEventListener("abort", () => contextListeners.clear(), { once: true });
const stop = () => {
  state = outputTransition(state, "dispose");
  lifetime.abort();
};
window.addEventListener("pagehide", stop, { once: true });

function connect(event) {
  const version = connectVersion(event.data?.type);
  if (
    state !== "connecting" ||
    event.source !== window.parent ||
    version === null ||
    event.data.nonce !== location.hash.slice(1) ||
    event.ports.length !== 1
  )
    return;
  window.removeEventListener("message", connect);
  const port = event.ports[0];
  if (version !== PROTOCOL_VERSION) {
    stop();
    port.postMessage({
      type: "error",
      message: `This output frame speaks protocol v${PROTOCOL_VERSION} and the page sent v${version}. Reload the page.`,
    });
    port.close();
    return;
  }
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
    if (data?.type === "data") {
      // The parent sends data only after "rendered", and only for names the
      // mount declared. Anything else is ignored. A change no listener would
      // show is not applied: the parent mounts the view again instead.
      if (state !== "ready" || !session) return;
      try {
        receiveDataChange(data, { session, frameData, send });
      } catch (error) {
        console.error("Output data update failed", error);
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
      const module = data.payload.kind === "module";
      frameData = module ? createFrameData(data.files ?? {}, lifetime.signal) : undefined;
      const files = Object.entries(frameData?.initial ?? {});
      if (catalog || data.payload.imports || files.length) {
        const imports = catalog ? JSON.parse(catalog.textContent).imports : {};
        for (const [name, asset] of Object.entries(data.payload.imports ?? {})) {
          if (Object.hasOwn(imports, name))
            throw Error("Page module shadows a catalog import: " + name);
          const url = URL.createObjectURL(new Blob([asset.bytes], { type: "text/javascript" }));
          cleanup(() => URL.revokeObjectURL(url));
          imports[name] = url;
        }
        // Each data/ import is bound once, to the file object the view
        // mounted with, which the model also starts with. A later change
        // gives the model a new file object; this one's calls then abort.
        const bindings = [];
        for (const [name, input] of files) {
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
          bindings.push([url, input]);
        }
        // The runtime is a classic script: an import map appended at mount
        // applies only while no module has loaded in this document. Nothing
        // may import() a module before this append, and this module must not
        // be shipped as type="module" or imported by another module script.
        const script = document.createElement("script");
        script.type = "importmap";
        script.textContent = JSON.stringify({ imports });
        document.head.append(script);
        for (const [url, source] of bindings) (await import(url)).bind(source);
      }
      // A module view's model holds one key per data alias. Its entry is
      // imported here, after the import map above.
      const created = createWidgetSession(
        module
          ? {
              ...data.payload,
              state: Object.fromEntries(files.map(([name, file]) => [dataAlias(name), file])),
            }
          : data.payload,
        {
          document,
          signal: lifetime.signal,
          contextHost: {
            getContext: () => context,
            onContextChange(listener) {
              contextListeners.add(listener);
              return () => contextListeners.delete(listener);
            },
          },
        },
      );
      phase("loaded");
      await created.initialize();
      lifetime.signal.throwIfAborted();
      phase("initialized");
      await created.render(document.querySelector("main"));
      lifetime.signal.throwIfAborted();
      session = created;
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
