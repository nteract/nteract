import { exposeFile } from "./byte-source.mjs";
import { createReadBudget } from "./read-budget.mjs";
import { filter, from, fromEvent, Subscription, timer } from "rxjs";
import {
  answerTransition,
  BOOT_FAILED_MESSAGE,
  BOOT_FAILURE,
  BOOT_MESSAGE,
  BOOT_TIMEOUT_MS,
  connectMessageType,
  dataTransition,
  outputTransition,
  startupFailure,
} from "./lifecycle.mjs";
import { DATA_NAME, MAX_DATA_NAMES, bufferNames } from "./data.mjs";
import { createWholeFiles } from "./whole-file-total.mjs";
import { preparePayload } from "./payload.mjs";
import { normalizeHostContext } from "./context.mjs";
export { readHostContext, OUTPUT_STYLE_VARIABLES } from "./context.mjs";

const MAX_DATA_BYTES = 5 * 1024 * 1024;
// The most bytes a module view's live files may hold read whole: each file
// is delivered whole at most once (whole-file-total.mjs).
export const MAX_WHOLE_FILE_TOTAL = 32 * 1024 * 1024;

// A module view's data input is a file the embedder serves on request:
// {mimeType, byteLength, read(offset, length, signal), bytes(signal),
// columns?(format, signal)}. `columns` reads the file as a ColumnSet in a
// table format (byte-source.mjs TABLE_FORMATS) and rejects for a format the
// file is not in; it is absent when the embedder can decode the file in no
// format. An anywidget buffer is a whole file (Uint8Array).
function checkDataInput(value, module) {
  if (module) {
    if (
      typeof value?.mimeType === "string" &&
      value.mimeType.length <= 255 &&
      Number.isSafeInteger(value.byteLength) &&
      value.byteLength >= 0 &&
      typeof value.read === "function" &&
      typeof value.bytes === "function" &&
      (value.columns === undefined || typeof value.columns === "function")
    )
      return;
    throw Error(
      "A data input is {mimeType, byteLength, read(offset, length, signal), bytes(signal), columns?(format, signal)}.",
    );
  }
  if (!(value instanceof Uint8Array)) throw Error("A buffer is a Uint8Array.");
  if (value.byteLength > MAX_DATA_BYTES) throw Error("A data input is at most 5 MiB.");
}

