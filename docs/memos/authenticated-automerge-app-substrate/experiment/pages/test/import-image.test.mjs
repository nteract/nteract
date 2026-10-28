import assert from "node:assert/strict";
import { test } from "node:test";
import { handleImportPageImage, IMAGE_IMPORT_TIMEOUT_MS } from "../worker/import-image.mjs";
import { IMAGE_MAX_BYTES } from "../shared/image-assets.mjs";
import { persistImageAsset, requireStoredImageAsset } from "../worker/image-assets.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const downloadUrl = "https://files.oaiusercontent.com/file-fixture?sig=temporary-secret";
// Actual 3x2 PNG, also exercised by the browser/API-key asset tests.
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=",
    "base64",
  ),
);
const descriptor = (overrides = {}) => ({
  download_url: downloadUrl,
  file_id: "file-fixture",
  mime_type: "image/png",
  file_name: "cat.png",
  ...overrides,
});
const request = (signal) =>
  new Request("https://page7.runtimed.run/mcp", {
    method: "POST",
    headers: { authorization: "Bearer private-pages-token", cookie: "private-cookie=value" },
    ...(signal && { signal }),
  });

class Bucket {
  objects = new Map();
  writes = 0;
  async head(key) {
    return this.objects.get(key) ?? null;
  }
  async put(key, bytes, options) {
    this.writes++;
    assert.deepEqual(options.onlyIf, { etagDoesNotMatch: "*" });
    if (this.objects.has(key)) return null;
    const object = { key, bytes: bytes.slice(), size: bytes.length, ...options };
    this.objects.set(key, object);
    return object;
  }
}

function setup(t, { fetchImage, authorize } = {}) {
  const env = { PAGES_ASSETS: new Bucket() };
  const calls = { fetch: [], authorize: [], logs: [] };
  t.mock.method(console, "error", (...args) => calls.logs.push(args));
  t.mock.method(globalThis, "fetch", async (...args) => {
    calls.fetch.push(args);
    return fetchImage
      ? fetchImage(...args)
      : new Response(png, { headers: { "content-type": "image/png" } });
  });
  return {
    env,
    calls,
    run(overrides = {}) {
      return handleImportPageImage(overrides.request ?? request(), env, {
        pageId,
        file: descriptor(),
        async authorize(write) {
          calls.authorize.push(write);
          return authorize ? authorize(calls.authorize.length) : Response.json({ page_id: pageId });
        },
        ...overrides,
      });
    },
  };
}

test("imports original bytes privately without forwarding credentials or retaining the signed URL", async (t) => {
  const f = setup(t);
  const response = await f.run();
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const asset = await response.json();
  assert.match(asset.asset_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(asset, {
    page_id: pageId,
    asset_id: asset.asset_id,
    asset_url: `/api/pages/${pageId}/assets/${asset.asset_id}`,
    mime_type: "image/png",
    width: 3,
    height: 2,
    size: png.length,
  });
  assert.deepEqual(f.calls.authorize, [true, true]);
  const [[url, options]] = f.calls.fetch;
  assert.equal(url, downloadUrl);
  assert.equal(options.redirect, "error");
  assert.equal(options.credentials, "omit");
  assert.equal(options.referrerPolicy, "no-referrer");
  const headers = new Headers(options.headers);
  assert.deepEqual([...headers.keys()], ["accept"]);
  const [stored] = f.env.PAGES_ASSETS.objects.values();
  assert.deepEqual(stored.bytes, png);
  assert.equal(stored.httpMetadata.cacheControl, "private, no-store");
  for (const record of [asset, stored, f.calls.logs]) {
    const serialized = JSON.stringify(record);
    assert.equal(serialized.includes("temporary-secret"), false);
    assert.equal(serialized.includes("file-fixture"), false);
    assert.equal(serialized.includes("cat.png"), false);
  }
});

test("same-content retries deduplicate even when ChatGPT renews the download URL", async (t) => {
  const f = setup(t);
  const first = await (await f.run()).json();
  const repeated = await f.run({
    file: descriptor({ download_url: "https://files.oaiusercontent.com/file-new?sig=renewed" }),
  });
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), first);
  assert.equal(f.env.PAGES_ASSETS.objects.size, 1);
  assert.equal(f.env.PAGES_ASSETS.writes, 1);
});

