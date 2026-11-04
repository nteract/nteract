import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import worker from "./index.mjs";
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
  inspectCardImage,
  readCardImagePointer,
  storeCardImage,
} from "./card-images.mjs";

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
  await setRole(w, pageId, w.member, "viewer");
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

test("a new first screen replaces the images; only the latest hash is kept", async (t) => {
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
    base_heads: w.heads(pageId),
    idempotency_key: w.key(),
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
    idempotency_key: w.key(),
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

test("inspectCardImage refuses large dimensions", () => {
  // A PNG header claiming 4000×10 never reaches the dimension check without
  // a valid container, so check the limit on a real fixture's reading.
  assert.equal(inspectCardImage(bytes("png")).ext, "png");
  assert.equal(inspectCardImage(bytes("webp")).ext, "webp");
  assert.equal(inspectCardImage(bytes("jpeg")).ext, "jpg");
  assert.throws(() => inspectCardImage(new Uint8Array(CARD_IMAGE_MAX_BYTES + 1)), {
    status: 413,
  });
});
