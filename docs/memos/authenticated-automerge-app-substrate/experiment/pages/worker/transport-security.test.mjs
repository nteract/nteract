import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.mjs";
import { edgeScheme } from "./transport-security.mjs";

// The tunnel's last hop is plain HTTP, so every request URL is http: even
// when the visitor used HTTPS. Only CF-Visitor tells them apart.
const publicUrl = "http://pages.runtimed.run";
const viaEdge = (scheme) => ({ "CF-Visitor": JSON.stringify({ scheme }) });

test("a plain-HTTP edge request is redirected to HTTPS with its path and query", async () => {
  const response = await worker.fetch(
    new Request(`${publicUrl}/p/0b6c3f5e-1d2a-4c3b-8d4e-5f6a7b8c9d0e?comment=t1&x=%20y`, {
      headers: viaEdge("http"),
    }),
    {},
  );
  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "https://pages.runtimed.run/p/0b6c3f5e-1d2a-4c3b-8d4e-5f6a7b8c9d0e?comment=t1&x=%20y",
  );
  assert.equal(response.headers.has("strict-transport-security"), false);
});

test("the redirect targets the configured public origin, not a private tunnel origin", async () => {
  const response = await worker.fetch(
    new Request("http://127.0.0.1:9481/p/x?y=1", { headers: viaEdge("http") }),
    { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.runtimed.run" },
  );
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://pages.runtimed.run/p/x?y=1");

  // A path that looks protocol-relative still lands on the public host.
  const sneaky = await worker.fetch(
    new Request("http://127.0.0.1:9481//evil.example/x", { headers: viaEdge("http") }),
    { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.runtimed.run" },
  );
  assert.equal(new URL(sneaky.headers.get("location")).host, "pages.runtimed.run");
});

test("every method and path is redirected before routing, /health and /api included", async () => {
  // No ASSETS, DB or session keys: any routing past the redirect would fail.
  for (const [method, path] of [
    ["GET", "/health"],
    ["GET", "/"],
    ["POST", "/api/tools"],
    ["POST", "/mcp"],
    ["GET", "/api/auth/session"],
  ]) {
    const response = await worker.fetch(
      new Request(`${publicUrl}${path}`, {
        method,
        headers: viaEdge("http"),
        ...(method === "POST" && { body: "{}" }),
      }),
      {},
    );
    assert.equal(response.status, 308, `${method} ${path}`);
    assert.equal(response.headers.get("location"), `https://pages.runtimed.run${path}`);
  }
});

test("a WebSocket upgrade over plain HTTP gets the redirect, not a socket", async () => {
  const response = await worker.fetch(
    new Request(`${publicUrl}/api/sync?page=0b6c3f5e-1d2a-4c3b-8d4e-5f6a7b8c9d0e`, {
      headers: { ...viaEdge("http"), Upgrade: "websocket", Connection: "Upgrade" },
    }),
    {},
  );
  assert.equal(response.status, 308);
  assert.equal(response.webSocket ?? null, null);
  assert.equal(
    response.headers.get("location"),
    "https://pages.runtimed.run/api/sync?page=0b6c3f5e-1d2a-4c3b-8d4e-5f6a7b8c9d0e",
  );
});

test("an HTTPS edge request on an http: URL is served, not looped, and carries HSTS", async () => {
  // Behind the tunnel (or Always Use HTTPS) the URL scheme is http: while the
  // visitor's is https. Redirecting on the URL would loop forever.
  assert.equal(new URL(publicUrl).protocol, "http:");
  const response = await worker.fetch(
    new Request(`${publicUrl}/health`, { headers: viaEdge("https") }),
    {},
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
});

test("HSTS reaches immutable asset responses on HTTPS edge requests", async () => {
  const asset = Response.redirect("https://pages.runtimed.run/elsewhere", 302);
  const response = await worker.fetch(
    new Request(`${publicUrl}/p/some-page`, { headers: viaEdge("https") }),
    { ASSETS: { fetch: async () => asset } },
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://pages.runtimed.run/elsewhere");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
});

/** A null-body-status response as an ASSETS binding can return it: a non-null
 * empty stream body, and headers that refuse writes. Node's constructor won't
 * build that, so a real response is given both. */
function assetStyle(status) {
  const response = new Response(null, { status, headers: { etag: '"abc"' } });
  Object.defineProperty(response, "body", {
    value: new ReadableStream({ start: (c) => c.close() }),
  });
  response.headers.set = () => {
    throw new TypeError("Can't modify immutable headers.");
  };
  return response;
}

for (const status of [304, 204]) {
  test(`HSTS reaches an immutable ${status} asset response with an empty stream body`, async () => {
    const response = await worker.fetch(
      new Request(`${publicUrl}/p/some-page`, { headers: viaEdge("https") }),
      { ASSETS: { fetch: async () => assetStyle(status) } },
    );
    assert.equal(response.status, status);
    assert.equal(response.headers.get("etag"), '"abc"');
    assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  });
}

test("HSTS is set in place on a mutable response", async () => {
  const mutable = new Response("ok");
  const response = await worker.fetch(
    new Request(`${publicUrl}/p/some-page`, { headers: viaEdge("https") }),
    { ASSETS: { fetch: async () => mutable } },
  );
  assert.equal(response, mutable);
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
});

test("a request without Cloudflare headers is served as before", async () => {
  // The operator's on-host call: Host is the public name, no CF-Visitor.
  const health = await worker.fetch(new Request("http://pages.runtimed.run/health"), {});
  assert.equal(health.status, 200);
  assert.equal(health.headers.has("strict-transport-security"), false);
  assert.equal(health.headers.has("location"), false);

  // Local dev: assets are passed through by identity.
  const asset = new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  const page = await worker.fetch(new Request("http://localhost:9894/p/some-page"), {
    ASSETS: { fetch: async () => asset },
  });
  assert.equal(page, asset);
});

test("X-Forwarded-Proto alone neither redirects nor pins", async () => {
  const response = await worker.fetch(
    new Request(`${publicUrl}/health`, { headers: { "X-Forwarded-Proto": "http" } }),
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.has("strict-transport-security"), false);
});

test("CF-Visitor is parsed defensively", () => {
  const scheme = (value) =>
    edgeScheme(
      new Request(publicUrl, value === undefined ? {} : { headers: { "CF-Visitor": value } }),
    );
  assert.equal(scheme(undefined), null);
  assert.equal(scheme('{"scheme":"http"}'), "http");
  assert.equal(scheme('{ "scheme" : "HTTPS" }'), "https");
  assert.equal(scheme("http"), null);
  assert.equal(scheme("{not json"), null);
  assert.equal(scheme("null"), null);
  assert.equal(scheme('["http"]'), null);
  assert.equal(scheme('{"scheme":1}'), null);
  assert.equal(scheme('{"scheme":"ws"}'), null);
  assert.equal(scheme(`{"scheme":"http","pad":"${"x".repeat(300)}"}`), null);
});