// One mount of one set of code, one port. No inbound request can address a
// URL. Each file port serves one data input. Data inputs, the module view's
// data/ files or the anywidget buffers, can change within the mount through
// setData.
//
// `frameUrl` serves the bootstrap document (bootstrap.mjs). `runtime` is the
// frame runtime's text from the embedder's own build, or a function that
// resolves to it; the host sends it in the boot message, so the runtime always
// matches this host.
//
// `payload.libraries` maps bare names to library modules the embedder serves
// on its own origin (payload.mjs checkLibraries). The frame's import map
// resolves them; the frame document itself names none.
export { mountModuleOutput as mountAnywidgetOutput };
export function mountModuleOutput(
  container,
  payload,
  {
    frameUrl,
    runtime,
    hostContext,
    files = {},
    timeoutMs = 20000,
    bootTimeoutMs = BOOT_TIMEOUT_MS,
    scheduler,
    onState = () => {},
    onUnhandledData = () => {},
  } = {},
) {
  if (!frameUrl) throw Error("An output frame URL is required.");
  if (typeof runtime !== "string" && typeof runtime !== "function")
    throw Error("An output frame runtime is required.");
  const doc = container.ownerDocument;
  payload = preparePayload(payload, { origin: doc.location.origin });
  const module = payload.kind === "module";
  const names = Object.keys(files);
  if (
    names.length > MAX_DATA_NAMES ||
    names.some((name) => !DATA_NAME.test(name)) ||
    (names.length && !module)
  )
    throw Error("A module view may bind up to 16 data/ file imports.");
  for (const value of Object.values(files)) checkDataInput(value, true);
  // The names setData accepts: what the frame can also check from its mount.
  const dataNames = new Set(module ? names : bufferNames(payload.spec));
  let context = normalizeHostContext(hostContext);
  const url = new URL(frameUrl, doc.location.href);
  if (
    url.origin === doc.location.origin ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
  )
    throw Error("Outputs require a separate HTTPS origin.");
  const nonce = crypto.randomUUID();
  url.hash = nonce;
  const frame = doc.createElement("iframe");
  frame.title = payload.title || "Interactive output";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.referrerPolicy = "no-referrer";
  frame.style.cssText = "display:block;width:100%;height:440px;border:0;visibility:hidden";
  const channel = new MessageChannel();
  const subscriptions = new Subscription();
  const lifetime = new AbortController();
  let state = "connecting";
  // One read budget for the view, shared by all of its files, including
  // those a data change exposes. Created at mount.
  let budget;
  // Data changes not yet sent (see dataTransition).
  let pending = [];
  // Names whose sent data message the frame may still answer as unhandled
  // (see answerTransition).
  let awaiting = [];
  // Each name's exposed file: its lifetime and its id in `wholeFiles`, the
  // whole reads of the view's files.
  const exposed = new Map();
  const wholeFiles = createWholeFiles(MAX_WHOLE_FILE_TOTAL);
  let fileIds = 0;
  // Ends `name`'s previous input and describes `value` for the frame: a
  // dedicated copy of whole bytes, or a new port that serves the file.
  const describe = (name, value) => {
    const previous = exposed.get(name);
    exposed.delete(name);
    previous?.lifetime.abort();
    if (previous) wholeFiles.replaced(previous.id);
    if (value instanceof Uint8Array) {
      const bytes = new Uint8Array(value);
      return [{ bytes }, [bytes.buffer]];
    }
    const own = new AbortController();
    const id = String(++fileIds);
    exposed.set(name, { lifetime: own, id });
    const signal = AbortSignal.any([lifetime.signal, own.signal]);
    const file = exposeFile(value, signal, budget, wholeFiles.file(id, value.byteLength));
    return [file, [file.port]];
  };
  const deliver = (change) => {
    const result = dataTransition(state, pending, change);
    pending = result.pending;
    for (const [name, value] of result.send) {
      const [input, transfer] = describe(name, value);
      channel.port1.postMessage({ type: "data", name, input }, transfer);
    }
    awaiting = answerTransition(
      awaiting,
      state === "failed" || state === "disposed"
        ? { type: "end" }
        : { type: "sent", names: result.send.map(([name]) => name) },
    ).awaiting;
  };
  const step = (event, error) => {
    const next = outputTransition(state, event);
    if (next === state) return;
    state = next;
    if (state === "ready") frame.style.visibility = "visible";
    onState(state, error);
    deliver();
    if (state === "booting")
      subscriptions.add(
        timer(bootTimeoutMs, scheduler).subscribe(() => {
          if (state === "booting") step("fail", BOOT_FAILURE);
        }),
      );
    if (state === "failed" || state === "disposed") {
      lifetime.abort();
      subscriptions.unsubscribe();
      channel.port1.close();
      channel.port2.close();
      frame.remove();
    }
  };
  // Started now, so a runtime the embedder loads lazily arrives while the
  // frame document loads.
  const runtimeText = Promise.resolve()
    .then(() => (typeof runtime === "function" ? runtime() : runtime))
    .then((text) => {
      if (typeof text !== "string") throw Error("The output frame runtime is not text.");
      return text;
    });
  runtimeText.catch(() => {});
  // The frame document loads once per mount; another load is a navigation.
  let loaded = false;
  subscriptions.add(
    fromEvent(frame, "load").subscribe(() => {
      if (loaded) {
        step("fail", "The output navigated away. Run it again to reconnect.");
        return;
      }
      loaded = true;
      // "booting" starts with the boot message, not the load: a slow
      // runtime text is the startup limit's to bound, not the boot bound's.
      subscriptions.add(
        from(runtimeText).subscribe({
          next(text) {
            if (state !== "connecting") return;
            step("boot");
            // The receiver has an opaque origin; targetOrigin cannot be a
            // domain. Transfer to this exact WindowProxy, with a
            // mount-specific nonce. The bootstrap passes the message on to
            // the runtime as it is.
            try {
              frame.contentWindow.postMessage(
                { type: BOOT_MESSAGE, runtime: text, connect: connectMessageType(), nonce },
                "*",
                [channel.port2],
              );
            } catch (error) {
              step("fail", error.message);
            }
          },
          error: (error) => step("fail", String(error?.message ?? error).slice(0, 500)),
        }),
      );
    }),
  );
  // The bootstrap's one message: the runtime it was sent did not start.
  subscriptions.add(
    fromEvent(doc.defaultView, "message")
      .pipe(
        filter(
          (event) =>
            state === "booting" &&
            event.source === frame.contentWindow &&
            event.data?.type === BOOT_FAILED_MESSAGE,
        ),
      )
      .subscribe(() => step("fail", BOOT_FAILURE)),
  );
  subscriptions.add(
    fromEvent(channel.port1, "message").subscribe(({ data }) => {
      if (!data || typeof data !== "object") return;
      if (data.type === "connected" && state === "booting") {
        step("connected");
        const transfers = [
          ...Object.values(payload.assets),
          ...Object.values(payload.imports ?? {}),
        ].map((asset) => asset.bytes.buffer);
        try {
          step("mount");
          budget = createReadBudget({ lifetime: lifetime.signal, scheduler });
          const described = {};
          for (const [name, value] of Object.entries(files)) {
            const [input, transfer] = describe(name, value);
            described[name] = input;
            transfers.push(...transfer);
          }
          channel.port1.postMessage({ type: "mount", payload, context, files: described }, [
            ...new Set(transfers),
          ]);
        } catch (error) {
          step("fail", error.message);
        }
      } else if (
        data.type === "phase" &&
        ["loaded", "initialized", "rendered"].includes(data.event)
      ) {
        step(data.event);
      } else if (data.type === "error") {
        step(
          "fail",
          typeof data.message === "string" ? data.message.slice(0, 500) : "Output failed.",
        );
      } else if (data.type === "unhandled-data") {
        // No listener in the view would show this change. Only an answer to
        // a data message the host sent counts, once per message, so view
        // code cannot ask for more mounts than there were data changes.
        if (state !== "ready" || typeof data.name !== "string" || !dataNames.has(data.name)) return;
        const answer = answerTransition(awaiting, { type: "unhandled", name: data.name });
        awaiting = answer.awaiting;
        if (answer.accept) onUnhandledData(data.name);
      } else if (data.type === "height" && state === "ready" && Number.isFinite(data.height)) {
        // A document output grows with its content. Retain an abuse bound, not
        // a normal widget-sized viewport that makes every tall view scroll twice.
        frame.style.height = `${Math.max(1, Math.min(100000, Math.ceil(data.height)))}px`;
      }
    }),
  );
  channel.port1.start();
  subscriptions.add(
    timer(timeoutMs, scheduler).subscribe(() => {
      if (state !== "ready") step("fail", startupFailure(state));
    }),
  );
  frame.src = url.href;
  container.append(frame);
  onState(state);
  return {
    frame,
    get state() {
      return state;
    },
    setHostContext(next) {
      if (state === "failed" || state === "disposed") return;
      context = normalizeHostContext(next);
      if (!["connecting", "booting"].includes(state))
        channel.port1.postMessage({ type: "context", context });
    },
    // A new value for a data name the mount declared: a data/ name of a
    // module view (a file input; see checkDataInput) or a buffer of an anywidget view
    // (Uint8Array). It reaches the frame once the view has rendered; until
    // then the latest value per name waits. A failed or disposed mount drops
    // it.
    setData(name, value) {
      if (typeof name !== "string" || !dataNames.has(name))
        throw Error(`Unknown data name: ${String(name).slice(0, 80)}`);
      checkDataInput(value, module);
      deliver([name, value]);
    },
    destroy() {
      step("dispose");
    },
  };
}
