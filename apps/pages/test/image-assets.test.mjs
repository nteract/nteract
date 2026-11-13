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
import { createAuthFixture } from "../auth-fixtures.mjs";
import { MEMBER_FORMATS } from "../model/document-types.mjs";
import worker, { Page } from "../worker/index.mjs";
import { DocumentPolicy } from "../worker/policy.mjs";
import {
  inspectImage,
  inspectParquet,
  imageAssetKey,
  persistImageAsset,
  requireStoredImageAsset,
} from "../worker/image-assets.mjs";
import { IMAGE_MAX_BYTES } from "../shared/image-assets.mjs";
import { DATASET_MAX_BYTES, PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";
import { plainStub } from "../worker/plain-stub.mjs";

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
// A real two-row, three-column table written by pyarrow 26 (uncompressed).
const parquetFixture =
  "UEFSMRUEFTgVOEwVBBUAEgAACgAAADIwMjYtMTEtMDEKAAAAMjAyNi0xMS0wMhUAFRIVEiwVBBUQFQYVBhw2ACgKMjAyNi0xMS0wMhgKMjAyNi0xMS0wMRERAAAAAgAAAAQBAQMCFQQVJBUkTBUEFQASAAADAAAAbWNwBwAAAGJyb3dzZXIVABUSFRIsFQQVEBUGFQYcNgAoA21jcBgHYnJvd3NlchERAAAAAgAAAAQBAQMCFQQVIBUgTBUEFQASAAAqAAAAAAAAAAcAAAAAAAAAFQAVEhUSLBUEFRAVBhUGHBgIKgAAAAAAAAAYCAcAAAAAAAAAFgAoCCoAAAAAAAAAGAgHAAAAAAAAABERAAAAAgAAAAQBAQMCFQQZTDUAGAZzY2hlbWEVBgAVDCUCGANkYXklAEwcAAAAFQwlAhgHc3VyZmFjZSUATBwAAAAVBCUCGAZldmVudHMAFgQZHBk8JgAcFQwZNQAGEBkYA2RheRUAFgQWxAEWxAEmXCYIHDYAKAoyMDI2LTExLTAyGAoyMDI2LTExLTAxEREAGSwVBBUAFQIAFQAVEBUCADwWKBkGGSYABAAAACYAHBUMGTUABhAZGAdzdXJmYWNlFQAWBBacARacASaMAibMARw2ACgDbWNwGAdicm93c2VyEREAGSwVBBUAFQIAFQAVEBUCADwWFBkGGSYABAAAACYAHBUEGTUABhAZGAZldmVudHMVABYEFswBFswBJqQDJugCHBgIKgAAAAAAAAAYCAcAAAAAAAAAFgAoCCoAAAAAAAAAGAgHAAAAAAAAABERABksFQQVABUCABUAFRAVAgA8KQYZJgAEAAAAFqwEFgQmCBasBAAZHBgMQVJST1c6c2NoZW1hGKwCLy8vLy85Z0FBQUFRQUFBQUFBQUtBQXdBQmdBRkFBZ0FDZ0FBQUFBQkJBQU1BQUFBQ0FBSUFBQUFCQUFJQUFBQUJBQUFBQU1BQUFCOEFBQUFRQUFBQUFRQUFBQ2cvLy8vQUFBQkFoQUFBQUFnQUFBQUJBQUFBQUFBQUFBR0FBQUFaWFpsYm5SekFBQUlBQXdBQ0FBSEFBZ0FBQUFBQUFBQlFBQUFBTmovLy84QUFBRUZFQUFBQUJnQUFBQUVBQUFBQUFBQUFBY0FBQUJ6ZFhKbVlXTmxBTXovLy84UUFCUUFDQUFHQUFjQURBQUFBQkFBRUFBQUFBQUFBUVVRQUFBQUdBQUFBQVFBQUFBQUFBQUFBd0FBQUdSaGVRQUVBQVFBQkFBQUFBQUFBQUE9ABggcGFycXVldC1jcHAtYXJyb3cgdmVyc2lvbiAyNi4wLjAZPBwAABwAABwAAADYAgAAUEFSMQ==";
const parquetBytes = () => new Uint8Array(Buffer.from(parquetFixture, "base64"));
const pageId = "33333333-3333-4333-8333-333333333333";
const otherId = "44444444-4444-4444-8444-444444444444";
const publicOrigin = "https://page10.runtimed.run";

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
      plain: plainStub(),
      env,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      metadata: { pageId: id, documentFormats: MEMBER_FORMATS, owner: principal, deleted: false },
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
// Refusals, errors and upload results are never stored.
function privateHeaders(response, cache = "private, no-store") {
  assert.equal(response.headers.get("cache-control"), cache);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
}
// Served bytes are named by their hash, so the reader's browser keeps them.
const servedHeaders = (response) =>
  privateHeaders(response, "private, max-age=31536000, immutable");

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
      insert: { op: "insert_image", asset_id: image.asset_id },
    },
  );
  assert.equal(f.env.PAGES_ASSETS.objects.size, 1);
  assert.ok(f.env.PAGES_ASSETS.objects.has(imageAssetKey(pageId, image.asset_id)));
  for (const method of ["GET", "HEAD"]) {
    const response = await run(f, { method, asset: image.asset_id });
    assert.equal(response.status, 200);
    servedHeaders(response);
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
  for (const method of ["GET", "HEAD"]) {
    const refused = await run(f, { asset: image.asset_id, method });
    assert.equal(refused.status, 403);
    privateHeaders(refused);
  }
  assert.equal(f.env.PAGES_ASSETS.calls.length, before);
});

