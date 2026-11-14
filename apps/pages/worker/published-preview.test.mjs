import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.mjs";
import { world } from "./projects-fixture.mjs";
import { cardBucket } from "./card-bucket-fixture.mjs";
import { imageAssetKey } from "./image-assets.mjs";
import {
  PREVIEW_KEY,
  publicationTransition,
  publishedSnapshot,
  previewTags,
} from "./published-preview.mjs";

const origin = "https://pages.invalid";
const image = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=",
    "base64",
  ),
);
const asset = "a".repeat(64);
async function fixture(t) {
  const w = await world(t);
  w.env.PAGES_ASSETS = cardBucket();
  w.env.ASSETS = {
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/index.html")
        return new Response(null, { status: 307, headers: { location: "/" } });
      return new Response("<html><head><title>Pages</title></head><body>app</body></html>", {
        headers: { "content-type": "text/html", etag: "old" },
      });
    },
  };
  const created = await w.createPage({ title: "Secret actual title" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.page_id;
  await w.env.PAGES_ASSETS.put(imageAssetKey(id, asset), image);
  const token = w.auth.apiKey();
  const send = (path, options = {}) => worker.fetch(new Request(origin + path, options), w.env);
  const manage = (body, credential = token) =>
    send(`/api/link-preview?page=${id}`, {
      ...(body && { method: "POST", body: JSON.stringify(body) }),
      headers: credential
        ? { authorization: `Bearer ${credential}`, "content-type": "application/json" }
        : {},
    });
  const command = (revision = 0) => ({
    action: "publish",
    expected_revision: revision,
    nonce: crypto.randomUUID(),
    title: "Approved title",
    description: "Approved description",
    asset_id: asset,
  });
  return { w, id, send, manage, command };
}

test("private Pages get generic OG; only the owner can publish an independent snapshot", async (t) => {
  const { w, id, send, manage, command } = await fixture(t);
  let html = await (await send(`/p/${id}`)).text();
  assert.match(html, /og:title/);
  assert.doesNotMatch(html, /Secret actual title/);
  assert.equal((await send(`/p/${id}/preview.json`)).status, 404);
  assert.equal((await manage(command(), null)).status, 401);
  assert.equal((await manage(command(), w.auth.apiKey({ userId: "stranger" }))).status, 403);
  assert.equal((await manage(command(), w.auth.apiKey({ scopes: ["cloud:read"] }))).status, 403);
  const result = await manage(command());
  assert.equal(result.status, 200, await result.clone().text());
  const settings = await result.json();
  assert.equal(settings.revision, 1);
  html = await (await send(`/p/${id}`)).text();
  assert.match(html, /Approved title/);
  assert.doesNotMatch(html, /Secret actual title/);
  const slugged = await (await send(`/p/${id}/Unapproved-slug`)).text();
  assert.match(slugged, /Approved title/);
  assert.doesNotMatch(slugged, /Unapproved slug|Secret actual title/);
  const preview = await send(`/p/${id}/preview.json`);
  assert.equal(preview.headers.get("cache-control"), "no-store");
  const body = await preview.json();
  assert.deepEqual(Object.keys(body).sort(), ["description", "image_url", "published_at", "title"]);
  const png = await send(new URL(body.image_url).pathname + new URL(body.image_url).search);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await png.arrayBuffer()), image);
  assert.equal((await send(`/api/pages/${id}/assets/${asset}`)).status, 401);
  assert.equal((await send(`/p/${id}/meta.json`)).status, 401);
  const head = await send(`/p/${id}`, { method: "HEAD" });
  assert.equal(await head.text(), "");
  assert.equal(head.headers.has("etag"), false);
});

