// The Worker's view library route: /catalog/<revision>/<file> from the
// build's static assets, public and cross-origin, ahead of every session check.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.mjs";
import { libraryCatalogResponse } from "./library-catalog.mjs";

const origin = "https://pages.example";
const revision = "a".repeat(64);
const files = new Map([
  [`/catalog/${revision}/react.js`, ["export default {};", "text/javascript"]],
  [`/catalog/${revision}/style.css`, ["main{}", "text/css"]],
  [`/catalog/${revision}/sift.wasm`, [new Uint8Array([0, 97, 115, 109]), "application/wasm"]],
  [`/catalog/${revision}/manifest.json`, ['{"imports":{}}\n', "application/json"]],
]);

/** An ASSETS binding with single-page-application handling: a missing path
 * answers the HTML shell. `requests` records each path it was asked for. */
function assetsBinding() {
  const requests = [];
  return {
    requests,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      requests.push({ pathname, method: request.method, cookie: request.headers.get("cookie") });
      const file = files.get(pathname);
      if (!file)
        return new Response("<!doctype html><title>Pages</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      return new Response(file[0], {
        headers: {
          "content-type": file[1],
          etag: '"asset"',
          "content-length": String(new Blob([file[0]]).size),
        },
      });
    },
  };
}

// Any other binding the route reads, or a session it asks for, throws.
function publicEnv(ASSETS) {
  return {
    ASSETS,
    get DB() {
      throw Error("A library file must not read account storage");
    },
    get NOTEBOOK_CLOUD_APP_SESSION_SECRET() {
      throw Error("A library file must not read session keys");
    },
  };
}

const LONG_CACHE = "public, max-age=31536000, immutable";

for (const [name, type] of [
  ["react.js", "text/javascript; charset=utf-8"],
  ["style.css", "text/css; charset=utf-8"],
  ["sift.wasm", "application/wasm"],
  ["manifest.json", "application/json; charset=utf-8"],
])
  test(`a catalog ${name.split(".").at(-1)} file answers with its type and cross-origin headers`, async () => {
    const response = await libraryCatalogResponse(
      new Request(`${origin}/catalog/${revision}/${name}`),
      publicEnv(assetsBinding()),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), type);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), LONG_CACHE);
    assert.equal(response.headers.get("set-cookie"), null);
    const [body] = files.get(`/catalog/${revision}/${name}`);
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      typeof body === "string" ? new TextEncoder().encode(body) : body,
    );
  });

test("HEAD answers the same headers with no body", async () => {
  const assets = assetsBinding();
  const response = await libraryCatalogResponse(
    new Request(`${origin}/catalog/${revision}/react.js`, { method: "HEAD" }),
    publicEnv(assets),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("content-length"), "18");
  assert.equal(await response.text(), "");
  // The binding is asked with a plain GET.
  assert.deepEqual(
    assets.requests.map(({ method }) => method),
    ["GET"],
  );
});

for (const [what, path] of [
  ["a file the revision lacks", `/catalog/${revision}/missing.js`],
  ["a revision the build lacks", `/catalog/${"b".repeat(64)}/react.js`],
])
  test(`${what} is a short 404 with no long-lived caching`, async () => {
    for (const method of ["GET", "HEAD"]) {
      const response = await libraryCatalogResponse(
        new Request(origin + path, { method }),
        publicEnv(assetsBinding()),
      );
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(await response.text(), method === "GET" ? "No such library file\n" : "");
    }
  });

test("a catalog path outside the pattern is a 404 the binding never sees", async () => {
  const assets = assetsBinding();
  for (const path of [
    `/catalog/${revision}/../index.html`,
    `/catalog/${revision}/react.mjs`,
    `/catalog/${revision}/nested/react.js`,
    `/catalog/${"A".repeat(64)}/react.js`,
    "/catalog/abc/react.js",
    "/catalog/",
  ]) {
    const response = await libraryCatalogResponse(new Request(origin + path), publicEnv(assets));
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(assets.requests, []);
});

test("other paths and methods are not this route's", async () => {
  const env = {
    get ASSETS() {
      throw Error("Only a catalog path reads the asset binding");
    },
  };
  for (const request of [
    new Request(`${origin}/catalog.json`),
    new Request(`${origin}/p/page`),
    new Request(`${origin}/catalogs/${revision}/react.js`),
    new Request(`${origin}/catalog/${revision}/react.js`, { method: "POST", body: "x" }),
  ])
    assert.equal(await libraryCatalogResponse(request, env), null, request.url);
});

test("the Worker serves a library file before any session code, without cookies", async () => {
  const assets = assetsBinding();
  // No session keys are configured and every account binding throws: the
  // session check would answer 500 if it ran first.
  const response = await worker.fetch(
    new Request(`${origin}/catalog/${revision}/react.js`, {
      headers: { cookie: "__Host-pages_session=secret; other=1", origin: "null" },
    }),
    publicEnv(assets),
    { waitUntil() {} },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cache-control"), LONG_CACHE);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(await response.text(), "export default {};");
  // The asset binding never sees the reader's cookie.
  assert.deepEqual(assets.requests, [
    { pathname: `/catalog/${revision}/react.js`, method: "GET", cookie: null },
  ]);
  const missing = await worker.fetch(
    new Request(`${origin}/catalog/${revision}/missing.js`),
    publicEnv(assetsBinding()),
    { waitUntil() {} },
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
});
