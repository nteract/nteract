import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import zlib from "node:zlib";
import worker, { Page } from "./index.mjs";
import { proposeAccessUpdate } from "./access.mjs";
import { cardKey, pageCard } from "../model/page-card.mjs";
import { PAGE_CARD_KEY } from "./page-card-writer.mjs";
import { cardBucket } from "./card-bucket-fixture.mjs";
import { world } from "./projects-fixture.mjs";
import {
  CARD_IMAGE_MAX_BYTES,
  CardImageGuard,
  cardImageKey,
  cardImagePointerKey,
  cardImageView,
  deleteCardImages,
  inspectCardImage,
  readCardImagePointer,
  storeCardImage,
} from "./card-images.mjs";
import { CARD_IMAGE_MAX_BYTES as SHARED_MAX_BYTES } from "../shared/card-images.mjs";

// Real rasters (the image-assets fixtures, encoded by Pillow).
const fixtures = {
  png: "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP07NrPAAZMEIqBgQEAHAoBlkMvCokAAAAASUVORK5CYII=",
  webp: "UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoDAAIAAUAmJaACdLoB+AAEyAAA/q4X/yU1/jblq/+QXq3zbGgAAA==",
  jpeg: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwBlFFFfQnzx/9k=",
};
const bytes = (kind) => new Uint8Array(Buffer.from(fixtures[kind], "base64"));
const TYPES = { png: "image/png", webp: "image/webp", jpeg: "image/jpeg" };

async function imagesWorld(t) {
  const w = await world(t);
  const assets = cardBucket();
  w.env.PAGES_ASSETS = assets;
  const tokens = {
    owner: w.auth.apiKey(),
    member: w.auth.apiKey({ userId: "member-user" }),
    stranger: w.auth.apiKey({ userId: "stranger-user" }),
    reader: w.auth.apiKey({ scopes: ["cloud:read"] }),
  };
  const settle = async () => {
    while (w.jobs.length) await Promise.allSettled(w.jobs.splice(0));
  };
  const hashOf = async (pageId) => (await pageCard(w.page(pageId).handle.doc())).card_hash;
  /** A Page with the JSON card its host would write on its first flush. */
  const create = async (title = "Plan", markdown = "# Goals\n\nShip card images.") => {
    const created = await w.createPage({ title, markdown });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await settle();
    const pageId = created.body.page_id;
    const card = await pageCard(w.page(pageId).handle.doc());
    await assets.seed(cardKey(pageId), card);
    await w.page(pageId).ctx.storage.put(PAGE_CARD_KEY, { card_hash: card.card_hash });
    return pageId;
  };
  const send = async (who, method, path, { body, type } = {}) => {
    const response = await worker.fetch(
      new Request(`https://pages.invalid${path}`, {
        method,
        headers: {
          authorization: `Bearer ${tokens[who]}`,
          ...(type && { "content-type": type }),
        },
        ...(body !== undefined && { body }),
      }),
      w.env,
    );
    await settle();
    return response;
  };
  const upload = async (who, pageId, { hash, theme = "light", kind = "webp", body, type } = {}) => {
    const response = await send(
      who,
      "PUT",
      `/api/pages/${pageId}/card-image?hash=${hash ?? (await hashOf(pageId))}&theme=${theme}`,
      { body: body ?? bytes(kind), type: type ?? TYPES[kind] },
    );
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: response.status, body: json, headers: response.headers };
  };
  return { w, assets, tokens, settle, hashOf, create, send, upload };
}

async function setRole(w, pageId, principal, role) {
  const host = w.page(pageId);
  const ownerIdentity = { principal: w.owner, canWrite: true, expiresAt: Date.now() + 60_000 };
  const acl = proposeAccessUpdate(host.metadata, ownerIdentity, {
    principal,
    role,
    expected_revision: host.metadata.acl?.revision ?? 0,
  }).acl;
  host.metadata = { ...host.metadata, acl };
  await host.ctx.storage.put("host/document", host.metadata);
}