test("snapshot updates are fenced; replay is safe; unpublishing revokes old image URLs", async (t) => {
  const { id, send, manage, command } = await fixture(t);
  const first = command();
  assert.equal((await manage(first)).status, 200);
  assert.equal((await manage(first)).status, 200);
  assert.equal((await manage({ ...first, title: "Different" })).status, 409);
  assert.equal((await manage(command())).status, 409);
  const second = command(1);
  second.title = "New approved title";
  assert.equal((await manage(second)).status, 200);
  assert.equal((await send(`/p/${id}/preview.png?v=1`)).status, 404);
  assert.equal((await send(`/p/${id}/preview.png?v=2`)).status, 200);
  assert.equal(
    (await manage({ action: "unpublish", expected_revision: 2, nonce: crypto.randomUUID() }))
      .status,
    200,
  );
  assert.equal((await send(`/p/${id}/preview.png?v=2`)).status, 404);
  assert.equal((await send(`/p/${id}/preview.json`)).status, 404);
  assert.equal((await manage(second)).status, 409);
});

test("unknown, cross-Page, and non-image assets never publish; escaping prevents OG injection", async (t) => {
  const { w, id, manage, command, send } = await fixture(t);
  assert.equal((await manage({ ...command(), asset_id: "b".repeat(64) })).status, 400);
  await w.env.PAGES_ASSETS.put(
    imageAssetKey(id, "b".repeat(64)),
    new TextEncoder().encode("<svg onload='alert(1)'/>"),
  );
  assert.equal((await manage({ ...command(), asset_id: "b".repeat(64) })).status, 415);
  assert.equal((await manage({ ...command(), title: "x".repeat(161) })).status, 400);
  assert.equal((await manage({ ...command(), title: '"><script>alert(1)</script>' })).status, 200);
  const html = await (await send(`/p/${id}`)).text();
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("trash and restore cannot resurrect a published snapshot", async (t) => {
  const { w, id, manage, command, send } = await fixture(t);
  assert.equal((await manage(command())).status, 200);
  const trashed = await w.call("owner", "delete_page", {
    page_id: id,
    nonce: w.key(),
  });
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  assert.equal((await send(`/p/${id}/preview.json`)).status, 404);
  const restored = await w.call("owner", "restore_page", { page_id: id, nonce: w.key() });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal((await send(`/p/${id}/preview.json`)).status, 404);
  assert.equal((await manage()).status, 200);
  assert.equal((await (await manage()).json()).snapshot, null);
  assert.equal((await manage(command(1))).status, 200);
});

test("an uncertain publication barrier never exposes a snapshot; retry keeps its revision", async (t) => {
  const { w, id, manage, command, send } = await fixture(t);
  const storage = w.page(id).ctx.storage;
  const sync = storage.sync.bind(storage);
  let fail = false;
  t.mock.method(storage, "sync", async () => {
    if (fail) throw Error("storage unavailable");
    await sync();
  });
  const put = storage.put.bind(storage);
  t.mock.method(storage, "put", async (key, value) => {
    await put(key, value);
    if (key === PREVIEW_KEY) fail = true;
  });
  const publish = command();
  assert.equal((await manage(publish)).status, 500);
  assert.equal((await send(`/p/${id}/preview.json`)).status, 404);
  fail = false;
  t.mock.method(storage, "put", put);
  const replay = await manage(publish);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).revision, 1);
  assert.equal((await send(`/p/${id}/preview.json`)).status, 200);
});

test("publication state/event matrix and lifecycle fence", () => {
  for (const name of ["published", "unpublished"])
    for (const action of ["publish", "unpublish"]) {
      const snapshot = { owner: "owner", lifecycle_revision: 4 };
      const state = publicationTransition(
        { name, revision: 2 },
        { action, expected_revision: 2, nonce: "abcdefghijklmnop" },
        snapshot,
      );
      assert.equal(state.name, action === "publish" ? "published" : "unpublished");
      assert.equal(state.revision, 3);
      assert.equal(publishedSnapshot({ owner: "owner", lifecycleRevision: 5 }, state), null);
    }
  assert.doesNotMatch(previewTags(origin, "id", null), /og:image/);
});
