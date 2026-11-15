import { fromEvent, Subscription, timer } from "rxjs";
import { outputTransition } from "./lifecycle.mjs";
import { preparePayload } from "./payload.mjs";
import { normalizeHostContext } from "./context.mjs";
export { readHostContext, OUTPUT_STYLE_VARIABLES } from "./context.mjs";

// One immutable mount, one port, one set of transferred inputs. No inbound
// method grants asset access, document edits, navigation or kernel calls.
export function mountAnywidgetOutput(
  container,
  payload,
  { frameUrl, hostContext, timeoutMs = 20000, scheduler, onState = () => {} } = {},
) {
  if (!frameUrl) throw Error("An output frame URL is required.");
  payload = preparePayload(payload);
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
  let state = "connecting";
  const step = (event, error) => {
    const next = outputTransition(state, event);
    if (next === state) return;
    state = next;
    if (state === "ready") frame.style.visibility = "visible";
    onState(state, error);
    if (state === "failed" || state === "disposed") {
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
        const transfers = Object.values(payload.assets).map((asset) => asset.bytes.buffer);
        try {
          step("mount");
          channel.port1.postMessage({ type: "mount", payload, context }, [...new Set(transfers)]);
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
    destroy() {
      step("dispose");
    },
  };
}