test("served asset bytes are immutable in the reader's cache; every refusal is uncacheable", async (t) => {
  const f = await fixture(t),
    image = await upload(f);
  const served = await run(f, { asset: image.asset_id });
  assert.equal(served.status, 200);
  servedHeaders(served);
  assert.ok(served.headers.get("etag"));
  const missing = "0".repeat(64);
  const refusals = {
    "no credential": await run(f, { asset: image.asset_id, authenticated: false }),
    "not stored": await run(f, { asset: missing }),
    "other Page": await run(f, { id: otherId, asset: image.asset_id }),
    "bad reference": await run(f, { asset: "not-a-hash" }),
    "wrong method": await run(f, { asset: image.asset_id, method: "DELETE" }),
  };
  const unrelated = { authorization: `Bearer ${f.auth.apiKey({ userId: "unrelated-person" })}` };
  refusals["no access"] = await run(f, { asset: image.asset_id, headers: unrelated });
  f.pages.get(pageId).metadata.deleted = true;
  refusals["deleted Page"] = await run(f, { asset: image.asset_id });
  for (const [reason, response] of Object.entries(refusals)) {
    assert.ok(response.status >= 400, reason);
    privateHeaders(response);
  }
  f.pages.get(pageId).metadata.deleted = false;
  delete f.env.PAGES_ASSETS;
  const failed = await run(f, { asset: image.asset_id });
  assert.equal(failed.status, 503);
  privateHeaders(failed);
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
    // The refusal names its status as a code, as /api/tools refusals do.
    assert.equal(
      (await response.json()).code,
      response.status === 413 ? "request_too_large" : "unsupported_media_type",
    );
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
  assert.deepEqual(await failed.json(), { error: "Pages request failed", code: "server_error" });
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
  const { url, insert: _insert, ...expected } = image;
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
    assert.deepEqual(await response.json(), {
      error: "Pages request failed",
      code: "server_error",
    });
  }
  assert.equal(f.env.PAGES_ASSETS.calls.filter(([method]) => method === "put").length, 1);
});

test("Parquet containers need PAR1 at both ends and a footer that fits", () => {
  assert.deepEqual(inspectParquet(parquetBytes()), { mime_type: PARQUET_MEDIA_TYPE });
  const bytes = parquetBytes();
  const footerAt = bytes.length - 8;
  const cases = [
    bytes.subarray(0, bytes.length - 1),
    bytes.subarray(1),
    new Uint8Array([...bytes.subarray(0, bytes.length - 4), ...new TextEncoder().encode("PARE")]),
    new TextEncoder().encode("PAR1PAR1"),
    new TextEncoder().encode("PAR1\0\0\0\0PAR1"),
  ];
  const tooLong = bytes.slice();
  new DataView(tooLong.buffer).setUint32(footerAt, bytes.length, true);
  const empty = bytes.slice();
  new DataView(empty.buffer).setUint32(footerAt, 0, true);
  for (const value of [...cases, tooLong, empty])
    assert.throws(() => inspectParquet(value), { status: 415 });
});

