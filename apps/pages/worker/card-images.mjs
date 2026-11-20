// Grid card images: a raster of a Page's first screen, one per theme, drawn
// by the owner's own browser (viewer/card-capture.mjs) and shown in the
// library grid in place of the JSON card (model/page-card.mjs) when both
// were built from the same `card_hash`. The owner's library also redraws a
// stored image larger than a capture and uploads it through the same route,
// hash and theme (viewer/card-shrink.mjs).
//
// Storage, in the Page assets bucket:
//
// - `pages/<id>/card/<card_hash>-<theme>.<ext>`: the image. `ext` is webp,
//   png or jpg; Safari has no WebP encoder, so its captures are PNG.
// - `pages/<id>/card.json`: the JSON card, whose `customMetadata` also holds
//   the image record: `image_hash`, `image_revision` and each theme's
//   extension (`light`, `dark`). One `get` answers the card and its image.
//   The card writer (page-card-writer.mjs) owns the body and the card fields;
//   an upload owns the image fields. Each puts a new version fenced on the
//   etag of the version it read (`onlyIf`), copying the other's part from
//   it, and retries after a refusal, so neither drops the other's write.
//   An upload for a Page with no card yet creates the object with the body
//   `null`, which reads as no card.
// - `pages/<id>/card/latest`: the legacy pointer, an empty object whose
//   `customMetadata` holds the same record. A `card.json` without
//   `image_revision` is the legacy shape: readers fall back to the pointer,
//   and the next card write or upload copies its record into `card.json`.
//   Nothing writes the pointer; purge deletes it.
//
// The record references at most two images, one per theme. An upload for a
// new hash swaps the record, then attempts to delete the old images. Stale
// uploads and failed writes or deletes can leave unreferenced bytes. Purge
// scans at most four prefix-listing pages; it may not collect every orphan.
// Successful-swap cleanup is not fenced and can still race with key reuse.
//
// Who writes. Only the Page owner, checked by the Page host's own policy
// (`authorizeCardImageUpload`, run inside the Page object), never D1. The
// host also requires the upload's hash to be the `card_hash` of its loaded
// document, so a capture of an older first screen is refused, and allows one
// upload per theme per minute. Each admitted upload gets the host's next
// revision, and the record refuses a swap to an older one (storeCardImage).
// The server can't check that the pixels match
// the content: that is the same trust as an image the owner inserts into the
// Page, and only people who can read the Page see it.
//
// Who reads. `GET /api/pages/:id/card-image/<hash>-<theme>.<ext>` decides
// access as page_cards does, on every request, without loading the Page's
// document (handleCardImage), and streams the object with a private,
// immutable cache header: the hash is in the URL. No object URL leaves the
// Worker. `page_cards` names an image only when the record's hash
// is the stored JSON card's and both themes exist.
import { authenticate, HttpError, errorResponse } from "./auth.mjs";
import { cardKey } from "../model/page-card.mjs";
import { validPageId } from "./registration.mjs";
import { setResponseHeaders } from "./response-headers.mjs";
import { inspectImage, readImageBody } from "./image-assets.mjs";
import { CARD_IMAGE_MAX_BYTES } from "../shared/card-images.mjs";
import { timingFor } from "./server-timing.mjs";

export { CARD_IMAGE_MAX_BYTES };
/** The largest side an upload may have. Captures are 640×480
 * (viewer/card-raster.mjs); stored 1280×960 images stay readable until the
 * owner's library redraws them at 640×480 (viewer/card-shrink.mjs). */
export const CARD_IMAGE_MAX_DIMENSION = 1600;
export const CARD_IMAGE_THEMES = Object.freeze(["light", "dark"]);
/** The shortest gap between two uploads of one theme of one Page. */
export const CARD_IMAGE_UPLOAD_GAP_MS = 60_000;
/** How long a reader's browser keeps an image. The URL names its hash, so a
 * kept copy is never stale; this only bounds how long a removed member's own
 * cache still holds one they already saw. */
