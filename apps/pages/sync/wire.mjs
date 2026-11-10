import { cbor } from "@automerge/automerge-repo";

// Frames between a browser and the Page host, CBOR in binary WebSocket frames.
//
// browser -> host  { t: "sync", doc, m, r }    m: Automerge sync message or null
//                  { t: "eph",  doc, e }       e: ephemeral envelope
// host -> browser  { t: "sync", doc, m, r?, heads, has }
//                     r echoes the frame it answers; absent on fan-out.
//                     heads are the host's after its last durable commit.
//                  { t: "refused", doc, r?, code, message, fatal }
//                  { t: "eph",  doc, e, sender }  sender is stamped by the host
//
// Documents are named by their sedimentree id: 64 hex digits, or 32 for a
// short (16-byte) Automerge document id. The host answers a frame
// only after any change it carried is durable, so a reply is the ack.

export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const DOC = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;

export const encodeFrame = (frame) => new Uint8Array(cbor.encode(frame));

const bytes = (value) =>
  value instanceof Uint8Array
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : null;

/** Decode and check a frame. Returns null for anything malformed. */
export function decodeFrame(data) {
  let frame;
  try {
    frame = cbor.decode(data);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== "object" || typeof frame.doc !== "string" || !DOC.test(frame.doc))
    return null;
  if (frame.r !== undefined && !Number.isSafeInteger(frame.r)) return null;
  if (frame.t === "sync") {
    const m = frame.m === null || frame.m === undefined ? null : bytes(frame.m);
    if (frame.m && !m) return null;
    const heads = Array.isArray(frame.heads)
      ? frame.heads.filter((h) => typeof h === "string")
      : undefined;
    return { t: "sync", doc: frame.doc, m, r: frame.r, heads, has: frame.has };
  }
  if (frame.t === "eph") {
    const e = frame.e;
    const payload = bytes(e?.payload);
    if (!payload || typeof e.messageId !== "string" || typeof e.origin?.id !== "string")
      return null;
    const origin = { kind: String(e.origin.kind ?? ""), id: e.origin.id };
    const sender =
      frame.sender && typeof frame.sender.id === "string"
        ? { kind: String(frame.sender.kind ?? ""), id: frame.sender.id }
        : undefined;
    return {
      t: "eph",
      doc: frame.doc,
      e: { messageId: e.messageId, origin, payload },
      sender,
    };
  }
  if (frame.t === "refused") {
    return {
      t: "refused",
      doc: frame.doc,
      r: frame.r,
      code: String(frame.code ?? ""),
      message: String(frame.message ?? ""),
      fatal: frame.fatal === true,
    };
  }
  return null;
}

/**
 * Frame transport over a WebSocket (browser, workerd or celld). Malformed or
 * oversized input closes the socket with 4400 `request_rejected`.
 */
export function socketTransport(
  socket,
  { maxFrameBytes = MAX_FRAME_BYTES, onRejected = () => {} } = {},
) {
  const messages = new Set();
  const closes = new Set();
  let closed = false;
  socket.binaryType = "arraybuffer";
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const h of closes) h();
  };
  const transport = {
    get closed() {
      return closed;
    },
    send(frame) {
      if (closed) return;
      try {
        socket.send(encodeFrame(frame));
      } catch {
        finish();
      }
    },
    onMessage(handler) {
      messages.add(handler);
    },
    onClose(handler) {
      if (closed) handler();
      else closes.add(handler);
    },
    close(code = 1000, reason = "Disconnected") {
      try {
        socket.close(code, reason);
      } catch {
        /* Already closed. */
      }
      finish();
    },
  };
  socket.addEventListener("message", ({ data }) => {
    if (closed) return;
    const raw =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? bytes(data)
          : null;
    const frame = raw && raw.byteLength <= maxFrameBytes ? decodeFrame(raw) : null;
    if (!frame) {
      onRejected(
        !raw
          ? "unsupported_frame"
          : raw.byteLength > maxFrameBytes
            ? "frame_too_large"
            : "unsupported_frame",
      );
      return transport.close(4400, "request_rejected");
    }
    for (const h of messages) h(frame);
  });
  socket.addEventListener("close", finish);
  socket.addEventListener("error", finish);
  return transport;
}

/**
 * An in-process transport pair for tests and benchmarks in place of a socket.
 * Frames go through the same codec
 * and arrive asynchronously, in order. Bytes and frames are counted.
 */
export function framePipe() {
  const stats = { aToB: 0, bToA: 0, framesAToB: 0, framesBToA: 0 };
  const end = (bytesKey, framesKey) => {
    const self = {
      peer: null,
      closed: false,
      closing: false,
      messages: new Set(),
      closes: new Set(),
      send(frame) {
        if (self.closed || self.closing) return;
        const encoded = encodeFrame(frame);
        stats[bytesKey] += encoded.byteLength;
        stats[framesKey]++;
        const peer = self.peer;
        setTimeout(() => {
          if (peer.closed) return;
          const decoded = decodeFrame(encoded);
          for (const h of peer.messages) h(decoded);
        }, 0);
      },
      onMessage(handler) {
        self.messages.add(handler);
      },
      onClose(handler) {
        if (self.closed) handler();
        else self.closes.add(handler);
      },
      // Like a WebSocket close: frames already sent are still delivered.
      close(code = 1000, reason = "Disconnected") {
        if (self.closing) return;
        self.closing = self.peer.closing = true;
        self.closeCode = self.peer.closeCode = code;
        self.closeReason = self.peer.closeReason = reason;
        setTimeout(() => {
          for (const e of [self, self.peer]) {
            if (e.closed) continue;
            e.closed = true;
            for (const h of e.closes) h();
          }
        }, 0);
      },
    };
    return self;
  };
  const client = end("aToB", "framesAToB");
  const host = end("bToA", "framesBToA");
  client.peer = host;
  host.peer = client;
  return { client, host, stats };
}