test("a Parquet upload is stored once, Page-scoped, and served as a download", async (t) => {
  const f = await fixture(t);
  for (const contentType of [PARQUET_MEDIA_TYPE, "application/octet-stream"]) {
    const response = await run(f, {
      body: parquetBytes(),
      headers: { "content-type": contentType },
    });
    assert.ok([200, 201].includes(response.status), await response.clone().text());
    privateHeaders(response);
    const dataset = await response.json();
    assert.deepEqual(
      { ...dataset, asset_id: "id", asset_url: "url", url: "url" },
      {
        asset_id: "id",
        asset_url: "url",
        url: "url",
        mime_type: PARQUET_MEDIA_TYPE,
        size: parquetBytes().length,
        insert: {
          op: "insert_node",
          node: { type: "dataframe", attrs: { asset_id: dataset.asset_id } },
        },
      },
    );
    assert.equal(dataset.url, `/api/pages/${pageId}/assets/${dataset.asset_id}`);
    const stored = f.env.PAGES_ASSETS.objects.get(imageAssetKey(pageId, dataset.asset_id));
    assert.deepEqual(stored.customMetadata, { page_id: pageId, hash: dataset.asset_id });
    for (const method of ["GET", "HEAD"]) {
      const read = await run(f, { method, asset: dataset.asset_id });
      assert.equal(read.status, 200);
      servedHeaders(read);
      assert.equal(read.headers.get("content-type"), PARQUET_MEDIA_TYPE);
      assert.equal(
        read.headers.get("content-disposition"),
        `attachment; filename="${dataset.asset_id}.parquet"`,
      );
      assert.deepEqual(
        new Uint8Array(await read.arrayBuffer()),
        method === "GET" ? parquetBytes() : new Uint8Array(),
      );
    }
    assert.equal((await run(f, { id: otherId, asset: dataset.asset_id })).status, 404);
  }
  assert.equal(f.env.PAGES_ASSETS.calls.filter(([method]) => method === "put").length, 1);
});

test("Parquet bytes under an image Content-Type, or as a broken container, are refused", async (t) => {
  const f = await fixture(t);
  const truncated = parquetBytes().subarray(0, 64);
  for (const options of [
    { body: parquetBytes(), headers: { "content-type": "image/png" } },
    { body: truncated, headers: { "content-type": PARQUET_MEDIA_TYPE } },
    { body: bytesFor(), headers: { "content-type": PARQUET_MEDIA_TYPE } },
    {
      body: new Uint8Array(DATASET_MAX_BYTES + 1),
      headers: { "content-type": PARQUET_MEDIA_TYPE },
    },
  ]) {
    const response = await run(f, options);
    assert.ok([413, 415].includes(response.status), await response.clone().text());
    privateHeaders(response);
  }
  assert.equal(f.env.PAGES_ASSETS.calls.filter(([method]) => method === "put").length, 0);
});

test("image paths refuse a Parquet dataset: import, insert_image preflight", async (t) => {
  const f = await fixture(t);
  await assert.rejects(persistImageAsset(f.env.PAGES_ASSETS, { pageId, bytes: parquetBytes() }), {
    status: 415,
  });
  const dataset = await upload(f, {
    body: parquetBytes(),
    headers: { "content-type": PARQUET_MEDIA_TYPE },
  });
  await assert.rejects(
    requireStoredImageAsset(f.env.PAGES_ASSETS, { pageId, assetId: dataset.asset_id }),
    { status: 415, message: /insert_node/ },
  );
});