export const CARD_IMAGE_MAX_AGE_S = 86_400;
const EXTENSIONS = Object.freeze({ "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" });
const MEDIA_TYPES = Object.freeze(
  Object.fromEntries(Object.entries(EXTENSIONS).map(([type, ext]) => [ext, type])),
);
const HASH = /^[0-9a-f]{64}$/;
/** One image's file name in its URL. The gateway answers this shape only;
 * the live tunnels hand every non-refused path to the Worker
 * (scripts/deployment/routes.mjs refusedPaths). */
export const CARD_IMAGE_FILE = /^([0-9a-f]{64})-(light|dark)\.(webp|png|jpg)$/;
/** The Page host's storage key for its last card image revision. */
export const CARD_IMAGE_REVISION_KEY = "host/card-image-revision";
/** How many times a record swap re-reads after its put was refused. */
const RECORD_ATTEMPTS = 3;

export const validCardHash = (value) => typeof value === "string" && HASH.test(value);
export const validCardTheme = (value) => CARD_IMAGE_THEMES.includes(value);
export const cardImagePrefix = (pageId) => `pages/${pageId}/card/`;
export const cardImagePointerKey = (pageId) => `${cardImagePrefix(pageId)}latest`;
export const cardImageKey = (pageId, hash, theme, ext) =>
  `${cardImagePrefix(pageId)}${hash}-${theme}.${ext}`;
export const cardImageUrl = (pageId, hash, theme, ext) =>
  `/api/pages/${pageId}/card-image/${hash}-${theme}.${ext}`;

/** The upload's media type and extension. Refuses anything but a static
 * WebP, PNG or JPEG (inspectImage reads the container, so SVG, HTML or a
 * renamed file never passes), and anything larger than a card. */
export function inspectCardImage(bytes) {
  if (bytes.byteLength > CARD_IMAGE_MAX_BYTES)
    throw new HttpError(413, "Card images must be 300 KB or smaller", "card_image_too_large");
  let inspected;
  try {
    inspected = inspectImage(bytes);
  } catch (error) {
    if (error?.status === 415)
      throw new HttpError(415, "Use a WebP, PNG or JPEG card image", "invalid_card_image");
    throw error;
  }
  if (inspected.width > CARD_IMAGE_MAX_DIMENSION || inspected.height > CARD_IMAGE_MAX_DIMENSION)
    throw new HttpError(413, "Card image dimensions are too large", "card_image_too_large");
  return { ...inspected, ext: EXTENSIONS[inspected.mime_type] };
}

/** `inspected`, when a claimed Content-Type agrees with the bytes. */
function matchesContentType(inspected, contentType) {
  const claimed = contentType?.split(";")[0].trim().toLowerCase();
  if (claimed && claimed !== "application/octet-stream" && claimed !== inspected.mime_type)
    throw new HttpError(415, "Image bytes do not match Content-Type", "invalid_card_image");
  return inspected;
}

/** A record `{ card_hash, revision, themes }` from its stored fields. A
 * theme whose extension isn't one this build writes counts as missing. */
function imageRecord(hash, revision, metadata) {
  const themes = {};
  for (const theme of CARD_IMAGE_THEMES)
    if (MEDIA_TYPES[metadata[theme]]) themes[theme] = metadata[theme];
  const number = Number(revision);
  return {
    card_hash: validCardHash(hash) ? hash : null,
    revision: Number.isSafeInteger(number) && number > 0 ? number : 0,
    themes,
  };
}

/** The legacy pointer's record, or null. */
export async function readCardImagePointer(bucket, pageId) {
  const object = await bucket.head(cardImagePointerKey(pageId));
  if (!object) return null;
  const metadata = object.customMetadata ?? {};
  return imageRecord(metadata.card_hash, metadata.revision, metadata);
}

/** The image record a card object's `customMetadata` holds, or undefined
 * for the legacy shape (no object, or no `image_revision`), whose record is
 * the pointer's. */
export function cardImageRecordOf(metadata) {
  if (typeof metadata?.image_revision !== "string") return undefined;
  return imageRecord(metadata.image_hash, metadata.image_revision, metadata);
}

