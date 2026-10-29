// Byte transport only. Subduction owns the authenticated handshake and protocol.
// Native cold sync sends a whole signed record batch. Keep room above the
// 16 MiB history budget while staying within Cloudflare's message ceiling.
export const MAX_WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;

export class WebSocketByteTransport {
  #queue = [];
  #waiters = [];
  #callbacks = new Set();
  #bytes = 0;
  #closed = false;

  constructor(
    socket,
    {
      maxQueuedBytes = MAX_WEBSOCKET_MESSAGE_BYTES,
      maxFrameBytes = MAX_WEBSOCKET_MESSAGE_BYTES,
    } = {},
  ) {
    for (const [name, limit] of Object.entries({ maxQueuedBytes, maxFrameBytes })) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_WEBSOCKET_MESSAGE_BYTES) {
        throw new RangeError(`${name} must be an integer between 1 byte and 32 MiB`);
      }
    }
    this.socket = socket;
    // Newer workerd follows the WebSocket Blob default. Native Subduction
    // expects byte frames; request ArrayBuffer delivery before receiving any.
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", ({ data }) => {
      if (this.#closed) return;
      if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
        void this.disconnect();
        return;
      }
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (
        bytes.byteLength > maxFrameBytes ||
        this.#bytes + bytes.byteLength > maxQueuedBytes ||
        this.#queue.length >= 256
      ) {
        void this.disconnect();
        return;
      }
      const copy = bytes.slice();
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(copy);
      else {
        this.#queue.push(copy);
        this.#bytes += copy.byteLength;
      }
    });
    socket.addEventListener("close", () => this.#finish());
    socket.addEventListener("error", () => this.#finish());
    this.maxFrameBytes = maxFrameBytes;
    this.maxQueuedBytes = maxQueuedBytes;
  }

  async sendBytes(bytes) {
    if (this.#closed) throw new Error("WebSocket closed");
    // Browser sockets expose pending outgoing bytes. celld/workerd sockets may
    // not; their runtime owns that queue. The individual frame bound still
    // applies, but this is not a bound on native/WASM or total process memory.
    const buffered = this.socket.bufferedAmount ?? 0;
    if (
      bytes.byteLength > this.maxFrameBytes ||
      !Number.isSafeInteger(buffered) ||
      buffered < 0 ||
      bytes.byteLength > this.maxQueuedBytes - buffered
    ) {
      await this.disconnect();
      throw new Error("WebSocket buffer limit exceeded");
    }
    this.socket.send(bytes);
  }

  async recvBytes() {
    if (this.#closed) throw new Error("WebSocket closed");
    const bytes = this.#queue.shift();
    if (bytes) {
      this.#bytes -= bytes.byteLength;
      return bytes;
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  onDisconnect(callback) {
    if (this.#closed) callback();
    else this.#callbacks.add(callback);
  }

  #finish() {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    this.#bytes = 0;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error("WebSocket closed"));
    for (const callback of this.#callbacks) {
      try {
        callback();
      } catch {
        /* Cleanup must finish for every subscriber. */
      }
    }
    this.#callbacks.clear();
  }

  /** Close with 1000, or an application code (4000-4999) and a short ASCII
   * reason. Invalid values fall back to the normal close. */
  async disconnect(code, reason) {
    const application =
      Number.isInteger(code) &&
      code >= 4000 &&
      code <= 4999 &&
      typeof reason === "string" &&
      /^[a-z_]{1,64}$/.test(reason);
    this.#finish();
    try {
      if (application) this.socket.close(code, reason);
      else this.socket.close(1000, "Disconnected");
    } catch {
      /* Already closed. */
    }
  }
}
