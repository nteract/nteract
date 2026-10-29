import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketByteTransport } from "../shared/byte-transport.mjs";

test("native transport requests ArrayBuffer delivery before installing its frame listener", async () => {
  const listeners = new Map();
  const socket = {
    binaryType: "blob",
    addEventListener(name, listener) {
      if (name === "message") assert.equal(this.binaryType, "arraybuffer");
      listeners.set(name, listener);
    },
    close() {},
  };
  const wire = new WebSocketByteTransport(socket);
  const frame = new Uint8Array([1, 2, 3]);
  listeners.get("message")({
    data: socket.binaryType === "arraybuffer" ? frame.buffer : new Blob([frame]),
  });
  assert.deepEqual(await wire.recvBytes(), frame);
  await wire.disconnect();
});

class Socket {
  listeners = new Map();
  bufferedAmount = 0;
  sent = [];
  closes = 0;
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  emit(name, event = {}) {
    this.listeners.get(name)?.(event);
  }
  receive(bytes) {
    this.emit("message", { data: bytes });
  }
  send(bytes) {
    this.sent.push(bytes);
    this.bufferedAmount += bytes.byteLength;
  }
  close() {
    this.closes++;
  }
}

const MiB = 1024 * 1024;

test("default transport accepts the measured 19 MB native cold-sync response", async () => {
  const socket = new Socket();
  const wire = new WebSocketByteTransport(socket);
  const response = new Uint8Array(19_054_445);
  response[0] = 3;
  response[response.length - 1] = 9;
  await wire.sendBytes(response);
  assert.equal(socket.sent.length, 1);
  socket.receive(response);
  const received = await wire.recvBytes();
  assert.equal(received.length, response.length);
  assert.equal(received[0], 3);
  assert.equal(received.at(-1), 9);
  await wire.disconnect();
});

test("outgoing admission includes the next frame in the queued-byte budget", async () => {
  const socket = new Socket();
  socket.bufferedAmount = 5;
  const wire = new WebSocketByteTransport(socket, { maxFrameBytes: 8, maxQueuedBytes: 10 });
  const waiting = wire.recvBytes();
  const failedRead = assert.rejects(waiting, /closed/);
  let disconnected = 0;
  wire.onDisconnect(() => disconnected++);
  await assert.rejects(wire.sendBytes(new Uint8Array(6)), /buffer limit/);
  await failedRead;
  assert.equal(socket.sent.length, 0, "over-budget frame never reaches the socket");
  assert.equal(disconnected, 1);
  await assert.rejects(wire.sendBytes(new Uint8Array(1)), /closed/);
});

test("outgoing admission allows the exact budget, then rejects one more byte", async () => {
  const socket = new Socket();
  socket.bufferedAmount = 2;
  const wire = new WebSocketByteTransport(socket, { maxFrameBytes: 8, maxQueuedBytes: 10 });
  await wire.sendBytes(new Uint8Array(8));
  assert.equal(socket.bufferedAmount, 10);
  await assert.rejects(wire.sendBytes(new Uint8Array(1)), /buffer limit/);
  assert.equal(socket.sent.length, 1);
});

test("hosts without bufferedAmount still enforce the individual frame bound", async () => {
  const socket = new Socket();
  delete socket.bufferedAmount;
  socket.send = (bytes) => socket.sent.push(bytes);
  const wire = new WebSocketByteTransport(socket, { maxFrameBytes: 8, maxQueuedBytes: 10 });
  await wire.sendBytes(new Uint8Array(8));
  await assert.rejects(wire.sendBytes(new Uint8Array(9)), /buffer limit/);
  assert.equal(socket.sent.length, 1);
});

test("invalid observable socket buffer sizes fail closed", async () => {
  for (const value of [NaN, Infinity, -1]) {
    const socket = new Socket();
    socket.bufferedAmount = value;
    const wire = new WebSocketByteTransport(socket);
    await assert.rejects(wire.sendBytes(new Uint8Array(1)), /buffer limit/);
    assert.equal(socket.sent.length, 0);
  }
});

test("incoming queue tracks bytes released by reads and owns queued frames", async () => {
  const socket = new Socket();
  const wire = new WebSocketByteTransport(socket, { maxFrameBytes: 8, maxQueuedBytes: 10 });
  const first = new Uint8Array(6).fill(7);
  socket.receive(first);
  first.fill(0);
  socket.receive(new Uint8Array(4));
  assert.deepEqual(await wire.recvBytes(), new Uint8Array(6).fill(7));
  socket.receive(new Uint8Array(6)); // Reading the first frame released six bytes.
  assert.equal(socket.closes, 0);
  socket.receive(new Uint8Array(1));
  assert.ok(socket.closes > 0);
  await assert.rejects(wire.recvBytes(), /closed/); // Queued data was discarded.
});

test("oversized incoming frames reject pending readers and clean up once", async () => {
  const socket = new Socket();
  const wire = new WebSocketByteTransport(socket, { maxFrameBytes: 8, maxQueuedBytes: 10 });
  const pending = [wire.recvBytes(), wire.recvBytes()].map((p) => assert.rejects(p, /closed/));
  let disconnected = 0;
  wire.onDisconnect(() => disconnected++);
  socket.receive(new Uint8Array(9));
  await Promise.all(pending);
  socket.emit("close");
  socket.emit("error");
  socket.receive(new Uint8Array(1));
  assert.equal(disconnected, 1);
  await assert.rejects(wire.recvBytes(), /closed/);
});

test("incoming message count remains bounded even for zero-length frames", async () => {
  const socket = new Socket();
  const wire = new WebSocketByteTransport(socket);
  for (let i = 0; i < 256; i++) socket.receive(new Uint8Array());
  assert.equal(socket.closes, 0);
  socket.receive(new Uint8Array());
  assert.ok(socket.closes > 0);
  await assert.rejects(wire.recvBytes(), /closed/);
});

test("configured transport bounds cannot exceed the 32 MiB platform ceiling", () => {
  for (const key of ["maxFrameBytes", "maxQueuedBytes"]) {
    for (const value of [0, -1, 1.5, NaN, Infinity, 32 * MiB + 1]) {
      assert.throws(() => new WebSocketByteTransport(new Socket(), { [key]: value }), RangeError);
    }
  }
});

test("default transport rejects messages beyond the platform ceiling in both directions", async () => {
  const oversized = new Uint8Array(32 * MiB + 1);
  const outgoingSocket = new Socket();
  const outgoing = new WebSocketByteTransport(outgoingSocket);
  await assert.rejects(outgoing.sendBytes(oversized), /buffer limit/);
  assert.equal(outgoingSocket.sent.length, 0);
  const incomingSocket = new Socket();
  const incoming = new WebSocketByteTransport(incomingSocket);
  incomingSocket.receive(oversized);
  await assert.rejects(incoming.recvBytes(), /closed/);
});