/** The `customMetadata` fields that store `record` (null: none). */
export function cardImageMetadata(record) {
  return {
    image_hash: record?.card_hash ?? "",
    image_revision: String(record?.revision ?? 0),
    light: record?.themes?.light ?? "",
    dark: record?.themes?.dark ?? "",
  };
}

/**
 * The image record of a card object whose `customMetadata` is `metadata`
 * (undefined: no object): its own, or the legacy pointer's when it holds
 * none. Only the legacy shape reads the bucket; `measure(read)` wraps that
 * read, for timing.
 */
export async function readCardImageRecord(bucket, pageId, metadata, measure = (read) => read()) {
  return cardImageRecordOf(metadata) ?? (await measure(() => readCardImagePointer(bucket, pageId)));
}

/** What a reader learns about a record: its hash only when every theme is
 * stored, and the image URLs. */
export function cardImageView(pageId, pointer) {
  const complete =
    !!pointer?.card_hash && CARD_IMAGE_THEMES.every((theme) => pointer.themes[theme]);
  if (!complete) return null;
  return {
    card_hash: pointer.card_hash,
    ...Object.fromEntries(
      CARD_IMAGE_THEMES.map((theme) => [
        theme,
        cardImageUrl(pageId, pointer.card_hash, theme, pointer.themes[theme]),
      ]),
    ),
  };
}

/** page_cards' bucket reads (page-cards.mjs readPageCards): the card
 * object with its metadata, and the image view of its record. A current card
 * object is one read; a legacy one adds the pointer's. `measure(read)` wraps
 * each bucket read, for timing. */
export function cardObjectReaders(bucket, measure = (read) => read()) {
  return {
    readObject: (key) =>
      measure(async () => {
        const object = await bucket.get(key);
        return object ? { text: await object.text(), metadata: object.customMetadata ?? {} } : null;
      }),
    readImage: async (pageId, metadata) =>
      cardImageView(pageId, await readCardImageRecord(bucket, pageId, metadata, measure)),
  };
}

/**
 * The card writer's store (page-card-writer.mjs) over `card.json`, without
 * its deadlines. `head()` answers the card fields and the image record (a
 * legacy object, or none, takes the legacy pointer's); `put()` writes the
 * card with the record it is given, fenced on `etag`.
 */
export function cardObjectStore(bucket, pageId) {
  return {
    head: async () => {
      const object = await bucket.head(cardKey(pageId));
      const metadata = object?.customMetadata;
      return {
        etag: object?.etag ?? null,
        card_hash: metadata?.card_hash || null,
        content_updated_at: metadata?.content_updated_at ?? null,
        image: await readCardImageRecord(bucket, pageId, metadata),
      };
    },
    put: async (bundle, { etag, image }) => {
      const object = await bucket.put(cardKey(pageId), JSON.stringify(bundle), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          card_hash: bundle.card_hash,
          content_updated_at: bundle.content_updated_at ?? "",
          ...cardImageMetadata(image),
        },
        // The fence card image uploads share; head() reads every field back.
        onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
      });
      return object ? { etag: object.etag } : null;
    },
  };
}

/**
 * Store one theme's image for `hash` and record it in `card.json`. Returns
 * the record it wrote. Authorization belongs to the caller.
 *
 * The image lands before the record swap. The swap reads `card.json` (body
 * and metadata), then puts the same body and card fields with the new
 * record, fenced on the etag it read; a refused put reads again, up to
 * RECORD_ATTEMPTS times. A card write that lands in between is kept: the
 * retry copies it. A legacy `card.json` (or none) starts from the legacy
 * pointer's record. Once the swap lands, images the previous record named
 * and this one doesn't are deleted. That cleanup is not fenced against a
 * newer upload reusing those keys.
 *
 * The etag orders writes to the bucket, not first screens. `revision` does:
 * the Page host hands out one per admitted upload, in order, from durable
 * storage, and admits only its current `card_hash`, so a later revision is
 * always a later (or the same) first screen. The record keeps the highest
 * revision it has seen, and a swap to another hash with a lower revision is
 * refused as stale (409), without deleting the shared image key. Uploads of
 * the same hash merge whatever their order.
 *
 * A re-upload of the same hash and theme overwrites its key when the
 * extension matches, and the new record keeps that key, so the cleanup never
 * deletes it. With another extension (a PNG redrawn as WebP), the record
 * names the new key and the cleanup deletes the old one.
 */