test("a stored dataset with image metadata or the wrong Page fails closed", async (t) => {
  const f = await fixture(t);
  const dataset = await upload(f, {
    body: parquetBytes(),
    headers: { "content-type": PARQUET_MEDIA_TYPE },
  });
  const key = imageAssetKey(pageId, dataset.asset_id),
    stored = f.env.PAGES_ASSETS.objects.get(key);
  for (const changes of [
    { width: "3", height: "2" },
    { page_id: otherId },
    { hash: "0".repeat(64) },
  ]) {
    f.env.PAGES_ASSETS.objects.set(key, {
      ...stored,
      customMetadata: { ...stored.customMetadata, ...changes },
    });
    const response = await run(f, {
      body: parquetBytes(),
      headers: { "content-type": PARQUET_MEDIA_TYPE },
    });
    assert.equal(response.status, 500);
  }
});

// Copying a dataset between Pages: POST to the asset's URL on the
// destination, naming the source Page. pageId is the destination and otherId
// the source throughout.
const copyRequest = (f, assetId, { from = otherId, id = pageId, headers = {}, body } = {}) =>
  run(f, {
    id,
    asset: assetId,
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body ?? JSON.stringify({ from_page_id: from }),
  });
async function sourceDataset(f) {
  return upload(f, {
    id: otherId,
    body: parquetBytes(),
    headers: { "content-type": PARQUET_MEDIA_TYPE },
  });
}
const share = (f, id, role) => {
  const page = f.pages.get(id);
  page.metadata.owner = "user:someone-else";
  page.metadata.acl = { members: { [f.principal]: { role, generation: 1 } } };
};
const puts = (f) => f.env.PAGES_ASSETS.calls.filter(([method]) => method === "put").length;

test("a dataset copies to another Page under the same id, once", async (t) => {
  const f = await fixture(t),
    dataset = await sourceDataset(f);
  assert.equal((await run(f, { asset: dataset.asset_id })).status, 404);
  const copied = await copyRequest(f, dataset.asset_id);
  assert.equal(copied.status, 201, await copied.clone().text());
  privateHeaders(copied);
  const body = await copied.json();
  const url = `/api/pages/${pageId}/assets/${dataset.asset_id}`;
  assert.deepEqual(body, {
    asset_id: dataset.asset_id,
    url,
    asset_url: url,
    mime_type: PARQUET_MEDIA_TYPE,
    size: parquetBytes().length,
    insert: {
      op: "insert_node",
      node: { type: "dataframe", attrs: { asset_id: dataset.asset_id } },
    },
  });
  const stored = f.env.PAGES_ASSETS.objects.get(imageAssetKey(pageId, dataset.asset_id));
  assert.deepEqual(stored.customMetadata, { page_id: pageId, hash: dataset.asset_id });
  const read = await run(f, { asset: dataset.asset_id });
  assert.equal(read.status, 200);
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), parquetBytes());
  // A repeat, and a dataset already on the destination, are success with no
  // second write.
  const before = puts(f);
  const again = await copyRequest(f, dataset.asset_id);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), body);
  assert.equal(puts(f), before);
  // Uploading the same bytes after the copy finds them too.
  const uploaded = await run(f, {
    body: parquetBytes(),
    headers: { "content-type": PARQUET_MEDIA_TYPE },
  });
  assert.equal(uploaded.status, 200);
  assert.equal(puts(f), before);
});

