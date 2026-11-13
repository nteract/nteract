import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.mjs";
import { CHART_WORKER_CSP } from "../shared/chart-worker-csp.mjs";

const origin = "https://pages.example";
const serve = (path, asset) =>
  worker.fetch(new Request(`${origin}${path}`), { ASSETS: { fetch: async () => asset } });

test("every /chunks/ script carries the chart Worker's CSP, whatever the asset layer sent", async () => {
  const asset = new Response("self.postMessage(1)", {
    headers: {
      "content-type": "text/javascript",
      "content-security-policy": "default-src 'self'",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
  const response = await serve("/chunks/ABCD2345.js", asset);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"), CHART_WORKER_CSP);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await response.text(), "self.postMessage(1)");
});

test("an asset binding's immutable response is copied to carry the header", async () => {
  const immutable = Response.redirect(`${origin}/elsewhere`, 302);
  assert.throws(() => immutable.headers.set("x-probe", "1"), TypeError);
  const response = await serve("/chunks/ABCD2345.js", immutable);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("content-security-policy"), CHART_WORKER_CSP);
});

test("other assets pass through untouched", async () => {
  for (const path of ["/app.js", "/chunks/abcd2345.js", "/chunks/ABCD2345.css", "/p/some-page"]) {
    const asset = new Response("x");
    assert.equal(await serve(path, asset), asset, path);
  }
});
