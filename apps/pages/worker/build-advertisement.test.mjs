import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.mjs";
import { advertiseBuild } from "./build-advertisement.mjs";
import {
  BUILD_HEADER,
  MIN_VIEWER_PROTOCOL,
  MIN_VIEWER_PROTOCOL_HEADER,
  PAGES_BUILD,
} from "../shared/build-identity.mjs";

const origin = "http://localhost:9894";

test("/health advertises the build and the oldest viewer protocol it serves", async () => {
  const response = await worker.fetch(new Request(`${origin}/health`), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    prototype: "pages-celld-native",
    build: PAGES_BUILD,
    minViewerProtocol: MIN_VIEWER_PROTOCOL,
  });
  assert.equal(response.headers.get(BUILD_HEADER), PAGES_BUILD);
  assert.equal(response.headers.get(MIN_VIEWER_PROTOCOL_HEADER), String(MIN_VIEWER_PROTOCOL));
  // Unbundled source never claims a real build id.
  assert.equal(PAGES_BUILD, "dev");
});

test("API responses, including errors, carry the build headers", async () => {
  const response = await worker.fetch(new Request(`${origin}/api/nothing-here`), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
  assert.equal(response.headers.get(BUILD_HEADER), PAGES_BUILD);
  assert.equal(response.headers.get(MIN_VIEWER_PROTOCOL_HEADER), String(MIN_VIEWER_PROTOCOL));
});

test("static assets pass through untouched", async () => {
  const asset = new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  const response = await worker.fetch(new Request(`${origin}/p/some-page`), {
    ASSETS: { fetch: async () => asset },
  });
  assert.equal(response, asset);
  assert.equal(response.headers.has(BUILD_HEADER), false);
});

test("immutable responses are rebuilt with the same status, body and headers", async () => {
  const immutable = Response.redirect(`${origin}/elsewhere`, 302);
  assert.throws(() => immutable.headers.set("x-probe", "1"), TypeError);
  const stamped = advertiseBuild(new Request(`${origin}/api/auth/login`), immutable);
  assert.equal(stamped.status, 302);
  assert.equal(stamped.headers.get("location"), `${origin}/elsewhere`);
  assert.equal(stamped.headers.get(BUILD_HEADER), PAGES_BUILD);
});

test("WebSocket upgrades are returned as-is", () => {
  const upgrade = { status: 101, webSocket: {} };
  assert.equal(advertiseBuild(new Request(`${origin}/api/sync?page=x`), upgrade), upgrade);
});
