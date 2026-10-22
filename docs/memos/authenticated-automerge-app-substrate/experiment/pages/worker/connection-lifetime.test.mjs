import assert from "node:assert/strict";
import { test } from "node:test";
import * as N from "@automerge/subduction";
import { Page } from "./index.mjs";

const drain = () => new Promise(setImmediate);

function fixture(t, failure) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const events = [],
    background = [];
  let socket,
    released = false;
  class Socket extends EventTarget {
    accept() {}
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  const globals = {
    WebSocketPair: class {
      constructor() {
        this[0] = new Socket();
        this[1] = socket = new Socket();
      }
    },
    Response: class {
      constructor(_body, options) {
        Object.assign(this, options);
      }
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  const transport = {
    peerId: {
      toBytes: () => new Uint8Array(32),
      toString: () => "fixture-peer",
      free: () => events.push("peer.free"),
    },
    free: () => events.push("transport.free"),
  };
  t.mock.method(N.AuthenticatedTransport, "accept", async (wire) => {
    if (failure === "handshake-timeout") await wire.recvBytes();
    if (failure === "handshake") throw Error("Fixture handshake failed");
    return transport;
  });
  t.mock.method(console, "error", () => {});
  const page = Object.assign(Object.create(Page.prototype), {
    ctx: { waitUntil: (promise) => background.push(promise) },
    env: {},
    signer: {},
    wires: new Set(),
    policy: {
      async bind() {
        events.push("bind");
        if (failure === "binding") throw Error("Fixture binding failed");
        return () => {
          released = true;
        };
      },
      async active() {
        events.push("active");
      },
    },
    backend: {
      async addConnection() {
        events.push("admitted");
        if (failure === "backend") throw Error("Fixture backend failed");
      },
    },
    handle: { broadcast: () => events.push("broadcast") },
    profiles: () => ({}),
  });
  t.after(async () => {
    for (const wire of page.wires) await wire.disconnect();
  });
  const response = page.connect(
    new Request("http://localhost/api/sync?page=fixture", {
      headers: { upgrade: "websocket" },
    }),
    { expiresAt: 61000 },
  );
  assert.equal(response.status, 101);
  assert.equal(background.length, 1);
  return { page, events, background: background[0], socket, released: () => released };
}

test("native admission keeps its context until the socket closes, then releases it", async (t) => {
  const f = fixture(t);
  let settled = false;
  f.background.then(() => {
    settled = true;
  });
  await drain();
  assert.deepEqual(f.events, ["peer.free", "bind", "admitted", "broadcast", "transport.free"]);
  assert.equal(settled, false, "admission completing must not retire the connection context");
  assert.equal(f.page.wires.size, 1);
  t.mock.timers.tick(15001);
  await drain();
  assert.equal(f.events.filter((event) => event === "active").length, 1);
  assert.equal(settled, false);
  f.socket.close();
  await f.background;
  assert.equal(settled, true);
  assert.equal(f.page.wires.size, 0);
  assert.equal(f.released(), true);
  t.mock.timers.tick(120000);
  await drain();
  assert.equal(
    f.events.filter((event) => event === "active").length,
    1,
    "close cancels the lease timer",
  );
});

for (const failure of ["handshake", "binding", "backend", "handshake-timeout"]) {
  test(`native ${failure} failure settles admission and closes the socket`, async (t) => {
    const f = fixture(t, failure);
    if (failure === "handshake-timeout") t.mock.timers.tick(10000);
    await f.background;
    assert.equal(f.page.wires.size, 0);
    assert.equal(
      f.events.filter((event) => event === "transport.free").length,
      failure.startsWith("handshake") ? 0 : 1,
    );
    if (failure === "backend") assert.equal(f.released(), true);
    const events = [...f.events];
    t.mock.timers.tick(120000);
    await drain();
    assert.deepEqual(f.events, events, "failed admission leaves no lease timer running");
  });
}