const discover = (w, principal, pageId) =>
  w.catalogStorage(principal).put(`shared/${pageId}`, {
    page_id: pageId,
    title: "Shared",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    shared: true,
  });

test("the owner uploads both themes; the pointer names the hash once both land", async (t) => {
  const { w, assets, hashOf, create, send, upload } = await imagesWorld(t);
  const pageId = await create();
  const hash = await hashOf(pageId);
  const light = await upload("owner", pageId, { theme: "light", kind: "webp" });
  assert.equal(light.status, 201, JSON.stringify(light.body));
  assert.deepEqual(light.body, { card_hash: null, themes: { light: "webp" } });
  const dark = await upload("owner", pageId, { theme: "dark", kind: "png" });
  assert.equal(dark.status, 201, JSON.stringify(dark.body));
  assert.deepEqual(dark.body, { card_hash: hash, themes: { light: "webp", dark: "png" } });
  assert.ok(assets.objects.has(cardImageKey(pageId, hash, "light", "webp")));
  assert.ok(assets.objects.has(cardImageKey(pageId, hash, "dark", "png")));
  const stored = assets.objects.get(cardImageKey(pageId, hash, "dark", "png"));
  assert.equal(stored.httpMetadata.contentType, "image/png");
  assert.deepEqual(stored.customMetadata, { page_id: pageId, card_hash: hash, theme: "dark" });

  const pointer = await send("owner", "GET", `/api/pages/${pageId}/card-image`);
  assert.equal(pointer.status, 200);
  assert.equal(pointer.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await pointer.json(), { card_hash: hash });

  // page_cards names both images beside the JSON card of the same hash.
  const cards = await w.call("owner", "page_cards", { page_ids: [pageId] });
  assert.equal(cards.status, 200, JSON.stringify(cards.body));
  assert.deepEqual(cards.body.cards[pageId].image, {
    card_hash: hash,
    light: `/api/pages/${pageId}/card-image/${hash}-light.webp`,
    dark: `/api/pages/${pageId}/card-image/${hash}-dark.png`,
  });
  assert.equal(
    JSON.stringify(cards.body).includes(`pages/${pageId}/card/`),
    false,
    "no keys leave",
  );
});

test("only the owner uploads: editors, viewers, strangers and read-only keys are refused", async (t) => {
  const { w, assets, create, upload } = await imagesWorld(t);
  const pageId = await create();
  await setRole(w, pageId, w.member, "editor");
  const editor = await upload("member", pageId);
  assert.equal(editor.status, 403, JSON.stringify(editor.body));
  assert.equal(editor.body.code, "not_page_owner");
  await setRole(w, pageId, w.member, "viewer");
  assert.equal((await upload("member", pageId)).status, 403);
  const stranger = await upload("stranger", pageId);
  assert.ok([403, 404].includes(stranger.status), String(stranger.status));
  assert.equal((await upload("reader", pageId)).status, 403);
  assert.equal(assets.objects.has(cardImagePointerKey(pageId)), false);
  assert.equal(
    [...assets.objects.keys()].some((key) => key.includes("/card/")),
    false,
    "a refused upload stores nothing",
  );
});

