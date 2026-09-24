import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualTimeScheduler } from "rxjs";
import { notebookHomeEvents, notebookHomeEventsUrl } from "../viewer/notebook-home-events";
import { NOTEBOOK_HOME_PING, NOTEBOOK_HOME_PONG } from "../src/notebook-home-protocol";

class Socket extends EventTarget {
  sent: string[] = [];
  closed = false;
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.closed = true;
  }
  message(value: string) {
    this.dispatchEvent(new MessageEvent("message", { data: value }));
  }
}

test("ready, change, and reconnect invalidate; heartbeat does not refresh the catalog", () => {
  const scheduler = new VirtualTimeScheduler();
  const sockets: Socket[] = [];
  let refreshes = 0;
  const subscription = notebookHomeEvents(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  }, scheduler).subscribe(() => refreshes++);
  sockets[0]!.message('{"event":"ready"}');
  sockets[0]!.message('{"event":"changed"}');
  assert.equal(refreshes, 2);
  scheduler.maxFrames = 25_000;
  scheduler.flush();
  assert.deepEqual(sockets[0]!.sent, [NOTEBOOK_HOME_PING]);
  sockets[0]!.message(NOTEBOOK_HOME_PONG);
  assert.equal(refreshes, 2);
  sockets[0]!.dispatchEvent(new Event("close"));
  scheduler.maxFrames = 26_000;
  scheduler.flush();
  assert.equal(sockets.length, 2);
  sockets[1]!.message('{"event":"ready"}');
  assert.equal(refreshes, 3);
  subscription.unsubscribe();
  assert.ok(sockets.every((socket) => socket.closed));
});

test("missing ready or heartbeat responses force reconnect; teardown cancels retries", () => {
  const scheduler = new VirtualTimeScheduler();
  const sockets: Socket[] = [];
  const subscription = notebookHomeEvents(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  }, scheduler).subscribe();
  scheduler.maxFrames = 16_000;
  scheduler.flush();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0]!.closed, true);
  sockets[1]!.message('{"event":"ready"}');
  scheduler.maxFrames = 52_000;
  scheduler.flush();
  assert.equal(sockets.length, 3);
  subscription.unsubscribe();
  scheduler.maxFrames = 100_000;
  scheduler.flush();
  assert.equal(sockets.length, 3);
});

test("cookie sessions suppress bearer credentials and tokens never enter the URL", () => {
  const auth = {
    mode: "dev" as const,
    token: "secret",
    user: "alice",
    oidcClaims: null,
    requestedScope: "viewer" as const,
    problem: null,
  };
  const explicit = notebookHomeEventsUrl(
    "https://cloud.test/api/notebook-home/events",
    auth,
    false,
  );
  assert.equal(new URL(explicit.url).searchParams.get("user"), "alice");
  assert.ok(!explicit.url.includes("secret"));
  assert.equal(explicit.protocols.length, 2);
  const cookie = notebookHomeEventsUrl("https://cloud.test/api/notebook-home/events", auth, true);
  assert.equal(cookie.protocols.length, 1);
  assert.equal(new URL(cookie.url).searchParams.get("user"), null);
});