export async function storeCardImage(
  bucket,
  { pageId, hash, theme, bytes, contentType, revision = 0 },
) {
  const inspected = matchesContentType(inspectCardImage(bytes), contentType);
  const imageKey = cardImageKey(pageId, hash, theme, inspected.ext);
  await bucket.put(imageKey, bytes, {
    httpMetadata: { contentType: inspected.mime_type, cacheControl: "private, no-store" },
    customMetadata: { page_id: pageId, card_hash: hash, theme },
  });
  for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
    const card = await bucket.get(cardKey(pageId));
    const metadata = card?.customMetadata ?? {};
    const body = card ? await card.text() : "null";
    const previous = await readCardImageRecord(bucket, pageId, card ? metadata : undefined);
    const same = previous?.card_hash === hash;
    if (previous && !same && previous.revision > revision) {
      // The hash/theme key is shared: a newer accepted upload may already
      // reuse it. This stale record cannot authorize its deletion.
      throw new HttpError(409, "This card image is for an older first screen", "card_image_stale");
    }
    const themes = { ...(same ? previous.themes : {}), [theme]: inspected.ext };
    const kept = same ? Math.max(previous.revision, revision) : revision;
    const record = { card_hash: hash, revision: kept, themes };
    const written = await bucket.put(cardKey(pageId), body, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { ...metadata, ...cardImageMetadata(record) },
      onlyIf: card ? { etagMatches: card.etag } : { etagDoesNotMatch: "*" },
    });
    if (!written) continue;
    const keep = new Set(
      Object.entries(themes).map(([name, ext]) => cardImageKey(pageId, hash, name, ext)),
    );
    const stale = previous?.card_hash
      ? Object.entries(previous.themes)
          .map(([name, ext]) => cardImageKey(pageId, previous.card_hash, name, ext))
          .filter((key) => !keep.has(key))
      : [];
    await Promise.allSettled(stale.map((key) => bucket.delete(key)));
    return { etag: written.etag, card_hash: hash, revision: kept, themes };
  }
  throw new HttpError(503, "Card image storage is busy; try again", "card_image_busy");
}

/** Delete `card.json`, the legacy pointer and the images either record
 * names, plus orphans found in at most four prefix-listing pages when the
 * bucket lists. More may remain. */