test("the body must be a small WebP, PNG or JPEG, and the hash the host's current one", async (t) => {
  const { assets, hashOf, create, upload } = await imagesWorld(t);
  const pageId = await create();
  const svg = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  const refused = [
    [{ body: svg, type: "image/svg+xml" }, 415, "invalid_card_image"],
    [{ body: new Uint8Array(64).fill(7), type: "image/webp" }, 415, "invalid_card_image"],
    [{ body: new TextEncoder().encode("<html></html>"), type: "text/html" }, 415],
    [{ kind: "png", type: "image/webp" }, 415, "invalid_card_image"],
    [{ body: new Uint8Array(CARD_IMAGE_MAX_BYTES + 1), type: "image/webp" }, 413, undefined],
    [{ hash: "abc" }, 400, "invalid_card_image"],
    [{ hash: "A".repeat(64) }, 400, "invalid_card_image"],
    [{ theme: "sepia" }, 400, "invalid_card_image"],
    [{ hash: "0".repeat(64) }, 409, "card_image_stale"],
  ];
  for (const [options, status, code] of refused) {
    const answer = await upload("owner", pageId, options);
    assert.equal(answer.status, status, JSON.stringify({ options: Object.keys(options), answer }));
    if (code) assert.equal(answer.body.code, code);
    assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal(
    [...assets.objects.keys()].some((key) => key.includes("/card/")),
    false,
  );
  // A JPEG passes too, for a browser without a WebP or PNG choice.
  assert.equal((await upload("owner", pageId, { kind: "jpeg" })).status, 201);
  assert.ok(assets.objects.has(cardImageKey(pageId, await hashOf(pageId), "light", "jpg")));
});

test("each theme uploads at most once a minute", async (t) => {
  const { create, upload } = await imagesWorld(t);
  const pageId = await create();
  assert.equal((await upload("owner", pageId, { theme: "light" })).status, 201);
  const again = await upload("owner", pageId, { theme: "light" });
  assert.equal(again.status, 429);
  assert.equal(again.body.code, "card_image_rate_limited");
  assert.ok(Number(again.headers.get("retry-after")) > 0);
  assert.equal((await upload("owner", pageId, { theme: "dark" })).status, 201);
});

test("images are served only to readers, with private immutable caching", async (t) => {
  const { w, hashOf, create, send, upload } = await imagesWorld(t);
  const pageId = await create();
  const hash = await hashOf(pageId);
  await upload("owner", pageId, { theme: "light", kind: "webp" });
  await upload("owner", pageId, { theme: "dark", kind: "webp" });
  const path = `/api/pages/${pageId}/card-image/${hash}-light.webp`;
  const owned = await send("owner", "GET", path);
  assert.equal(owned.status, 200);
  assert.equal(owned.headers.get("content-type"), "image/webp");
  assert.equal(owned.headers.get("cache-control"), "private, max-age=86400, immutable");
  assert.equal(owned.headers.get("x-content-type-options"), "nosniff");
  assert.equal(owned.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.deepEqual(new Uint8Array(await owned.arrayBuffer()), bytes("webp"));
  assert.equal((await send("owner", "HEAD", path)).status, 200);

  const stranger = await send("stranger", "GET", path);
  assert.ok([403, 404].includes(stranger.status), String(stranger.status));
  assert.equal(stranger.headers.get("content-type")?.startsWith("image/"), false);
  // A grant alone isn't enough: the read is page_cards' decision, which also
  // needs the Page in the member's listing (her shared entry).
  await setRole(w, pageId, w.member, "viewer");
  assert.equal((await send("member", "GET", path)).status, 404);
  await discover(w, w.member, pageId);
  assert.equal((await send("member", "GET", path)).status, 200);
  assert.equal((await send("reader", "GET", path)).status, 200, "a read-only key reads");
  await setRole(w, pageId, w.member, null);
  const revoked = await send("member", "GET", path);
  assert.ok([403, 404].includes(revoked.status), String(revoked.status));

  for (const bad of [`${hash}-light.svg`, `${hash}-sepia.webp`, "latest", `../card.json`])
    assert.equal(
      (await send("owner", "GET", `/api/pages/${pageId}/card-image/${bad}`)).status,
      404,
      bad,
    );
  assert.equal(
    (await send("owner", "GET", `/api/pages/${pageId}/card-image/${hash}-dark.png`)).status,
    404,
  );
});

test("sequential first-screen uploads replace the images and remove the old hash", async (t) => {
  const { w, assets, hashOf, create, upload } = await imagesWorld(t);
  const pageId = await create();
  const first = await hashOf(pageId);
  await upload("owner", pageId, { theme: "light" });
  await upload("owner", pageId, { theme: "dark" });
  // The host's document moves on: a new title is a new first screen.
  const host = w.page(pageId);
  const renamed = A.change(host.handle.doc(), (draft) => {
    draft.title = "Renamed plan";
  });
  host.handle = { ...host.handle, doc: () => renamed };
  const second = await hashOf(pageId);
  assert.notEqual(second, first);
  // An upload for the old first screen is stale now.
  w.page(pageId).cardImageGuard = new CardImageGuard(0);
  assert.equal((await upload("owner", pageId, { hash: first, theme: "light" })).status, 409);
  assert.equal((await upload("owner", pageId, { theme: "light", kind: "png" })).status, 201);
  const keys = () => [...assets.objects.keys()].filter((key) => key.includes("/card/")).sort();
  assert.deepEqual(keys(), [
    cardImageKey(pageId, second, "light", "png"),
    cardImagePointerKey(pageId),
  ]);
  assert.equal((await upload("owner", pageId, { theme: "dark" })).status, 201);
  assert.deepEqual(keys(), [
    cardImageKey(pageId, second, "dark", "webp"),
    cardImageKey(pageId, second, "light", "png"),
    cardImagePointerKey(pageId),
  ]);
  // An accepted upload asked the host's card writer to catch up, so the
  // stored JSON card holds the new hash too and page_cards names the images.
  const answer = await w.call("owner", "page_cards", { page_ids: [pageId] });
  assert.equal(answer.body.cards[pageId].card_hash, second);
  assert.equal(answer.body.cards[pageId].image.card_hash, second);
  // A JSON card behind the images names none: the grid shows the JSON.
  await assets.seed(cardKey(pageId), { ...answer.body.cards[pageId], card_hash: first });
  const behind = await w.call("owner", "page_cards", { page_ids: [pageId] });
  assert.equal(behind.body.cards[pageId].image, undefined);
});

test("a trashed Page takes no upload, and a purge deletes its card images", async (t) => {
  const { w, assets, create, upload } = await imagesWorld(t);
  const pageId = await create();
  await upload("owner", pageId, { theme: "light" });
  await upload("owner", pageId, { theme: "dark" });
  // An orphan a lost race left behind goes too.
  await assets.put(`pages/${pageId}/card/${"e".repeat(64)}-light.webp`, bytes("webp"));
  const trashed = await w.call("owner", "delete_page", {
    page_id: pageId,
    nonce: w.key(),
  });
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  w.page(pageId).cardImageGuard = new CardImageGuard(0);
  const refused = await upload("owner", pageId, { theme: "light" });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "page_trashed");
  assert.ok(assets.objects.has(cardImagePointerKey(pageId)), "Trash keeps the images");
  const preview = await w.call("owner", "purge_page", { page_id: pageId, action: "preview" });
  const purged = await w.call("owner", "purge_page", {
    page_id: pageId,
    action: "confirm",
    preview_token: preview.body.preview_token,
    nonce: w.key(),
  });
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  while (w.jobs.length) await Promise.allSettled(w.jobs.splice(0));
  assert.deepEqual(
    [...assets.objects.keys()].filter((key) => key.startsWith(`pages/${pageId}/`)),
    [],
  );
});

test("a pointer swap refused by its fence reads again and keeps both themes", async () => {
  const assets = cardBucket();
  const pageId = "11111111-1111-4111-8111-111111111111";
  const hash = "a".repeat(64);
  await storeCardImage(assets, { pageId, hash, theme: "light", bytes: bytes("webp") });
  // Another upload of the same hash lands between this one's read and put.
  let raced = false;
  assets.beforePut = async (key) => {
    if (raced || key !== cardImagePointerKey(pageId)) return;
    raced = true;
    assets.beforePut = null;
    const current = await assets.head(key);
    await assets.put(key, "", {
      customMetadata: { ...current.customMetadata },
      onlyIf: { etagMatches: current.etag },
    });
  };
  const stored = await storeCardImage(assets, {
    pageId,
    hash,
    theme: "dark",
    bytes: bytes("png"),
    contentType: "image/png",
  });
  assert.ok(raced);
  assert.equal(assets.refused, 1);
  assert.deepEqual(stored.themes, { light: "webp", dark: "png" });
  const pointer = await readCardImagePointer(assets, pageId);
  assert.deepEqual(cardImageView(pageId, pointer), {
    card_hash: hash,
    light: `/api/pages/${pageId}/card-image/${hash}-light.webp`,
    dark: `/api/pages/${pageId}/card-image/${hash}-dark.png`,
  });
});

/** The 3×2 PNG fixture with its IHDR claiming `width`×`height` and a valid
 * CRC, so only the dimension check can refuse it. */
function sizedPng(width, height) {
  const png = bytes("png").slice();
  const view = new DataView(png.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, zlib.crc32(png.subarray(12, 29)));
  return png;
}

test("inspectCardImage reads each format and refuses an oversized body or side", () => {
  assert.equal(inspectCardImage(bytes("png")).ext, "png");
  assert.equal(inspectCardImage(bytes("webp")).ext, "webp");
  assert.equal(inspectCardImage(bytes("jpeg")).ext, "jpg");
  assert.equal(SHARED_MAX_BYTES, CARD_IMAGE_MAX_BYTES);
  assert.throws(() => inspectCardImage(new Uint8Array(CARD_IMAGE_MAX_BYTES + 1)), {
    status: 413,
    code: "card_image_too_large",
  });
  assert.deepEqual(
    { width: inspectCardImage(sizedPng(1600, 1200)).width, ext: "png" },
    { width: 1600, ext: "png" },
  );
  for (const [width, height] of [
    [1601, 10],
    [10, 1601],
  ])
    assert.throws(() => inspectCardImage(sizedPng(width, height)), {
      status: 413,
      code: "card_image_too_large",
      message: "Card image dimensions are too large",
    });
});

test("a 1601-pixel-wide upload is refused before the host's check", async (t) => {
  const { assets, create, upload } = await imagesWorld(t);
  const pageId = await create();
  const refused = await upload("owner", pageId, { body: sizedPng(1601, 10), type: "image/png" });
  assert.equal(refused.status, 413, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "card_image_too_large");
  // The refusal spent nothing: the next upload is admitted.
  assert.equal((await upload("owner", pageId)).status, 201);
  assert.ok(assets.objects.has(cardImagePointerKey(pageId)));
});

test("reading a card image boots no Page document", async (t) => {
  const { w, hashOf, create, send, upload } = await imagesWorld(t);
  const pageId = await create();
  const hash = await hashOf(pageId);
  await upload("owner", pageId, { theme: "light" });
  await upload("owner", pageId, { theme: "dark" });
  await setRole(w, pageId, w.member, "viewer");
  await discover(w, w.member, pageId);
  // Count what reaches this Page's host from here on.
  const boots = t.mock.method(Page.prototype, "documentReady");
  const reached = [];
  const getByName = w.env.PAGES.getByName;
  w.env.PAGES.getByName = (id) => {
    const target = getByName(id);
    return {
      fetch: (request, init) => {
        if (id === pageId) reached.push(new URL(request.url).pathname);
        return target.fetch(request, init);
      },
    };
  };
  const ofThisPage = () => boots.mock.calls.filter((call) => call.this?.ctx?.id?.name === pageId);
  const path = `/api/pages/${pageId}/card-image/${hash}-light.webp`;
  for (let i = 0; i < 3; i++) assert.equal((await send("owner", "GET", path)).status, 200);
  assert.equal((await send("owner", "GET", `/api/pages/${pageId}/card-image`)).status, 200);
  assert.deepEqual(reached, [], "the owner's reads never reach the Page host");
  assert.equal(ofThisPage().length, 0);
  // A member's read asks the host the shared-Page question only, the check
  // list_pages and page_cards already make. A cold host answers it from its
  // record without booting (page-startup-host.test.mjs); this fixture's host
  // is already booted, so it answers from the loaded document.
  assert.equal((await send("member", "GET", path)).status, 200);
  assert.deepEqual(reached, ["/internal/catalog"]);
  // And a revoked grant fails that check on the very next read.
  await setRole(w, pageId, w.member, null);
  assert.equal((await send("member", "GET", path)).status, 404);
  assert.deepEqual(reached, ["/internal/catalog", "/internal/catalog"]);
  assert.ok(
    !reached.includes("/internal/assets/authorize"),
    "no read goes through the host's full request path",
  );
});

test("a late upload for an older first screen never replaces a newer pointer", async () => {
  const assets = cardBucket();
  const pageId = "11111111-1111-4111-8111-111111111111";
  const H1 = "1".repeat(64);
  const H2 = "2".repeat(64);
  const store = (hash, theme, revision) =>
    storeCardImage(assets, { pageId, hash, theme, bytes: bytes("webp"), revision });
  // H1 was admitted (revision 1), then the Page moved on and H2 was
  // admitted twice (2, 3) and landed; H1's request reaches the bucket last.
  await store(H2, "light", 2);
  await store(H2, "dark", 3);
  await assert.rejects(store(H1, "light", 1), { status: 409, code: "card_image_stale" });
  const pointer = await readCardImagePointer(assets, pageId);
  assert.equal(pointer.card_hash, H2);
  assert.equal(pointer.revision, 3);
  assert.ok(assets.objects.has(cardImageKey(pageId, H2, "light", "webp")));
  assert.ok(assets.objects.has(cardImageKey(pageId, H2, "dark", "webp")));
  assert.ok(assets.objects.has(cardImageKey(pageId, H1, "light", "webp")));
  // Same-hash uploads merge in any order and keep the higher revision.
  await store(H2, "light", 2);
  assert.equal((await readCardImagePointer(assets, pageId)).revision, 3);
  // A newer first screen still replaces it.
  await store(H1, "light", 4);
  assert.equal((await readCardImagePointer(assets, pageId)).card_hash, H1);
});

test("a stale upload keeps a shared image key reused by newer accepted uploads", async () => {
  const assets = cardBucket();
  const pageId = "11111111-1111-4111-8111-111111111111";
  const H1 = "1".repeat(64);
  const H2 = "2".repeat(64);
  const store = (hash, theme, revision, image) =>
    storeCardImage(assets, { pageId, hash, theme, revision, bytes: image });
  await store(H2, "light", 2, bytes("webp"));
  await store(H2, "dark", 3, bytes("webp"));

  // Only the old upload's head response waits; later reads see the live pointer.
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  const head = assets.head;
  assets.head = async (key) => {
    const snapshot = await head.call(assets, key);
    if (key === cardImagePointerKey(pageId)) {
      assets.head = head;
      reached.resolve(snapshot);
      await release.promise;
    }
    return snapshot;
  };
  const older = assert.rejects(store(H1, "light", 1, bytes("png")), {
    status: 409,
    code: "card_image_stale",
  });
  const light = sizedPng(4, 2);
  const dark = bytes("webp");
  const lightKey = cardImageKey(pageId, H1, "light", "png");
  const darkKey = cardImageKey(pageId, H1, "dark", "webp");
  try {
    const snapshot = await reached.promise;
    assert.equal(snapshot.customMetadata.card_hash, H2);
    assert.equal(snapshot.customMetadata.revision, "3");
    assert.equal((await store(H1, "light", 4, light)).revision, 4);
    assert.equal((await store(H1, "dark", 5, dark)).revision, 5);
    assert.deepEqual(assets.objects.get(lightKey)?.bytes, light);
    assert.deepEqual(assets.objects.get(darkKey)?.bytes, dark);
  } finally {
    release.resolve();
  }
  await older;
  const pointer = await readCardImagePointer(assets, pageId);
  assert.equal(pointer.revision, 5);
  assert.deepEqual(cardImageView(pageId, pointer), {
    card_hash: H1,
    light: `/api/pages/${pageId}/card-image/${H1}-light.png`,
    dark: `/api/pages/${pageId}/card-image/${H1}-dark.webp`,
  });
  assert.deepEqual(assets.objects.get(lightKey)?.bytes, light);
  assert.deepEqual(assets.objects.get(darkKey)?.bytes, dark);
});

test("two first screens racing to the pointer: the older one loses even if its put is retried", async () => {
  const assets = cardBucket();
  const pageId = "11111111-1111-4111-8111-111111111111";
  const H1 = "1".repeat(64);
  const H2 = "2".repeat(64);
  // H1 (revision 1) reads the pointer first, then waits while H2 (revision 2)
  // swaps it; H1's fenced put is refused, it reads again and sees H2.
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  let first = true;
  assets.beforePut = async (key) => {
    if (key === cardImagePointerKey(pageId) && first) {
      first = false;
      reached.resolve();
      await release.promise;
    }
  };
  const older = storeCardImage(assets, {
    pageId,
    hash: H1,
    theme: "dark",
    bytes: bytes("webp"),
    revision: 1,
  });
  await reached.promise;
  try {
    await storeCardImage(assets, {
      pageId,
      hash: H2,
      theme: "light",
      bytes: bytes("webp"),
      revision: 2,
    });
  } finally {
    release.resolve();
  }
  await assert.rejects(older, { status: 409, code: "card_image_stale" });
  assert.equal(assets.refused, 1);
  const pointer = await readCardImagePointer(assets, pageId);
  assert.equal(pointer.card_hash, H2);
  assert.deepEqual([...assets.objects.keys()].filter((key) => key.includes("/card/")).sort(), [
    cardImageKey(pageId, H1, "dark", "webp"),
    cardImageKey(pageId, H2, "light", "webp"),
    cardImagePointerKey(pageId),
  ]);
  // H1 is not pointer-referenced; only the prefix listing can find its orphan.
  await deleteCardImages(assets, pageId);
  assert.equal(assets.objects.size, 0);
});

test("each admitted upload gets the host's next revision, kept in its storage", async (t) => {
  const { w, assets, create, upload } = await imagesWorld(t);
  const pageId = await create();
  await upload("owner", pageId, { theme: "light" });
  await upload("owner", pageId, { theme: "dark" });
  assert.equal(await w.page(pageId).ctx.storage.get("host/card-image-revision"), 2);
  assert.equal((await readCardImagePointer(assets, pageId)).revision, 2);
});

test("a purge that lands between the host's check and the write deletes what the write stored", async (t) => {
  const { w, assets, create, upload } = await imagesWorld(t);
  const pageId = await create();
  // The upload passes the host's check while the Page is active.
  let purged = null;
  assets.beforePut = async (key) => {
    if (purged || !key.endsWith("-light.webp")) return;
    // The image is about to land: the owner trashes and purges the Page.
    const again = await w.call("owner", "delete_page", {
      page_id: pageId,
      nonce: w.key(),
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const confirm = await w.call("owner", "purge_page", { page_id: pageId, action: "preview" });
    purged = await w.call("owner", "purge_page", {
      page_id: pageId,
      action: "confirm",
      preview_token: confirm.body.preview_token,
      nonce: w.key(),
    });
    while (w.jobs.length) await Promise.allSettled(w.jobs.splice(0));
  };
  const answer = await upload("owner", pageId, { theme: "light" });
  assert.equal(purged?.status, 200, JSON.stringify(purged?.body));
  assert.notEqual(answer.status, 201, JSON.stringify(answer.body));
  assert.deepEqual(
    [...assets.objects.keys()].filter((key) => key.startsWith(`pages/${pageId}/`)),
    [],
    "the cleanup after the write removed the image and its pointer",
  );
});
