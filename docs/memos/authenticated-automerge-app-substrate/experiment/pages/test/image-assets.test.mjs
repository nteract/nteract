import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createServerAppSession } from "@cloud/app-session.ts";
import {
  oidcDatabase,
  randomSecret,
  SERVER_SESSION_COOKIE,
  serverSessionContext,
  serverSessionId,
} from "@cloud/oidc-session-store.ts";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import worker, { Page } from "../worker/index.mjs";
import { DocumentPolicy } from "../worker/policy.mjs";
import { inspectImage, imageAssetKey, requireStoredImageAsset } from "../worker/image-assets.mjs";
import { IMAGE_MAX_BYTES } from "../shared/image-assets.mjs";

// Actual 3x2 raster images encoded by Pillow, not hand-built header-only fixtures.
const fixtures = {
  "image/png":
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=",
  "image/jpeg":
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwBlFFFfQnzx/9k=",
  "image/webp":
    "UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoDAAIAAUAmJaACdLoB+AAEyAAA/q4X/yU1/jblq/+QXq3zbGgAAA==",
};
const bytesFor = (mime = "image/png") => new Uint8Array(Buffer.from(fixtures[mime], "base64"));
const extraFixtures = [
  [
    "image/jpeg",
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAUAQEAAAAAAAAAAAAAAAAAAAAF/9oADAMBAAIQAxAAAAGQgd//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEP8A/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=",
  ],
  ["image/webp", "UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQxSb1t/+BiOh/AAA="],
];
const pageId = "33333333-3333-4333-8333-333333333333";
const otherId = "44444444-4444-4444-8444-444444444444";
const publicOrigin = "https://page7.runtimed.run";

class Bucket {
  objects = new Map();
  calls = [];
  async head(key) {
    this.calls.push(["head", key]);
    return this.objects.get(key) ?? null;
  }
  async put(key, bytes, options) {
    this.calls.push(["put", key]);
    assert.deepEqual(options.onlyIf, { etagDoesNotMatch: "*" });
    if (this.objects.has(key)) return null;
    const object = {
      key,
      bytes: bytes.slice(),
      size: bytes.length,
      httpEtag: '"fixture-etag"',
      ...options,
    };
    this.objects.set(key, object);
    return object;
  }
  async get(key) {
    this.calls.push(["get", key]);
    const object = this.objects.get(key);
    return object ? { ...object, body: new Blob([object.bytes]).stream() } : null;
  }
}

async function fixture(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const env = {
    ...auth.env,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: publicOrigin,
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "fixture-only-session-secret-".repeat(2),
    PAGES_ASSETS: new Bucket(),
    DB: {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        let bindings = [];
        return {
          bind(...values) {
            bindings = values;
            return this;
          },
          async first() {
            return statement.get(...bindings) ?? null;
          },
          async run() {
            statement.run(...bindings);
            return { success: true };
          },
        };
      },
    },
  };
  await oidcDatabase(env);
  const principal = `user:anaconda-fixture:${auth.subject}`;
  const token = randomSecret(),
    now = Math.floor(Date.now() / 1000);
  const session = await createServerAppSession(
    env,
    {
      principal,
      metadata: {
        provider: "oidc",
        principalNamespace: "user:anaconda-fixture",
        displayName: "Fixture Person",
      },
    },
    "fixture-session",
    now + 300,
    now,
  );
  sqlite
    .prepare(`INSERT INTO oidc_server_sessions
    (id, context, session_json, sealed, access_expires_at, idle_expires_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      await serverSessionId(env, token),
      serverSessionContext(env, publicOrigin),
      JSON.stringify(session),
      "unused",
      now + 300,
      now + 300,
      now + 300,
    );
  const pages = new Map();
  for (const id of [pageId, otherId]) {
    const page = Object.assign(Object.create(Page.prototype), {
      env,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      metadata: { pageId: id, owner: principal, deleted: false },
      async installAccess(metadata) {
        this.metadata = metadata;
      },
    });
    page.policy = new DocumentPolicy({ metadata: () => page.metadata });
    pages.set(id, page);
  }
  const forwarded = [];
  env.PAGES = {
    getByName(id) {
      return {
        fetch(request) {
          forwarded.push(request.clone());
          return pages.get(id).fetch(request);
        },
      };
    },
  };
  const bearer = `Bearer ${auth.apiKey()}`,
    cookie = `${SERVER_SESSION_COOKIE}=${token}`;
  return {
    env,
    auth,
    pages,
    forwarded,
    principal,
    cookie,
    bearer,
    request({
      id = pageId,
      asset,
      method = asset ? "GET" : "POST",
      headers = {},
      body = method === "POST" ? bytesFor() : undefined,
      authenticated = true,
    } = {}) {
      return new Request(
        `http://127.0.0.1:9477/api/pages/${id}/assets${asset ? "/" + asset : ""}`,
        {
          method,
          headers: {
            ...(authenticated && { authorization: bearer }),
            ...(method === "POST" && { "content-type": "image/png" }),
            ...headers,
          },
          ...(body !== undefined && { body, duplex: "half" }),
        },
      );
    },
  };
}
const run = (f, options) => worker.fetch(f.request(options), f.env);
async function upload(f, options) {
  const response = await run(f, options);
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
function privateHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
}