test("byte uploads and ChatGPT handoffs resolve to the same validated private asset", async (t) => {
  const f = setup(t);
  // Raw uploads use this identical storage boundary after their own authentication.
  const { asset: uploaded } = await persistImageAsset(f.env.PAGES_ASSETS, {
    pageId,
    bytes: png,
    contentTypes: ["image/png"],
  });
  const response = await f.run();
  assert.equal(response.status, 200);
  const imported = await response.json();
  assert.equal(imported.asset_id, uploaded.asset_id);
  assert.equal(imported.asset_url, uploaded.url);
  const { page_id, ...metadata } = imported;
  assert.equal(page_id, pageId);
  assert.deepEqual(
    await requireStoredImageAsset(f.env.PAGES_ASSETS, { pageId, assetId: imported.asset_id }),
    metadata,
  );
  assert.equal(f.env.PAGES_ASSETS.writes, 1);
});

test("Page/grant denial prevents any download or storage operation", async (t) => {
  const f = setup(t, { authorize: () => Response.json({ error: "No access" }, { status: 403 }) });
  assert.equal((await f.run()).status, 403);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.env.PAGES_ASSETS.objects.size, 0);
});

test("revocation during transfer suppresses the resulting asset reference", async (t) => {
  const f = setup(t, {
    authorize: (call) =>
      call === 1
        ? Response.json({ page_id: pageId })
        : Response.json({ error: "Access revoked" }, { status: 403 }),
  });
  const response = await f.run();
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access revoked" });
  assert.deepEqual(f.calls.authorize, [true, true]);
  // An immutable orphan is harmless: reads still require the Page's current ACL.
  assert.equal(f.env.PAGES_ASSETS.objects.size, 1);
});

test("validates the file descriptor and exact HTTPS download host before network access", async (t) => {
  const f = setup(t);
  const invalid = [
    null,
    [],
    {},
    descriptor({ file_id: "" }),
    descriptor({ file_id: "x".repeat(257) }),
    descriptor({ download_url: "x".repeat(8193) }),
    descriptor({ file_name: "x".repeat(513) }),
    descriptor({ mime_type: "x".repeat(128) }),
    descriptor({ extra: "unsupported" }),
    ...[
      "http://files.oaiusercontent.com/file",
      "https://files.oaiusercontent.com:444/file",
      "https://files.oaiusercontent.com.attacker.example/file",
      "https://attacker.example/file",
      "https://127.0.0.1/file",
      "https://files.oaiusercontent.com@127.0.0.1/file",
      "https://user:password@files.oaiusercontent.com/file",
      "https://files.oaiusercontent.com/file#fragment",
      "https://files.oaiusercontent.com/file#",
      "https://files.oaiusercontent.com\\@attacker.example/file",
      " https://files.oaiusercontent.com/file",
      "https://files.oaiusercontent.com/file\n",
      "data:image/png;base64,AA==",
    ].map((download_url) => descriptor({ download_url })),
  ];
  for (const file of invalid) assert.equal((await f.run({ file })).status, 400);
  assert.equal((await f.run({ pageId: "bad-page-id" })).status, 400);
  assert.equal(f.calls.fetch.length, 0);
  assert.equal(f.calls.authorize.length, 0);
});

test("accepts explicit default HTTPS port and a minimal file descriptor", async (t) => {
  const f = setup(t);
  const response = await f.run({
    file: { download_url: "https://files.oaiusercontent.com:443/file", file_id: "file-fixture" },
  });
  assert.equal(response.status, 201);
});

test("rejects redirects and HTTP failures, cancels their bodies, and never persists them", async (t) => {
  let canceled = 0,
    status = 302;
  const f = setup(t, {
    fetchImage: () =>
      new Response(new ReadableStream({ cancel: () => canceled++ }), {
        status,
        headers: { location: "https://internal.example/secret" },
      }),
  });
  assert.equal((await f.run()).status, 400);
  status = 403;
  assert.equal((await f.run()).status, 502);
  assert.equal(canceled, 2);
  assert.equal(f.env.PAGES_ASSETS.objects.size, 0);
});

test("sanitizes fetch and stream errors containing signed URLs", async (t) => {
  let failFetch = true;
  const f = setup(t, {
    fetchImage() {
      if (failFetch) throw new Error(`Fetch failed: ${downloadUrl}`);
      return new Response(
        new ReadableStream({ start: (controller) => controller.error(new Error(downloadUrl)) }),
      );
    },
  });
  for (const mode of [true, false]) {
    failFetch = mode;
    const response = await f.run();
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Pages request failed" });
  }
  assert.equal(JSON.stringify(f.calls.logs).includes("temporary-secret"), false);
  assert.equal(f.env.PAGES_ASSETS.objects.size, 0);
});

