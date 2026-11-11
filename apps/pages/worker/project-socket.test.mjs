import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILD_FORMATS } from "../model/document-types.mjs";
import { BUILD_FEATURES } from "../model/schema-features.mjs";
import { Page } from "./index.mjs";
import { Storage, world } from "./projects-fixture.mjs";

const drain = async () => {
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
};

// Only the runtime WebSocket upgrade is emulated. Plain sync, policy,
// Project owner and Catalog placement are real.
function sockets(t) {
  class Socket extends EventTarget {
    accept() {}
    send(bytes) {
      if (this.closed) throw new Error("Closed");
      this.other.dispatchEvent(Object.assign(new Event("message"), { data: bytes.slice() }));
    }
    close(code, reason) {
      if (this.closed) return;
      for (const socket of [this, this.other]) socket.closed = { code, reason };
      for (const socket of [this, this.other]) socket.dispatchEvent(new Event("close"));
    }
  }
  const ResponseBase = globalThis.Response;
  for (const [name, value] of Object.entries({
    WebSocketPair: class {
      constructor() {
        this[0] = new Socket();
        this[1] = new Socket();
        this[0].other = this[1];
        this[1].other = this[0];
      }
    },
    Response: class extends ResponseBase {
      constructor(body, options) {
        if (options?.status !== 101) return new ResponseBase(body, options);
        super(null);
        Object.defineProperty(this, "status", { value: 101 });
        this.webSocket = options.webSocket;
      }
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() =>
      previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name],
    );
  }
}

test(
  "accepted Project sockets expire, reconnect, and fail closed after owner revocation",
  { timeout: 15000 },
  async (t) => {
    const w = await world(t);
    t.mock.method(console, "info", () => {});
    const project = await w.createProject("Socket lease");
    const child = (await w.createPage({ title: "Child", project_id: project.project_id })).body;
    const change = (role, expected_revision) =>
      w.call("owner", "manage_project_access", {
        project_id: project.project_id,
        action: "set_role",
        principal: w.member,
        role,
        expected_revision,
        nonce: w.key(),
      });
    assert.equal((await change("editor", 0)).status, 200);
    const env = w.env;
    const host = new Page(
      {
        id: { name: child.page_id },
        storage: new Storage(),
        blockConcurrencyWhile: (fn) => fn(),
        waitUntil() {},
      },
      env,
    );
    t.after(async () => {
      for (const wire of host.wires) await wire.disconnect();
      host.contentActivity?.stop();
      await host.plain?.close();
    });
    const created = await host.fetch(
      new Request("https://pages.invalid/internal/create", {
        method: "POST",
        headers: { authorization: `Bearer ${w.auth.apiKey()}` },
        body: JSON.stringify({
          page_id: child.page_id,
          title: "Child",
          markdown: "Accepted content",
        }),
      }),
    );
    assert.equal(created.status, 201, await created.clone().text());
    const token = w.auth.apiKey({ userId: "member-user" });
    const request = () =>
      new Request(
        `https://pages.invalid/api/sync?sync=automerge&formats=${BUILD_FORMATS}&schema_features=${BUILD_FEATURES.join(",")}`,
        {
          headers: { authorization: `Bearer ${token}`, upgrade: "websocket" },
        },
      );
    sockets(t);
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
    const open = async () => {
      const req = request();
      const identity = await host.identify(req);
      const response = host.connect(req, identity);
      assert.equal(response.status, 101);
      await drain();
      assert.equal(response.webSocket.closed, undefined);
      assert.equal(host.wires.size, 1);
      return { socket: response.webSocket, identity };
    };
    const first = await open();
    t.mock.timers.tick(14999);
    await drain();
    assert.equal(first.socket.closed, undefined);
    t.mock.timers.tick(1);
    await drain();
    assert.deepEqual(first.socket.closed, { code: 4503, reason: "project_lease_expired" });
    const second = await open();
    assert.ok(second.identity.expiresAt > Date.now() + 15000);
    assert.equal((await change(null, 1)).status, 200);
    t.mock.timers.tick(15000);
    await drain();
    assert.ok(second.socket.closed, "revocation closes within the inherited lease bound");
    const identity = await host.identify(request());
    assert.equal(host.projectAccess.revision, 2);
    assert.throws(() => host.policy.account(identity));
    assert.equal(host.wires.size, 0);
  },
);