test("real PNG, JPEG and WebP containers expose their actual dimensions", () => {
  for (const mime_type of Object.keys(fixtures))
    assert.deepEqual(inspectImage(bytesFor(mime_type)), { mime_type, width: 3, height: 2 });
  for (const [mime_type, encoded] of extraFixtures)
    assert.deepEqual(inspectImage(new Uint8Array(Buffer.from(encoded, "base64"))), {
      mime_type,
      width: 3,
      height: 2,
    });
});

test("baseline/progressive JPEG and lossy/lossless WebP upload and read back byte-identically", async (t) => {
  const f = await fixture(t);
  for (const [mime, encoded] of [...Object.entries(fixtures), ...extraFixtures]) {
    const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
    const image = await upload(f, { body: bytes, headers: { "content-type": mime } });
    assert.equal(image.mime_type, mime);
    const response = await run(f, { asset: image.asset_id });
    assert.equal(response.headers.get("content-type"), mime);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
});

test("image validation rejects active content, bad checksums, truncation and oversized dimensions", () => {
  for (const text of [
    "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "<html><script>alert(1)</script></html>",
  ])
    assert.throws(() => inspectImage(new TextEncoder().encode(text)), { status: 415 });
  for (const mime of Object.keys(fixtures)) {
    const bytes = bytesFor(mime);
    assert.throws(() => inspectImage(bytes.subarray(0, bytes.length - 5)), { status: 415 });
    assert.throws(() => inspectImage(new Uint8Array([...bytes, 0])), { status: 415 });
  }
  const png = bytesFor();
  png[45] ^= 1;
  assert.throws(() => inspectImage(png), { status: 415 });
  const webp = bytesFor("image/webp");
  // VP8 dimensions occupy two little-endian 14-bit fields.
  webp[26] = 0xff;
  webp[27] = 0x3f;
  assert.throws(() => inspectImage(webp), { status: 413 });
});

test("uploads raw bytes and serves a stable, immutable, Page-scoped private image", async (t) => {
  const f = await fixture(t),
    image = await upload(f);
  assert.match(image.asset_id, /^[0-9a-f]{64}$/);
  assert.equal(image.url, `/api/pages/${pageId}/assets/${image.asset_id}`);
  assert.equal(image.asset_url, image.url);
  assert.deepEqual(
    { ...image, asset_id: "id", asset_url: "url", url: "url" },
    {
      asset_id: "id",
      asset_url: "url",
      url: "url",
      mime_type: "image/png",
      size: bytesFor().length,
      width: 3,
      height: 2,
    },
  );
  assert.equal(f.env.PAGES_ASSETS.objects.size, 1);
  assert.ok(f.env.PAGES_ASSETS.objects.has(imageAssetKey(pageId, image.asset_id)));
  for (const method of ["GET", "HEAD"]) {
    const response = await run(f, { method, asset: image.asset_id });
    assert.equal(response.status, 200);
    privateHeaders(response);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("content-length"), String(bytesFor().length));
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      method === "GET" ? bytesFor() : new Uint8Array(),
    );
  }
  const retry = await run(f);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), image);
  assert.equal(f.env.PAGES_ASSETS.calls.filter(([method]) => method === "put").length, 1);
  assert.equal((await run(f, { id: otherId, asset: image.asset_id })).status, 404);
});

