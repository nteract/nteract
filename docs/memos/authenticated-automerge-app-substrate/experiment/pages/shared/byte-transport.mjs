// Byte transport only. Subduction owns the authenticated handshake and protocol.
export class WebSocketByteTransport {
  #queue = [];
  #waiters = [];
  #callbacks = new Set();
  #bytes = 0;
  #closed = false;

  constructor(socket, { maxQueuedBytes = 8 * 1024 * 1024, maxFrameBytes = 4 * 1024 * 1024 } = {}) {
    this.socket = socket;
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
    if (
      bytes.byteLength > this.maxFrameBytes ||
      (this.socket.bufferedAmount ?? 0) > this.maxQueuedBytes
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

  async disconnect() {
    this.#finish();
    try {
      this.socket.close(1000, "Disconnected");
    } catch {
      /* Already closed. */
    }
  }
}
