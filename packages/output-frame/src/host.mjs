import { exposeByteSource } from "./byte-source.mjs";
import { createReadBudget } from "./read-budget.mjs";
import { fromEvent, Subscription, timer } from "rxjs";
import { answerTransition, dataTransition, outputTransition } from "./lifecycle.mjs";
import { DATA_NAME, MAX_DATA_NAMES, bufferNames } from "./data.mjs";
import { preparePayload } from "./payload.mjs";
import { normalizeHostContext } from "./context.mjs";
export { readHostContext, OUTPUT_STYLE_VARIABLES } from "./context.mjs";

const MAX_DATA_BYTES = 5 * 1024 * 1024;

// A module view's data input is a whole file (Uint8Array) or a ranged file
// (ByteSource). An anywidget buffer is always a whole file.
function checkDataInput(value, ranged) {
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_DATA_BYTES) throw Error("A data input is at most 5 MiB.");
    return;
  }
  if (
    ranged &&
    Number.isSafeInteger(value?.byteLength) &&
    value.byteLength >= 0 &&
    typeof value.read === "function"
  )
    return;
  throw Error(
    ranged
      ? "A data input is a Uint8Array or a {byteLength, read} file."
      : "A buffer is a Uint8Array.",
  );
}

// One mount of one set of code, one port. No inbound request can address a
// URL. Each ranged file port serves one ByteSource. Data inputs, the module
// view's data/ files or the anywidget buffers, can change within the mount
// through setData.
export { mountModuleOutput as mountAnywidgetOutput };
export function mountModuleOutput(
  container,
  payload,
  {
    frameUrl,
    hostContext,
    byteSources = {},
    timeoutMs = 20000,
    scheduler,
    onState = () => {},
    onUnhandledData = () => {},
  } = {},
) {
  if (!frameUrl) throw Error("An output frame URL is required.");
  payload = preparePayload(payload);
  const module = payload.kind === "module";
  const names = Object.keys(byteSources);
  if (
    names.length > MAX_DATA_NAMES ||
    names.some((name) => !DATA_NAME.test(name)) ||
    (names.length && !module)
  )
    throw Error("A module view may bind up to 16 data/ file imports.");
  for (const value of Object.values(byteSources)) checkDataInput(value, true);
  // The names setData accepts: what the frame can also check from its mount.
  const dataNames = new Set(module ? names : bufferNames(payload.spec));
  let context = normalizeHostContext(hostContext);
  const doc = container.ownerDocument;
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
  // One read budget for the view, shared by all of its ranged files,
  // including those a data change exposes. Created at mount.
  let budget;
  // Data changes not yet sent (see dataTransition), and the lifetime of each
  // name's exposed ranged file.
  let pending = [];
  // Names whose sent data message the frame may still answer as unhandled
  // (see answerTransition).
  let awaiting = [];
  const inputLifetimes = new Map();
  // Ends `name`'s previous input and describes `value` for the frame: a
  // dedicated copy of whole bytes, or a new port onto a ranged file.
  const describe = (name, value) => {
    inputLifetimes.get(name)?.abort();
    inputLifetimes.delete(name);
    if (value instanceof Uint8Array) {
      const bytes = new Uint8Array(value);
      return [{ bytes }, [bytes.buffer]];
    }
    const own = new AbortController();
    inputLifetimes.set(name, own);
    const file = exposeByteSource(value, AbortSignal.any([lifetime.signal, own.signal]), budget);
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
    if (state === "failed" || state === "disposed") {
      lifetime.abort();
      subscriptions.unsubscribe();
      channel.port1.close();
      channel.port2.close();
      frame.remove();
    }
  };
  subscriptions.add(
    fromEvent(frame, "load").subscribe(() => {
      if (state !== "connecting") {
        step("fail", "The output navigated away. Run it again to reconnect.");
        return;
      }
      // The receiver has an opaque origin; targetOrigin cannot be a domain.
      // Transfer to this exact WindowProxy, with a mount-specific handshake.
      step("connect");
      try {
        frame.contentWindow.postMessage({ type: "nteract-output-connect-v2", nonce }, "*", [
          channel.port2,
        ]);
      } catch (error) {
        step("fail", error.message);
      }
    }),
  );
  subscriptions.add(
    fromEvent(channel.port1, "message").subscribe(({ data }) => {
      if (!data || typeof data !== "object") return;
      if (data.type === "connected" && state === "handshaking") {
        step("connected");
        const transfers = [
          ...Object.values(payload.assets),
          ...Object.values(payload.imports ?? {}),
        ].map((asset) => asset.bytes.buffer);
        try {
          step("mount");
          budget = createReadBudget({ lifetime: lifetime.signal, scheduler });
          const files = {};
          for (const [name, value] of Object.entries(byteSources)) {
            const [input, transfer] = describe(name, value);
            files[name] = input;
            transfers.push(...transfer);
          }
          channel.port1.postMessage({ type: "mount", payload, context, files }, [
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
      if (state !== "ready") step("fail", "The output took too long to start.");
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
      if (!["connecting", "handshaking"].includes(state))
        channel.port1.postMessage({ type: "context", context });
    },
    // A new value for a data name the mount declared: a data/ name of a
    // module view (Uint8Array or ByteSource) or a buffer of an anywidget view
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
