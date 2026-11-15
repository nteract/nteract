import { firstValueFrom, from, fromEvent, takeUntil, timeout } from "rxjs";
import { widgetDefinitions, widgetState, ROOT_MODEL_ID } from "./schema.mjs";

export function localModel(initial) {
  const values = new Map(Object.entries(initial));
  const listeners = new Map();
  return {
    get: (key) => values.get(key),
    set(key, value) {
      if (Object.is(values.get(key), value) && values.has(key)) return;
      values.set(key, value);
      for (const fn of [...(listeners.get(`change:${key}`) ?? [])]) fn();
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) {
      for (const key of event == null ? [...listeners.keys()] : [event]) {
        if (fn == null) listeners.delete(key);
        else listeners.get(key)?.delete(fn);
      }
    },
    save_changes() {}, // Viewer-local state; no persistent or remote destination.
    send() {
      throw Error("This anywidget host has no backend for custom messages.");
    },
  };
}

// Shared values, lifetime-scoped subscriptions. off() and disposal must never
// remove a sibling view's subscriptions, even when they use the same callback.
export function scopedModel(model, signal) {
  const listeners = new Map();
  const scoped = {
    get: model.get,
    set: model.set,
    save_changes: model.save_changes,
    send: model.send,
    on(event, callback) {
      if (signal.aborted) return;
      if (!listeners.has(event)) listeners.set(event, new Map());
      const eventListeners = listeners.get(event);
      if (eventListeners.has(callback)) return;
      const listener = (...args) => {
        if (!signal.aborted) callback(...args);
      };
      eventListeners.set(callback, listener);
      model.on(event, listener);
    },
    off(event, callback) {
      for (const key of event == null ? [...listeners.keys()] : [event]) {
        const eventListeners = listeners.get(key);
        if (!eventListeners) continue;
        for (const [original, listener] of eventListeners) {
          if (callback != null && original !== callback) continue;
          model.off(key, listener);
          eventListeners.delete(original);
        }
        if (!eventListeners.size) listeners.delete(key);
      }
    },
  };
  signal.addEventListener("abort", () => scoped.off(), { once: true });
  return scoped;
}

export const WIDGET_STATES = ["idle", "importing", "initializing", "ready", "failed", "disposed"];
export function widgetTransition(state, event) {
  if (state === "disposed") return state;
  if (event === "dispose") return "disposed";
  if (state === "failed") return state;
  if (event === "fail") return "failed";
  return (
    {
      idle: { load: "importing" },
      importing: { loaded: "initializing" },
      initializing: { initialized: "ready" },
    }[state]?.[event] ?? state
  );
}
export const VIEW_STATES = ["initializing", "rendering", "ready", "failed", "disposed"];
export function viewTransition(state, event) {
  if (state === "disposed") return state;
  if (event === "dispose") return "disposed";
  if (state === "failed") return state;
  if (event === "fail") return "failed";
  return (
    { initializing: { initialized: "rendering" }, rendering: { rendered: "ready" } }[state]?.[
      event
    ] ?? state
  );
}

