import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FrameType } from "runtimed";

import {
  RawWebSocketClient,
  clientForSocket,
  decodeFrame,
  fingerprintPrincipal,
  safeWebSocketUrl,
} from "../scripts/raw-websocket-client.mjs";

describe("raw WebSocket client helpers", () => {
  it("redacts token-shaped query values without skipping later parameters", () => {
    const url = new URL(
      "wss://cloud.test/n/demo/sync?token=eyJowner&session=eyJsession&plain=ok&dev_token=secret",
    );

    const safe = safeWebSocketUrl(url);

    assert.equal(
      safe,
      "wss://cloud.test/n/demo/sync?token=%3Credacted%3E&session=%3Credacted%3E&plain=ok&dev_token=%3Credacted%3E",
    );
    assert.doesNotMatch(safe, /eyJowner|eyJsession|secret/);
  });

  it("turns async decode failures into socket-local client errors", async () => {
    const socket = new FakeBrowserSocket();
    const client = await clientForSocket(socket, "wss://cloud.test/n/demo/sync");
    const nextFrame = client.nextFrame(() => true, 250);

    socket.dispatch("message", { data: new Uint8Array() });

    await assert.rejects(nextFrame, /empty WebSocket message/);
    assert.equal(socket.closed, true);
  });

  it("reassembles fragmented binary server frames before dispatching a message", () => {
    const socket = new FakeNetSocket();
    const client = new RawWebSocketClient(socket);
    const received = [];
    client.addEventListener("message", (event) => {
      received.push(event.data);
    });

    socket.emit(
      "data",
      Buffer.concat([
        serverFrame({
          fin: false,
          opcode: 0x2,
          payload: Buffer.from([FrameType.AUTOMERGE_SYNC, 1]),
        }),
        serverFrame({ fin: true, opcode: 0x0, payload: Buffer.from([2, 3]) }),
      ]),
    );

    assert.equal(received.length, 1);
    assert.deepEqual(Array.from(received[0]), [FrameType.AUTOMERGE_SYNC, 1, 2, 3]);
  });

  it("decodes session control JSON and fingerprints principals without leaking raw ids", async () => {
    const payload = new TextEncoder().encode(JSON.stringify({ type: "cloud_room_ready" }));
    const bytes = new Uint8Array(payload.byteLength + 1);
    bytes[0] = FrameType.SESSION_CONTROL;
    bytes.set(payload, 1);

    const frame = await decodeFrame(bytes);

    assert.equal(frame.json.type, "cloud_room_ready");
    assert.equal(fingerprintPrincipal("user:anaconda:alice").length, 16);
  });
});

class FakeBrowserSocket {
  constructor() {
    this.readyState = RawWebSocketClient.OPEN;
    this.closed = false;
    this.listeners = new Map();
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once: Boolean(options.once) });
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
    this.readyState = RawWebSocketClient.CLOSED;
  }

  dispatch(type, event) {
    const listeners = this.listeners.get(type) ?? [];
    const remaining = [];
    for (const entry of listeners) {
      entry.listener(event);
      if (!entry.once) {
        remaining.push(entry);
      }
    }
    this.listeners.set(type, remaining);
  }
}

class FakeNetSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.ended = false;
  }

  write(data) {
    this.writes.push(Buffer.from(data));
  }

  end() {
    this.ended = true;
    this.emit("close");
  }
}

function serverFrame({ fin, opcode, payload }) {
  const length = payload.length;
  let headerLength = 2;
  if (length >= 126 && length <= 0xffff) {
    headerLength += 2;
  } else if (length > 0xffff) {
    headerLength += 8;
  }

  const frame = Buffer.alloc(headerLength + length);
  frame[0] = (fin ? 0x80 : 0x00) | opcode;
  if (length < 126) {
    frame[1] = length;
  } else if (length <= 0xffff) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  payload.copy(frame, headerLength);
  return frame;
}
