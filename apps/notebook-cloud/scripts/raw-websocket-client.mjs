import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import { FrameType } from "runtimed";

export async function clientForSocket(socket, safeUrl) {
  const queue = [];
  const waiters = [];
  let fatalError = null;
  const failWaiters = (error) => {
    fatalError = error;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  socket.addEventListener("message", async (event) => {
    try {
      const frame = await decodeFrame(event.data);
      const index = waiters.findIndex((waiter) => waiter.predicate(frame));
      if (index === -1) {
        queue.push(frame);
        return;
      }

      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } catch (error) {
      failWaiters(error);
      socket.close();
    }
  });
  socket.addEventListener("error", (event) => {
    failWaiters(event.error ?? new Error(`WebSocket error from ${safeUrl}`));
  });

  if (socket.readyState !== RawWebSocketClient.OPEN) {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`failed to connect ${safeUrl}`)), {
        once: true,
      });
    });
  }

  return {
    socket,
    nextFrame(predicate, timeoutMs = 5_000) {
      if (fatalError) {
        return Promise.reject(fatalError);
      }
      const queued = queue.findIndex(predicate);
      if (queued !== -1) {
        const [frame] = queue.splice(queued, 1);
        return Promise.resolve(frame);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index !== -1) {
            waiters.splice(index, 1);
          }
          reject(new Error(`timed out waiting for frame from ${safeUrl}`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

export function sendBinaryFrame(socket, type, payload) {
  const frame = new Uint8Array(payload.byteLength + 1);
  frame[0] = type;
  frame.set(payload, 1);
  socket.send(frame);
}

export async function decodeFrame(data) {
  let buffer;
  if (data instanceof ArrayBuffer) {
    buffer = data;
  } else if (ArrayBuffer.isView(data)) {
    buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } else if (typeof Blob !== "undefined" && data instanceof Blob) {
    buffer = await data.arrayBuffer();
  } else {
    throw new Error(`unsupported WebSocket message ${Object.prototype.toString.call(data)}`);
  }

  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength === 0) {
    throw new Error("empty WebSocket message");
  }
  const type = bytes[0];
  const payload = bytes.slice(1);
  let json;
  if (type === FrameType.SESSION_CONTROL) {
    try {
      json = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      json = undefined;
    }
  }
  return { type, payload, bytes, json };
}

export async function closeClient(client) {
  if (client.socket.readyState === RawWebSocketClient.CLOSED) {
    return;
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 250);
    client.socket.addEventListener(
      "close",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    client.socket.close();
  });
}

export function safeWebSocketUrl(url) {
  const safe = new URL(url.href);
  for (const [key, value] of Array.from(safe.searchParams.entries())) {
    if (key.toLowerCase().includes("token") || value.startsWith("eyJ")) {
      safe.searchParams.set(key, "<redacted>");
    }
  }
  return safe.href;
}

export async function openWebSocket(
  url,
  { origin, protocols = [], headers: extraHeaders = {} } = {},
) {
  const target = new URL(url);
  const key = randomBytes(16).toString("base64");
  const socket = await openTcpSocket(target);
  const requestHeaders = webSocketUpgradeRequestHeaders(target, {
    key,
    origin,
    protocols,
    headers: extraHeaders,
  });
  socket.write(`${requestHeaders.join("\r\n")}\r\n\r\n`);

  const { headers: responseHeaders, leftover } = await readUpgradeResponse(socket);
  const expectedAccept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  assert(
    responseHeaders.statusCode === 101,
    `WebSocket upgrade failed with HTTP ${responseHeaders.statusCode}: ${responseHeaders.bodyPreview}`,
  );
  assert(
    responseHeaders.fields.get("sec-websocket-accept") === expectedAccept,
    "WebSocket upgrade returned an invalid Sec-WebSocket-Accept header",
  );

  return new RawWebSocketClient(socket, leftover);
}

export class RawWebSocketClient {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(socket, initialBuffer) {
    this.socket = socket;
    this.readyState = RawWebSocketClient.OPEN;
    this.listeners = new Map();
    this.buffer = initialBuffer ?? Buffer.alloc(0);
    this.fragmentedMessage = null;
    this.socket.on("data", (chunk) => this.receive(chunk));
    this.socket.on("close", () => {
      this.readyState = RawWebSocketClient.CLOSED;
      this.dispatch("close", {});
    });
    this.socket.on("error", (error) => this.dispatch("error", { error }));
    if (this.buffer.length > 0) {
      this.receive(Buffer.alloc(0));
    }
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: Boolean(options.once) });
    this.listeners.set(type, listeners);
  }

  dispatch(type, event) {
    const listeners = this.listeners.get(type);
    if (!listeners) {
      return;
    }
    const remaining = [];
    for (const entry of listeners) {
      entry.listener(event);
      if (!entry.once) {
        remaining.push(entry);
      }
    }
    this.listeners.set(type, remaining);
  }

  send(data) {
    assert(this.readyState === RawWebSocketClient.OPEN, "cannot send on a closed WebSocket");
    this.socket.write(encodeClientFrame(0x2, Buffer.from(data)));
  }

  close() {
    if (this.readyState !== RawWebSocketClient.OPEN) {
      return;
    }
    this.readyState = RawWebSocketClient.CLOSING;
    this.socket.write(encodeClientFrame(0x8, Buffer.alloc(0)));
    this.socket.end();
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        const longLength = this.buffer.readBigUInt64BE(offset);
        assert(longLength <= BigInt(Number.MAX_SAFE_INTEGER), "WebSocket frame is too large");
        length = Number(longLength);
        offset += 8;
      }

      const maskOffset = offset;
      if (masked) {
        offset += 4;
      }
      if (this.buffer.length < offset + length) {
        return;
      }

      let payload = this.buffer.slice(offset, offset + length);
      if (masked) {
        const mask = this.buffer.slice(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.slice(offset + length);

      if (opcode === 0x8) {
        this.readyState = RawWebSocketClient.CLOSED;
        this.socket.end();
        this.dispatch("close", {});
      } else if (opcode === 0x9) {
        assert(fin, "fragmented WebSocket ping is invalid");
        this.socket.write(encodeClientFrame(0x0a, payload));
      } else if (opcode === 0x0) {
        assert(this.fragmentedMessage, "unexpected WebSocket continuation frame");
        this.fragmentedMessage.chunks.push(payload);
        if (fin) {
          const message = this.fragmentedMessage;
          this.fragmentedMessage = null;
          this.dispatchMessage(message.opcode, Buffer.concat(message.chunks));
        }
      } else if (opcode === 0x2 || opcode === 0x1) {
        assert(!this.fragmentedMessage, "new WebSocket message started before continuation ended");
        if (fin) {
          this.dispatchMessage(opcode, payload);
        } else {
          this.fragmentedMessage = { opcode, chunks: [payload] };
        }
      }
    }
  }

  dispatchMessage(opcode, payload) {
    if (opcode === 0x2) {
      this.dispatch("message", { data: new Uint8Array(payload) });
    } else if (opcode === 0x1) {
      this.dispatch("message", { data: payload.toString("utf8") });
    }
  }
}