test("a copy needs edit access to the destination and read access to the source", async (t) => {
  const f = await fixture(t),
    dataset = await sourceDataset(f);
  const cases = [
    // [destination role, source role, status]
    ["viewer", "viewer", 403],
    ["commenter", "editor", 403],
    ["none", "viewer", 403],
    ["editor", "none", 403],
    ["none", "none", 403],
    ["editor", "viewer", 201],
  ];
  for (const [target, source, status] of cases) {
    share(f, pageId, target);
    share(f, otherId, source);
    const before = f.env.PAGES_ASSETS.calls.length;
    const response = await copyRequest(f, dataset.asset_id);
    assert.equal(
      response.status,
      status,
      `${target} → ${source}: ${await response.clone().text()}`,
    );
    privateHeaders(response);
    if (status !== 201)
      assert.equal(f.env.PAGES_ASSETS.calls.length, before, `${target}/${source}`);
  }
  // A session cookie needs same-origin evidence, as an upload does.
  const crossSite = await run(f, {
    asset: dataset.asset_id,
    method: "POST",
    authenticated: false,
    headers: {
      cookie: f.cookie,
      origin: "https://attacker.invalid",
      "content-type": "application/json",
    },
    body: JSON.stringify({ from_page_id: otherId }),
  });
  assert.ok([401, 403].includes(crossSite.status), await crossSite.clone().text());
  // A read-only credential can't copy, even for the owner of both Pages.
  for (const id of [pageId, otherId]) f.pages.get(id).metadata.owner = f.principal;
  const readOnly = await copyRequest(f, dataset.asset_id, {
    headers: { authorization: `Bearer ${f.auth.apiKey({ scopes: ["cloud:read"] })}` },
  });
  assert.equal(readOnly.status, 403);
  // Neither does an upload capability, which authorizes only a byte upload.
  const capability = await copyRequest(f, dataset.asset_id, {
    headers: { authorization: "Pages-Upload pu1.forged" },
  });
  assert.equal(capability.status, 401);
  assert.equal((await capability.json()).code, "upload_capability_invalid");
});

test("a company domain grant copies as its role: an editor into the destination, any role out of the source", async (t) => {
  const f = await fixture(t),
    dataset = await sourceDataset(f);
  f.env.PAGES_COMPANY_VIEW_DOMAINS = "anaconda.com";
  const companyKey = `Bearer ${f.auth.apiKey({ email: "person@anaconda.com" })}`;
  const shareWithCompany = (id, role) => {
    const page = f.pages.get(id);
    page.metadata.owner = "user:someone-else";
    page.metadata.acl = {
      revision: 1,
      members: {},
      invites: {},
      domainView: { domain: "anaconda.com", namespace: "user:anaconda-fixture", role },
    };
  };
  const cases = [
    // [destination role, source role, status]
    ["viewer", "editor", 403],
    ["commenter", "editor", 403],
    ["editor", "viewer", 201],
    ["editor", "commenter", 200],
    ["editor", "editor", 200],
  ];
  for (const [target, source, status] of cases) {
    shareWithCompany(pageId, target);
    shareWithCompany(otherId, source);
    const before = puts(f);
    const response = await copyRequest(f, dataset.asset_id, {
      headers: { authorization: companyKey },
    });
    assert.equal(
      response.status,
      status,
      `${target} → ${source}: ${await response.clone().text()}`,
    );
    // The copy answers with the asset alone; it hands out no capability.
    if (status !== 403)
      assert.deepEqual(Object.keys(await response.json()).sort(), [
        "asset_id",
        "asset_url",
        "insert",
        "mime_type",
        "size",
        "url",
      ]);
    else assert.equal(puts(f), before, `${target}/${source}`);
  }
  // The same grants give an account without a company email nothing.
  const outsider = await copyRequest(f, "0".repeat(64), {
    headers: { authorization: `Bearer ${f.auth.apiKey({ email: "person@gmail.com" })}` },
  });
  assert.equal(outsider.status, 403);
});

test("a source the caller can't read answers the same whether the dataset is there", async (t) => {
  const f = await fixture(t),
    dataset = await sourceDataset(f);
  share(f, otherId, "none");
  const before = f.env.PAGES_ASSETS.calls.length;
  const present = await copyRequest(f, dataset.asset_id);
  const absent = await copyRequest(f, "0".repeat(64));
  assert.equal(present.status, 403);
  assert.equal(absent.status, present.status);
  assert.deepEqual(await absent.json(), await present.json());
  // Neither looked at storage.
  assert.equal(f.env.PAGES_ASSETS.calls.length, before);
  // A readable source says when the dataset isn't there.
  share(f, otherId, "viewer");
  const missing = await copyRequest(f, "0".repeat(64));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "dataset_not_found");
});