function cleanup(signal, fn, diagnostic) {
  if (typeof fn !== "function") return;
  const run = () => {
    void Promise.resolve().then(fn).catch(diagnostic);
  };
  if (signal.aborted) run();
  else signal.addEventListener("abort", run, { once: true });
}
function childLifetime(signals) {
  const controller = new AbortController();
  for (const signal of signals.filter(Boolean)) {
    if (controller.signal.aborted) break;
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      controller.signal.addEventListener(
        "abort",
        () => signal.removeEventListener("abort", abort),
        { once: true },
      );
    }
  }
  return controller;
}
async function importModule(code) {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// A registry belongs to one immutable iframe mount. Every model has one factory
// and initialize lifetime, but may render multiple independently disposed views.
export function createWidgetSession(
  payload,
  {
    document,
    signal,
    contextHost = {},
    loadModule = importModule,
    timeoutMs = 10000,
    scheduler,
    diagnostic = (error) => console.error("Anywidget lifecycle failed", error),
  },
) {
  const registry = new Map(
    widgetDefinitions(payload.spec).map(([id, definition]) => {
      const lifetime = childLifetime([signal]);
      const record = {
        id,
        state: "idle",
        lifetime,
        model: localModel(widgetState(definition, payload.assets)),
        task: undefined,
        widget: undefined,
        exports: undefined,
      };
      lifetime.signal.addEventListener(
        "abort",
        () => {
          record.state = widgetTransition(record.state, "dispose");
          record.model.off();
        },
        { once: true },
      );
      if (lifetime.signal.aborted) record.state = "disposed";
      return [id, record];
    }),
  );
  const resolve = (ref) => {
    if (typeof ref !== "string" || !ref.startsWith("anywidget:") || ref.length === 10)
      throw Error(`Invalid anywidget reference: ${String(ref).slice(0, 100)}`);
    const id = ref.slice(10),
      record = registry.get(id);
    if (!record) throw Error(`Unknown anywidget model: ${id.slice(0, 100)}`);
    return record;
  };
  const initialize = (record) => {
    if (record.task) return record.task;
    record.lifetime.signal.throwIfAborted();
    record.state = widgetTransition(record.state, "load");
    record.task = firstValueFrom(
      from(
        (async () => {
          const module = await loadModule(record.model.get("_esm"));
          record.lifetime.signal.throwIfAborted();
          const widget =
            typeof module.default === "function" ? await module.default() : module.default;
          record.lifetime.signal.throwIfAborted();
          if (
            !widget ||
            (typeof widget.initialize !== "function" && typeof widget.render !== "function")
          )
            throw Error("The AFM default export needs initialize or render.");
          record.widget = widget;
          record.state = widgetTransition(record.state, "loaded");
          const css = record.model.get("_css");
          if (css !== undefined) {
            const style = document.createElement("style");
            style.dataset.widgetId = record.id;
            style.textContent = css;
            document.head.append(style);
            cleanup(record.lifetime.signal, () => style.remove(), diagnostic);
          }
          const result = await widget.initialize?.({
            model: scopedModel(record.model, record.lifetime.signal),
            signal: record.lifetime.signal,
          });
          cleanup(record.lifetime.signal, result, diagnostic);
          record.lifetime.signal.throwIfAborted();
          record.exports = result && typeof result === "object" ? result : undefined;
          record.state = widgetTransition(record.state, "initialized");
          return record;
        })(),
      ).pipe(
        timeout({
          first: timeoutMs,
          scheduler,
          with: () => {
            throw Error(`Anywidget ${record.id} initialization timed out.`);
          },
        }),
        takeUntil(fromEvent(record.lifetime.signal, "abort")),
      ),
    ).catch((error) => {
      if (!record.lifetime.signal.aborted) {
        record.state = widgetTransition(record.state, "fail");
        diagnostic(error);
        record.lifetime.abort(error);
      }
      throw error;
    });
    return record.task;
  };
  const render = async (record, { el, signal: viewSignal }, parentSignal) => {
    const lifetime = childLifetime([record.lifetime.signal, parentSignal, viewSignal]);
    let state = "initializing";
    lifetime.signal.addEventListener(
      "abort",
      () => {
        state = viewTransition(state, "dispose");
      },
      { once: true },
    );
    try {
      lifetime.signal.throwIfAborted();
      const Observer = document.defaultView?.MutationObserver;
      if (Observer) {
        let connected = el.isConnected;
        const observer = new Observer(() => {
          if (connected && !el.isConnected) lifetime.abort();
          connected ||= el.isConnected;
        });
        observer.observe(document, { subtree: true, childList: true });
        cleanup(lifetime.signal, () => observer.disconnect(), diagnostic);
      }
      // Establish the view lifetime before even a resolved initialize promise:
      // the caller can remove el in that microtask gap. Cancel this wait without
      // cancelling a shared model that another view may still need.
      await firstValueFrom(
        from(initialize(record)).pipe(takeUntil(fromEvent(lifetime.signal, "abort"))),
      );
      lifetime.signal.throwIfAborted();
      state = viewTransition(state, "initialized");
      if (typeof record.widget.render !== "function")
        throw Error(`Anywidget ${record.id} has no render hook.`);
      const models = new Map();
      const modelFor = (target) => {
        if (!models.has(target.id))
          models.set(target.id, scopedModel(target.model, lifetime.signal));
        return models.get(target.id);
      };
      const host = Object.freeze({
        ...contextHost,
        onContextChange(listener) {
          lifetime.signal.throwIfAborted();
          let active = true;
          const remove = contextHost.onContextChange((context) => {
            if (active && !lifetime.signal.aborted) listener(context);
          });
          const unsubscribe = () => {
            if (!active) return;
            active = false;
            remove();
          };
          cleanup(lifetime.signal, unsubscribe, diagnostic);
          return unsubscribe;
        },
        async getModel(ref) {
          lifetime.signal.throwIfAborted();
          return modelFor(resolve(ref));
        },
        async getWidget(ref) {
          lifetime.signal.throwIfAborted();
          const child = await initialize(resolve(ref));
          lifetime.signal.throwIfAborted();
          return Object.freeze({
            exports: child.exports,
            render: (opts) => render(child, opts, lifetime.signal),
          });
        },
      });
      const result = await record.widget.render({
        model: modelFor(record),
        el,
        signal: lifetime.signal,
        host,
      });
      cleanup(lifetime.signal, result, diagnostic);
      lifetime.signal.throwIfAborted();
      state = viewTransition(state, "rendered");
    } catch (error) {
      if (!lifetime.signal.aborted) {
        state = viewTransition(state, "fail");
        diagnostic(error);
      }
      const reason = lifetime.signal.aborted ? lifetime.signal.reason : error;
      lifetime.abort(reason);
      throw reason;
    }
  };
  return {
    initialize: () => initialize(registry.get(ROOT_MODEL_ID)),
    render: (el) => render(registry.get(ROOT_MODEL_ID), { el, signal }),
  };
}
