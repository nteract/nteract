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