test("cookie upload requires same-origin evidence; bearer and cookie reads share Page permissions", async (t) => {
  const f = await fixture(t);
  for (const options of [
    { authenticated: false },
    { authenticated: false, headers: { cookie: f.cookie } },
    { headers: { origin: "https://attacker.invalid" } },
    { authenticated: false, headers: { cookie: f.cookie, origin: "https://attacker.invalid" } },
    { headers: { "sec-fetch-site": "cross-site" } },
    { headers: { authorization: "Bearer pages_not-an-api-key" } },
  ]) {
    const response = await run(f, options);
    assert.ok([401, 403].includes(response.status), await response.text());
    privateHeaders(response);
  }
  assert.equal(f.env.PAGES_ASSETS.calls.length, 0);
  assert.equal(f.forwarded.length, 0);
  const image = await upload(f, {
    authenticated: false,
    headers: { cookie: f.cookie, origin: publicOrigin },
  });
  const read = await run(f, {
    asset: image.asset_id,
    authenticated: false,
    headers: { cookie: f.cookie },
  });
  assert.equal(read.status, 200);
  assert.equal(f.forwarded.at(-1).headers.get("origin"), publicOrigin);
});

test("ACL and credential ceilings apply before storage, and revocation blocks subsequent reads", async (t) => {
  const f = await fixture(t),
    image = await upload(f);
  const page = f.pages.get(pageId);
  page.metadata.owner = "user:someone-else";
  page.metadata.acl = { members: { [f.principal]: { role: "viewer", generation: 1 } } };
  assert.equal((await run(f, { asset: image.asset_id })).status, 200);
  let before = f.env.PAGES_ASSETS.calls.length;
  assert.equal((await run(f)).status, 403);
  assert.equal(f.env.PAGES_ASSETS.calls.length, before);
  page.metadata.acl.members[f.principal].role = "editor";
  assert.equal((await run(f)).status, 200);
  before = f.env.PAGES_ASSETS.calls.length;
  assert.equal(
    (
      await run(f, {
        headers: { authorization: `Bearer ${f.auth.apiKey({ scopes: ["cloud:read"] })}` },
      })
    ).status,
    403,
  );
  assert.equal(f.env.PAGES_ASSETS.calls.length, before);
  page.metadata.acl.members[f.principal].role = "none";
  for (const method of ["GET", "HEAD"])
    assert.equal((await run(f, { asset: image.asset_id, method })).status, 403);
  assert.equal(f.env.PAGES_ASSETS.calls.length, before);
});

test("Page deletion and unrelated principals cannot read or overwrite an existing image", async (t) => {
  const f = await fixture(t),
    image = await upload(f);
  const before = f.env.PAGES_ASSETS.calls.length;
  const headers = { authorization: `Bearer ${f.auth.apiKey({ userId: "unrelated-person" })}` };
  assert.equal((await run(f, { asset: image.asset_id, headers })).status, 403);
  assert.equal((await run(f, { headers })).status, 403);
  f.pages.get(pageId).metadata.deleted = true;
  assert.equal((await run(f, { asset: image.asset_id })).status, 404);
  assert.equal((await run(f)).status, 404);
  assert.equal(f.env.PAGES_ASSETS.calls.length, before);
});

test("upload transfer does not hold the Page queue, and revocation before completion prevents attachment", async (t) => {
  const f = await fixture(t),
    page = f.pages.get(pageId);
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const put = f.env.PAGES_ASSETS.put.bind(f.env.PAGES_ASSETS);
  f.env.PAGES_ASSETS.put = async (...args) => {
    started();
    await gate;
    return put(...args);
  };
  const uploading = run(f);
  await entered;
  await page.tail;
  // This synchronous policy update models a removal admitted during network IO.
  page.metadata.owner = "user:someone-else";
  release();
  const response = await uploading;
  assert.equal(response.status, 403);
  privateHeaders(response);
  assert.equal(
    f.env.PAGES_ASSETS.objects.size,
    1,
    "safe private orphan is retained, not published or deleted",
  );
});

test("oversized bodies, MIME mismatch and missing storage fail without publishing references", async (t) => {
  const f = await fixture(t);
  for (const options of [
    { body: new Uint8Array(IMAGE_MAX_BYTES + 1) },
    { headers: { "content-length": String(IMAGE_MAX_BYTES + 1) } },
    { headers: { "content-type": "image/jpeg" } },
    { body: new TextEncoder().encode("<svg>not a raster</svg>") },
  ]) {
    const response = await run(f, options);
    assert.ok([413, 415].includes(response.status));
    privateHeaders(response);
  }
  assert.equal(f.env.PAGES_ASSETS.calls.length, 0);
  delete f.env.PAGES_ASSETS;
  assert.equal((await run(f)).status, 503);
});

