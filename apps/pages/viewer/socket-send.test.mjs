import test from "node:test";
import assert from "node:assert/strict";
import { SOCKET_STATE, guardSocketSend, sendDecision } from "./socket-send.mjs";

test("a send leaves only while the socket is OPEN", () => {
  assert.deepEqual(
    Object.entries(SOCKET_STATE).map(([name, state]) => [name, sendDecision(state)]),
    [
      ["CONNECTING", "refuse"],
      ["OPEN", "send"],
      ["CLOSING", "drop"],
      ["CLOSED", "drop"],
    ],
  );
  assert.equal(sendDecision(undefined), "refuse");
});

function fakeSocket() {
  const sent = [];
  return {
    sent,
    readyState: SOCKET_STATE.CONNECTING,
    send(data) {
      // The browser throws while CONNECTING and logs for CLOSING or CLOSED.
      if (this.readyState === SOCKET_STATE.CONNECTING)
        throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
      if (this.readyState !== SOCKET_STATE.OPEN)
        throw new Error("WebSocket is already in CLOSING or CLOSED state.");
      sent.push(data);
    },
  };
}

test("the guarded socket follows the browser's state through a whole lifecycle", () => {
  const socket = guardSocketSend(fakeSocket());
  assert.throws(() => socket.send(Uint8Array.of(0)), { name: "InvalidStateError" });
  socket.readyState = SOCKET_STATE.OPEN;
  socket.send(Uint8Array.of(1));
  socket.readyState = SOCKET_STATE.CLOSING;
  socket.send(Uint8Array.of(2));
  socket.readyState = SOCKET_STATE.CLOSED;
  socket.send(Uint8Array.of(3));
  assert.deepEqual(socket.sent, [Uint8Array.of(1)]);
});