export async function deleteCardObjects(bucket, pageId) {
  const keys = new Set([cardKey(pageId), cardImagePointerKey(pageId)]);
  const records = await Promise.all([
    bucket
      .head(cardKey(pageId))
      .then((object) => cardImageRecordOf(object?.customMetadata))
      .catch(() => null),
    readCardImagePointer(bucket, pageId).catch(() => null),
  ]);
  for (const record of records)
    if (record?.card_hash)
      for (const [theme, ext] of Object.entries(record.themes))
        keys.add(cardImageKey(pageId, record.card_hash, theme, ext));
  if (typeof bucket.list === "function") {
    let cursor;
    // Bound purge work even when uploads have left many unreferenced objects.
    for (let page = 0; page < 4; page++) {
      const listed = await bucket.list({ prefix: cardImagePrefix(pageId), cursor });
      for (const object of listed.objects ?? []) keys.add(object.key);
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
  }
  await Promise.all([...keys].map((key) => bucket.delete(key)));
}

/**
 * The Page host's upload check, run inside the Page object with its own
 * policy. Throws an HttpError to refuse; returns the accepted hash.
 *
 * - `account()` is the host policy's edit check (`policy.account(identity,
 *   true)`): it refuses readers, a read-only credential and a trashed Page.
 * - The caller must be `owner`. Editors can already insert any image, so
 *   they could be admitted later; for now only the owner's tab captures.
 * - `currentHash()` is the `card_hash` of the host's loaded document. An
 *   upload for any other hash is stale.
 * - `guard` admits one upload per theme per CARD_IMAGE_UPLOAD_GAP_MS.
 */
export async function authorizeCardImageUpload({
  args,
  pageId,
  owner,
  identity,
  account,
  currentHash,
  guard,
  now = Date.now(),
}) {
  if (args?.page_id !== pageId || !validCardHash(args.hash) || !validCardTheme(args.theme))
    throw new HttpError(400, "Invalid card image request", "invalid_card_image");
  account();
  if (identity?.principal !== owner)
    throw new HttpError(403, "Only the Page owner uploads card images", "not_page_owner");
  const current = await currentHash();
  if (current !== args.hash)
    throw new HttpError(409, "This card image is for an older first screen", "card_image_stale");
  const wait = guard.wait(args.theme, now);
  if (wait > 0)
    throw Object.assign(
      new HttpError(429, "Card images upload at most once a minute", "card_image_rate_limited"),
      { retryAfter: Math.ceil(wait / 1000) },
    );
  guard.accept(args.theme, now);
  return { page_id: pageId, card_hash: current };
}

/** One Page's upload gap, per theme. It lives in the Page object's memory:
 * a restarted object admits one more upload, and the owner's scheduler
 * already waits two minutes between captures. */
export class CardImageGuard {
  #last = new Map();
  constructor(gapMs = CARD_IMAGE_UPLOAD_GAP_MS) {
    this.gapMs = gapMs;
  }
  wait(theme, now) {
    const last = this.#last.get(theme);
    return last === undefined ? 0 : Math.max(0, last + this.gapMs - now);
  }
  accept(theme, now) {
    this.#last.set(theme, now);
  }
}

/** Codes only the card image routes give. They aren't agent-facing
 * (CLIENT_ERROR_CODES), so these routes write them themselves. */
const CARD_IMAGE_CODES = new Set([
  "invalid_card_image",
  "card_image_too_large",
  "card_image_stale",
  "card_image_rate_limited",
  "card_image_busy",
]);

/** A refusal as these routes answer it: a card image code and its
 * Retry-After stay; anything else is errorResponse's. */
export function cardImageRefusal(error, stage = "card-image") {
  const response = CARD_IMAGE_CODES.has(error?.code)
    ? Response.json({ error: error.message, code: error.code }, { status: error.status ?? 500 })
    : errorResponse(error, stage);
  if (error?.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
  return response;
}

// Refusals passed through from the Page host arrive with immutable headers,
// so the result may be a copy.
function cardImageHeaders(response, cache = "private, no-store") {
  return setResponseHeaders(response, [
    ["Cache-Control", cache],
    ["X-Content-Type-Options", "nosniff"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
  ]);
}

/**
 * The card image routes, at the Worker edge. Bytes never enter a Durable
 * Object.
 *
 * - `PUT /api/pages/:id/card-image?hash=&theme=`: the owner's upload.
 *   `authorizeUpload({ hash, theme })` is the Page host's check; it answers
 *   `{ revision }` (see storeCardImage). After the write, `recheckUpload()`
 *   asks the host again: a Page purged meanwhile admits no one, and its card
 *   object and images are deleted here.
 * - `GET /api/pages/:id/card-image`: the stored image's hash, for the
 *   owner's scheduler: `{ card_hash }`, null until both themes exist.
 * - `GET|HEAD /api/pages/:id/card-image/<hash>-<theme>.<ext>`: the image.
 *
 * Both reads ask `authorizeRead(identity)`, the decision page_cards makes:
 * the caller's own Catalog entry for an owned Page, or its shared entry and
 * the Page host's record-only check (page-startup.mjs) for a shared one. A
 * grid of image cards boots no Page document, and a revoked grant fails the
 * host's check on the next fetch. A refusal reads as "not found".
 */
export async function handleCardImage(
  request,
  env,
  { pageId, file, authorizeUpload, authorizeRead, recheckUpload },
) {
  try {
    if (!validPageId(pageId)) throw new HttpError(400, "Invalid page_id", "invalid_page_id");
    const upload = file === undefined && request.method === "PUT";
    const pointer = file === undefined && request.method === "GET";
    const image = file !== undefined && ["GET", "HEAD"].includes(request.method);
    if (!upload && !pointer && !image)
      throw new HttpError(405, file === undefined ? "Use GET or PUT" : "Use GET or HEAD");
    const parsed = image ? CARD_IMAGE_FILE.exec(file) : null;
    if (image && !parsed) throw new HttpError(404, "Card image not found");
    const url = new URL(request.url);
    const hash = url.searchParams.get("hash");
    const theme = url.searchParams.get("theme");
    if (upload && (!validCardHash(hash) || !validCardTheme(theme)))
      throw new HttpError(400, "Invalid card hash or theme", "invalid_card_image");
    const identity = await authenticate(request, env);
    // An upload's bytes are read and checked before the host's check, so a
    // malformed body never spends the theme's one upload a minute.
    let bytes;
    let revision = 0;
    if (upload) {
      bytes = await readImageBody(request, {
        maxBytes: CARD_IMAGE_MAX_BYTES,
        tooLarge: "Card images must be 300 KB or smaller",
      });
      matchesContentType(inspectCardImage(bytes), request.headers.get("content-type"));
      const access = await authorizeUpload({ hash, theme });
      if (!access.ok) return cardImageHeaders(access);
      revision = (await access.json()).revision;
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw new Error("The Page host answered no card image revision");
    } else if (!(await timingFor(request).measure("allowed", () => authorizeRead(identity)))) {
      throw new HttpError(404, "Card image not found");
    }
    const bucket = env.PAGES_ASSETS;
    if (!bucket) throw new HttpError(503, "Image storage is unavailable");
    if (upload) {
      const stored = await storeCardImage(bucket, {
        pageId,
        hash,
        theme,
        bytes,
        contentType: request.headers.get("content-type"),
        revision,
      });
      const current = await recheckUpload();
      if (!current.ok) {
        await deleteCardObjects(bucket, pageId).catch(() => {});
        return cardImageHeaders(current);
      }
      return cardImageHeaders(
        Response.json(
          { card_hash: cardImageView(pageId, stored)?.card_hash ?? null, themes: stored.themes },
          { status: 201 },
        ),
      );
    }
    if (pointer) {
      const measure = (read) => timingFor(request).measure("r2", read);
      const card = await measure(() => bucket.head(cardKey(pageId)));
      const view = cardImageView(
        pageId,
        await readCardImageRecord(bucket, pageId, card?.customMetadata, measure),
      );
      return cardImageHeaders(Response.json({ card_hash: view?.card_hash ?? null }));
    }
    const [, imageHash, imageTheme, ext] = parsed;
    const key = cardImageKey(pageId, imageHash, imageTheme, ext);
    const object = await timingFor(request).measure("r2", () =>
      request.method === "HEAD" ? bucket.head(key) : bucket.get(key),
    );
    if (!object) throw new HttpError(404, "Card image not found");
    const contentType = object.httpMetadata?.contentType;
    if (contentType !== MEDIA_TYPES[ext] || object.customMetadata?.page_id !== pageId)
      throw new Error("Invalid stored card image");
    return cardImageHeaders(
      new Response(request.method === "HEAD" ? null : object.body, {
        headers: {
          "Content-Type": contentType,
          ...(Number.isSafeInteger(object.size) && { "Content-Length": String(object.size) }),
          "Content-Disposition": "inline",
          ...(object.httpEtag && { ETag: object.httpEtag }),
        },
      }),
      `private, max-age=${CARD_IMAGE_MAX_AGE_S}, immutable`,
    );
  } catch (error) {
    return cardImageHeaders(cardImageRefusal(error));
  }
}