test("streaming uploads without Content-Length stop at the byte limit and cancel the source", async (t) => {
  const f = await fixture(t);
  let cancelled = false,
    pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await run(f, { body });
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 7, "bounded streaming read must not drain the entire source");
  assert.equal(f.env.PAGES_ASSETS.calls.length, 0);
});

test("a concurrent immutable PUT loser confirms and returns the winning object", async (t) => {
  const f = await fixture(t),
    put = f.env.PAGES_ASSETS.put.bind(f.env.PAGES_ASSETS);
  f.env.PAGES_ASSETS.put = async (...args) => {
    await put(...args);
    return null; // The store reports that a concurrent writer won the conditional PUT.
  };
  const response = await run(f);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mime_type, "image/png");
  assert.equal(f.env.PAGES_ASSETS.objects.size, 1);
});

test("ambiguous completed PUT retries the same object instead of losing or duplicating it", async (t) => {
  const f = await fixture(t),
    put = f.env.PAGES_ASSETS.put.bind(f.env.PAGES_ASSETS);
  let first = true;
  f.env.PAGES_ASSETS.put = async (...args) => {
    const object = await put(...args);
    if (first) {
      first = false;
      throw new Error("simulated lost write response");
    }
    return object;
  };
  const failed = await run(f);
  assert.equal(failed.status, 500);
  privateHeaders(failed);
  assert.deepEqual(await failed.json(), { error: "Pages request failed" });
  const retry = await run(f);
  assert.equal(retry.status, 200);
  assert.equal(f.env.PAGES_ASSETS.objects.size, 1);
  assert.equal((await retry.json()).mime_type, "image/png");
});

test("image insertion preflight resolves the Page-local immutable asset without reading its bytes", async (t) => {
  const f = await fixture(t),
    image = await upload(f);
  f.env.PAGES_ASSETS.calls.length = 0;
  const metadata = await requireStoredImageAsset(f.env.PAGES_ASSETS, {
    pageId,
    assetId: image.asset_id,
  });
  const { url, ...expected } = image;
  assert.deepEqual(metadata, expected);
  assert.equal(metadata.asset_url, url);
  assert.deepEqual(f.env.PAGES_ASSETS.calls, [["head", imageAssetKey(pageId, image.asset_id)]]);
  await assert.rejects(
    requireStoredImageAsset(f.env.PAGES_ASSETS, { pageId: otherId, assetId: image.asset_id }),
    { status: 404 },
  );
  await assert.rejects(
    requireStoredImageAsset(f.env.PAGES_ASSETS, { pageId, assetId: "0".repeat(64) }),
    { status: 404 },
  );
  await assert.rejects(requireStoredImageAsset(undefined, { pageId, assetId: image.asset_id }), {
    status: 503,
  });
});

test("image insertion preflight rejects malformed references before accessing storage", async () => {
  const bucket = new Bucket();
  for (const reference of [
    { pageId: "../other", assetId: "0".repeat(64) },
    { pageId, assetId: "https://example.com/image.png" },
    { pageId, assetId: "../other" },
    { pageId, assetId: "A".repeat(64) },
    { pageId },
  ])
    await assert.rejects(requireStoredImageAsset(bucket, reference), { status: 400 });
  assert.deepEqual(bucket.calls, []);
});

test("image insertion and duplicate upload reject inconsistent stored object metadata", async (t) => {
  const f = await fixture(t),
    image = await upload(f);
  const key = imageAssetKey(pageId, image.asset_id),
    stored = f.env.PAGES_ASSETS.objects.get(key);
  const corruptions = [
    { size: IMAGE_MAX_BYTES + 1 },
    { size: 0 },
    { size: 12.5 },
    { httpMetadata: { contentType: "image/svg+xml" } },
    ...[
      { page_id: otherId },
      { hash: "0".repeat(64) },
      { width: "0" },
      { width: "3.0" },
      { width: "Infinity" },
      { width: "9000" },
      { width: "8192", height: "8192" },
      { height: "-2" },
      { height: undefined },
    ].map((changes) => ({ customMetadata: { ...stored.customMetadata, ...changes } })),
  ];
  for (const corruption of corruptions) {
    f.env.PAGES_ASSETS.objects.set(key, { ...stored, ...corruption });
    await assert.rejects(
      requireStoredImageAsset(f.env.PAGES_ASSETS, { pageId, assetId: image.asset_id }),
      { status: 500 },
    );
    const response = await run(f);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Pages request failed" });
  }
  assert.equal(f.env.PAGES_ASSETS.calls.filter(([method]) => method === "put").length, 1);
});