export function fingerprintPrincipal(principal) {
  return createHash("sha256").update(principal).digest("hex").slice(0, 16);
}

export function webSocketUpgradeRequestHeaders(
  target,
  { key, origin, protocols = [], headers = {} } = {},
) {
  const requestHeaders = [
    `GET ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
  ];
  if (origin) {
    requestHeaders.push(`Origin: ${origin}`);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      requestHeaders.push(`${name}: ${value}`);
    }
  }
  if (protocols.length > 0) {
    requestHeaders.push(`Sec-WebSocket-Protocol: ${protocols.join(", ")}`);
  }
  return requestHeaders;
}

function openTcpSocket(url) {
  const isTls = url.protocol === "wss:";
  const port = Number(url.port || (isTls ? 443 : 80));
  const options = { host: url.hostname, port };
  return new Promise((resolve, reject) => {
    const socket = isTls
      ? tls.connect({ ...options, servername: url.hostname })
      : net.connect(options);
    socket.once(isTls ? "secureConnect" : "connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readUpgradeResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      socket.off("data", onData);
      socket.off("error", reject);
      const rawHeader = buffer.slice(0, headerEnd).toString("latin1");
      const leftover = buffer.slice(headerEnd + 4);
      const lines = rawHeader.split("\r\n");
      const statusCode = Number(lines[0]?.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] ?? 0);
      const fields = new Map();
      for (const line of lines.slice(1)) {
        const delimiter = line.indexOf(":");
        if (delimiter === -1) {
          continue;
        }
        fields.set(line.slice(0, delimiter).trim().toLowerCase(), line.slice(delimiter + 1).trim());
      }
      resolve({
        headers: {
          statusCode,
          fields,
          bodyPreview: buffer.slice(headerEnd + 4, headerEnd + 260).toString("utf8"),
        },
        leftover,
      });
    };

    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function encodeClientFrame(opcode, payload) {
  const length = payload.length;
  let headerLength = 2;
  if (length >= 126 && length <= 0xffff) {
    headerLength += 2;
  } else if (length > 0xffff) {
    headerLength += 8;
  }

  const frame = Buffer.alloc(headerLength + 4 + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }

  const mask = randomBytes(4);
  mask.copy(frame, headerLength);
  for (let index = 0; index < payload.length; index += 1) {
    frame[headerLength + 4 + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
