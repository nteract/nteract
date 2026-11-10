import assert from "node:assert/strict";
import { test } from "node:test";
import { setResponseHeaders } from "./response-headers.mjs";
import { privateImageResponse } from "./image-assets.mjs";
import { immutableHeaders } from "./projects-fixture.mjs";

const PRIVATE = [
  ["cache-control", "private, no-store"],
  ["x-content-type-options", "nosniff"],
];

test("a response with mutable headers is changed in place", () => {
  const response = Response.json({ ok: true }, { status: 201 });
  const result = setResponseHeaders(response, PRIVATE);
  assert.equal(result, response);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
});

test("a response with immutable headers is copied with its status, body and headers", async () => {
  const refusal = immutableHeaders(
    Response.json({ code: "not_page_owner" }, { status: 403, headers: { "x-request": "r1" } }),
  );
  assert.throws(() => refusal.headers.set("cache-control", "no-store"), TypeError);
  const result = setResponseHeaders(refusal, PRIVATE);
  assert.notEqual(result, refusal);
  assert.equal(result.status, 403);
  assert.equal(result.headers.get("x-request"), "r1");
  assert.equal(result.headers.get("content-type"), "application/json");
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await result.json(), { code: "not_page_owner" });
});

test("a redirect built by Response.redirect is immutable and still gains the headers", () => {
  const redirect = Response.redirect("https://pages.invalid/elsewhere", 302);
  assert.throws(() => redirect.headers.set("cache-control", "no-store"), TypeError);
  const result = setResponseHeaders(redirect, PRIVATE);
  assert.equal(result.status, 302);
  assert.equal(result.headers.get("location"), "https://pages.invalid/elsewhere");
  assert.equal(result.headers.get("cache-control"), "private, no-store");
});

for (const status of [204, 205, 304]) {
  test(`an immutable ${status} with an empty stream body is copied without a body`, () => {
    const response = new Response(null, { status, headers: { etag: '"abc"' } });
    // Node won't construct a null-body status with a stream; Workers can
    // return one from a host or the asset binding.
    Object.defineProperty(response, "body", {
      value: new ReadableStream({ start: (controller) => controller.close() }),
    });
    const result = setResponseHeaders(immutableHeaders(response), PRIVATE);
    assert.equal(result.status, status);
    assert.equal(result.body, null);
    assert.equal(result.headers.get("etag"), '"abc"');
    assert.equal(result.headers.get("cache-control"), "private, no-store");
  });
}

test("an error that is not the immutable-headers TypeError is thrown", () => {
  const response = new Response("x");
  response.headers.set = () => {
    throw new RangeError("unrelated");
  };
  assert.throws(() => setResponseHeaders(response, PRIVATE), RangeError);
});

test("privateImageResponse marks a Page host's refusal private", async () => {
  const refusal = immutableHeaders(Response.json({ code: "page_trashed" }, { status: 409 }));
  const result = privateImageResponse(refusal);
  assert.equal(result.status, 409);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.deepEqual(await result.json(), { code: "page_trashed" });
});