test("only a Parquet dataset copies; an image or a bad request is refused", async (t) => {
  const f = await fixture(t);
  const image = await upload(f, { id: otherId });
  const before = puts(f);
  const refused = await copyRequest(f, image.asset_id);
  assert.equal(refused.status, 415, await refused.clone().text());
  privateHeaders(refused);
  assert.equal(puts(f), before);
  for (const [body, headers] of [
    ["not json", {}],
    [JSON.stringify({ from_page_id: "not-a-page" }), {}],
    [JSON.stringify({ from_page_id: otherId, extra: 1 }), {}],
    [JSON.stringify([otherId]), {}],
    [JSON.stringify({ from_page_id: otherId }), { "content-type": "text/plain" }],
    [JSON.stringify({ from_page_id: otherId, pad: "x".repeat(2048) }), {}],
  ]) {
    const response = await copyRequest(f, image.asset_id, { body, headers });
    assert.ok([400, 413, 415].includes(response.status), `${body}: ${response.status}`);
    privateHeaders(response);
  }
  assert.equal(puts(f), before);
});

test("a copy meets the destination's limits as an upload does", async (t) => {
  const f = await fixture(t),
    dataset = await sourceDataset(f);
  // A Page whose recovery is blocked takes no new assets.
  f.pages.get(pageId).metadata.recoveryBlocked = { code: "history_capacity" };
  const blocked = await copyRequest(f, dataset.asset_id);
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, "page_recovery_blocked");
  delete f.pages.get(pageId).metadata.recoveryBlocked;
  // A source object over the dataset limit is refused before its bytes are
  // read or anything is stored.
  const key = imageAssetKey(otherId, dataset.asset_id);
  const stored = f.env.PAGES_ASSETS.objects.get(key);
  f.env.PAGES_ASSETS.objects.set(key, { ...stored, size: DATASET_MAX_BYTES + 1 });
  const before = f.env.PAGES_ASSETS.calls.length;
  const large = await copyRequest(f, dataset.asset_id);
  assert.equal(large.status, 413, await large.clone().text());
  assert.deepEqual(
    f.env.PAGES_ASSETS.calls.slice(before).map(([method]) => method),
    ["head", "head"],
  );
  // Bytes that aren't a valid container are refused as an upload refuses them.
  f.env.PAGES_ASSETS.objects.set(key, {
    ...stored,
    bytes: parquetBytes().subarray(0, 64),
    size: 64,
  });
  assert.equal((await copyRequest(f, dataset.asset_id)).status, 415);
  assert.equal(f.env.PAGES_ASSETS.objects.has(imageAssetKey(pageId, dataset.asset_id)), false);
  // Revoking edit access during the copy refuses its result.
  f.env.PAGES_ASSETS.objects.set(key, stored);
  const put = f.env.PAGES_ASSETS.put.bind(f.env.PAGES_ASSETS);
  f.env.PAGES_ASSETS.put = async (...args) => {
    share(f, pageId, "viewer");
    return put(...args);
  };
  assert.equal((await copyRequest(f, dataset.asset_id)).status, 403);
});

// A live target's tunnel answers these paths with an empty 404 before the
// Worker sees them (scripts/deployment/routes.mjs admits an exact sha256
// only); a target without a tunnel reaches this refusal.
test("an asset path that names no asset is refused as JSON with a code, for every method", async (t) => {
  const f = await fixture(t);
  const message = "An asset id is the 64 lowercase hex characters an upload returned as asset_id";
  for (const asset of ["ABC", "A".repeat(64), "a".repeat(63), `${"a".repeat(64)}.parquet`])
    for (const method of ["GET", "POST"]) {
      const response = await worker.fetch(
        new Request(`http://127.0.0.1:9477/api/pages/${pageId}/assets/${asset}`, {
          method,
          headers: { authorization: f.bearer, "content-type": "application/json" },
          ...(method === "POST" && { body: JSON.stringify({ from_page_id: otherId }) }),
        }),
        f.env,
      );
      assert.equal(response.status, 400, `${method} ${asset}`);
      assert.deepEqual(
        await response.json(),
        { error: message, code: "invalid_arguments" },
        `${method} ${asset}`,
      );
      privateHeaders(response);
    }
  assert.equal(f.forwarded.length, 0, "no Page is asked about a malformed path");
});
