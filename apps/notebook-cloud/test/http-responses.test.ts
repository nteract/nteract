import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { R2HTTPMetadata, R2ObjectBody } from "../src/cloudflare-types.ts";
import {
  immutableR2ObjectHeadResponse,
  immutableR2ObjectResponse,
  json,
  withBrowserSecurityHeaders,
} from "../src/http-responses.ts";

describe("notebook cloud HTTP responses", () => {
  it("serializes JSON with CORS headers", async () => {
    const response = json({ ok: true }, 201);

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("Content-Type"), "application/json");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(
      response.headers.get("Access-Control-Allow-Headers") ?? "",
      /x-notebook-cloud-dev-token/,
    );
    assert.deepEqual(await response.json(), { ok: true });
  });

  it("adds browser hardening headers with optional CSP", () => {
    const response = withBrowserSecurityHeaders(new Response("html"), "frame-ancestors 'none'");

    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
    assert.match(response.headers.get("Permissions-Policy") ?? "", /camera=\(\)/);
    assert.equal(response.headers.get("Content-Security-Policy"), "frame-ancestors 'none'");
  });

  it("serves immutable R2 object bodies without leaking route-specific choices", async () => {
    const object = fakeR2Object(new Uint8Array([1, 2, 3]), {
      contentType: "application/vnd.apache.arrow.stream",
    });

    const response = immutableR2ObjectResponse(object);

    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("Content-Type"), "application/vnd.apache.arrow.stream");
    assert.equal(response.headers.get("ETag"), '"fake-etag"');
    assert.equal(response.headers.has("Content-Length"), false);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
  });

  it("can include Content-Length for blob GET and HEAD responses", async () => {
    const object = fakeR2Object(new Uint8Array([4, 5, 6, 7]));

    const getResponse = immutableR2ObjectResponse(object, { includeContentLength: true });
    const headResponse = immutableR2ObjectHeadResponse(object);

    assert.equal(getResponse.headers.get("Content-Length"), "4");
    assert.equal(headResponse.headers.get("Content-Length"), "4");
    assert.equal(await headResponse.text(), "");
  });
});

function fakeR2Object(bytes: Uint8Array, httpMetadata?: R2HTTPMetadata): R2ObjectBody {
  return {
    key: "fake-key",
    version: "fake-version",
    size: bytes.byteLength,
    etag: "fake-etag",
    httpEtag: '"fake-etag"',
    uploaded: new Date("2026-06-05T00:00:00.000Z"),
    httpMetadata,
    body: new Response(bytes).body!,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async text() {
      return new TextDecoder().decode(bytes);
    },
    writeHttpMetadata(headers: Headers) {
      if (httpMetadata?.contentType) {
        headers.set("Content-Type", httpMetadata.contentType);
      }
    },
  };
}