test("times out a stalled fetch and aborts the upstream request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = setup(t, { fetchImage: () => new Promise(() => {}) });
  const pending = f.run();
  await new Promise(setImmediate);
  t.mock.timers.tick(IMAGE_IMPORT_TIMEOUT_MS);
  assert.equal((await pending).status, 504);
  assert.equal(f.calls.fetch[0][1].signal.aborted, true);
  assert.equal(f.env.PAGES_ASSETS.objects.size, 0);
});

test("a fetch completing after the deadline is canceled without processing its bytes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let completeFetch,
    canceled = false;
  const f = setup(t, {
    fetchImage: () => new Promise((resolve) => (completeFetch = resolve)),
  });
  const pending = f.run();
  await new Promise(setImmediate);
  t.mock.timers.tick(IMAGE_IMPORT_TIMEOUT_MS);
  assert.equal((await pending).status, 504);
  completeFetch(new Response(new ReadableStream({ cancel: () => (canceled = true) })));
  await new Promise(setImmediate);
  assert.equal(canceled, true);
  assert.equal(f.env.PAGES_ASSETS.objects.size, 0);
  assert.deepEqual(f.calls.authorize, [true]);
});

test("one deadline covers a stalled body and cancels the body stream", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let canceled = false;
  const f = setup(t, {
    fetchImage: () => new Response(new ReadableStream({ cancel: () => (canceled = true) })),
  });
  const pending = f.run();
  await new Promise(setImmediate);
  t.mock.timers.tick(IMAGE_IMPORT_TIMEOUT_MS);
  assert.equal((await pending).status, 504);
  assert.equal(canceled, true);
  assert.equal(f.env.PAGES_ASSETS.objects.size, 0);
});

test("caller cancellation stops downloading without persisting", async (t) => {
  const controller = new AbortController();
  let canceled = false;
  const f = setup(t, {
    fetchImage: () => new Response(new ReadableStream({ cancel: () => (canceled = true) })),
  });
  const pending = f.run({ request: request(controller.signal) });
  await new Promise(setImmediate);
  controller.abort(new Error("private caller details"));
  const response = await pending;
  assert.equal(response.status, 408);
  assert.deepEqual(await response.json(), { error: "Image import canceled" });
  assert.equal(canceled, true);
  assert.equal(f.env.PAGES_ASSETS.objects.size, 0);
});

test("oversized declared and streamed bodies are canceled before storage", async (t) => {
  let declared = true,
    canceled = 0;
  const f = setup(t, {
    fetchImage: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            if (!declared) controller.enqueue(new Uint8Array(IMAGE_MAX_BYTES + 1));
          },
          cancel: () => canceled++,
        }),
        { headers: declared ? { "content-length": String(IMAGE_MAX_BYTES + 1) } : {} },
      ),
  });
  assert.equal((await f.run()).status, 413);
  declared = false;
  assert.equal((await f.run()).status, 413);
  assert.equal(canceled, 2);
  assert.equal(f.env.PAGES_ASSETS.objects.size, 0);
});

test("requires real image bytes matching both the response and file MIME types", async (t) => {
  let body = png,
    contentType = "image/jpeg";
  const f = setup(t, {
    fetchImage: () => new Response(body, { headers: { "content-type": contentType } }),
  });
  assert.equal((await f.run()).status, 415);
  contentType = "image/png";
  assert.equal((await f.run({ file: descriptor({ mime_type: "image/jpeg" }) })).status, 415);
  body = new TextEncoder().encode("<svg><script>not an image</script></svg>");
  assert.equal((await f.run()).status, 415);
  assert.equal(f.env.PAGES_ASSETS.objects.size, 0);
});

test("the same raster dimension limit applies to imported images", async (t) => {
  const oversized = new Uint8Array(
    Buffer.from(
      "UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoDAAIAAUAmJaACdLoB+AAEyAAA/q4X/yU1/jblq/+QXq3zbGgAAA==",
      "base64",
    ),
  );
  oversized[26] = 0xff;
  oversized[27] = 0x3f;
  const f = setup(t, { fetchImage: () => new Response(oversized) });
  assert.equal((await f.run({ file: descriptor({ mime_type: "image/webp" }) })).status, 413);
  assert.equal(f.env.PAGES_ASSETS.objects.size, 0);
});

test("storage failure cannot return an asset reference or upstream file metadata", async (t) => {
  const f = setup(t);
  f.env.PAGES_ASSETS.put = async () => {
    throw new Error(`storage failed: ${downloadUrl}`);
  };
  const response = await f.run();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Pages request failed" });
  assert.equal(JSON.stringify(f.calls.logs).includes("temporary-secret"), false);
});
