import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudflareWebSocket, DurableObjectState } from "../src/cloudflare-types.ts";
import { NotebookHome } from "../src/notebook-home.ts";

function socket(expiresAt: number) {
  const messages: string[] = [];
  const closes: number[] = [];
  return {
    messages,
    closes,
    connection: {
      send: (message: string | ArrayBuffer | ArrayBufferView) => messages.push(String(message)),
      close: (code?: number) => closes.push(code ?? 1000),
      deserializeAttachment: () => ({ expiresAt }),
      accept: () => {},
      addEventListener: () => {},
    } as unknown as CloudflareWebSocket,
  };
}

function state(sockets: CloudflareWebSocket[], alarms: Array<number | Date>): DurableObjectState {
  return {
    id: { toString: () => "home-test" },
    waitUntil: () => {},
    getWebSockets: () => sockets,
    storage: {
      get: async () => undefined,
      put: async () => {},
      delete: async () => false,
      list: async () => new Map(),
      setAlarm: async (time) => {
        alarms.push(time);
      },
    },
  };
}

test("a reconstructed home delivers only invalidations to its hibernated connections", async () => {
  const current = socket(Date.now() + 60_000);
  const expired = socket(0);
  const home = new NotebookHome(state([current.connection, expired.connection], []));
  const response = await home.fetch(
    new Request("https://home.internal/notify", { method: "POST" }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    current.messages.map((message) => JSON.parse(message)),
    [{ event: "changed" }],
  );
  assert.deepEqual(expired.messages, []);
  assert.deepEqual(expired.closes, [1000]);
});

test("the lease alarm closes expired connections and schedules the next expiry", async () => {
  const expiry = Date.now() + 60_000;
  const current = socket(expiry);
  const expired = socket(0);
  const alarms: Array<number | Date> = [];
  const home = new NotebookHome(state([current.connection, expired.connection], alarms));
  await home.alarm();
  assert.deepEqual(current.closes, []);
  assert.deepEqual(expired.closes, [1000]);
  assert.deepEqual(alarms, [expiry]);
});

test("missing hibernation support fails explicitly instead of losing subscriptions", async () => {
  const home = new NotebookHome(state([], []));
  const response = await home.fetch(
    new Request("https://home.internal/stream", { headers: { Upgrade: "websocket" } }),
  );
  assert.equal(response.status, 503);
});
