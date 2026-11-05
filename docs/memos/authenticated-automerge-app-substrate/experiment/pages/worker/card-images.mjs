// Grid card images: a raster of a Page's first screen, one per theme, drawn
// by the owner's own browser (viewer/card-capture.mjs) and shown in the
// library grid in place of the JSON card (model/page-card.mjs) when both
// were built from the same `card_hash`.
//
// Storage, in the Page assets bucket:
//
// - `pages/<id>/card/<card_hash>-<theme>.<ext>`: the image. `ext` is webp,
//   png or jpg; Safari has no WebP encoder, so its captures are PNG.
// - `pages/<id>/card/latest`: an empty pointer object whose `customMetadata`
//   names the current `card_hash` and each theme's extension. Every pointer
//   put is fenced on the etag it read (`onlyIf`), as the card writer's put
//   is (page-card-writer.mjs), and retried after a refusal.
//
// Only the latest hash is kept. An upload for a new hash swaps the pointer,
// then deletes the images the old pointer named, so a Page holds at most two
// images plus the pointer. A delete that fails leaves an orphan no route
// names and the next purge's prefix listing removes.
//
// Who writes. Only the Page owner, checked by the Page host's own policy
// (`authorizeCardImageUpload`, run inside the Page object), never D1. The
// host also requires the upload's hash to be the `card_hash` of its loaded
// document, so a capture of an older first screen is refused, and allows one
// upload per theme per minute. Each admitted upload gets the host's next
// revision, and the pointer refuses a swap to an older one (storeCardImage).
// The server can't check that the pixels match
// the content: that is the same trust as an image the owner inserts into the
// Page, and only people who can read the Page see it.
//
// Who reads. `GET /api/pages/:id/card-image/<hash>-<theme>.<ext>` decides
// access as page_cards does, on every request, without loading the Page's
// document (handleCardImage), and streams the object with a private,
// immutable cache header: the hash is in the URL. No object URL leaves the
// Worker. `page_cards` names an image only when the pointer's hash
// is the stored JSON card's and both themes exist.
import { authenticate, HttpError, errorResponse } from "./auth.mjs";
import { validPageId } from "./registration.mjs";
import { inspectImage, readImageBody } from "./image-assets.mjs";
import { CARD_IMAGE_MAX_BYTES } from "../shared/card-images.mjs";

export { CARD_IMAGE_MAX_BYTES };
/** The largest side an upload may have. Captures are 1280×960. */
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
const FILE = /^([0-9a-f]{64})-(light|dark)\.(webp|png|jpg)$/;
/** The Page host's storage key for its last card image revision. */
export const CARD_IMAGE_REVISION_KEY = "host/card-image-revision";
/** How many times a pointer swap re-reads after its put was refused. */
const POINTER_ATTEMPTS = 3;

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

/** The pointer as stored, or null. A theme whose extension isn't one this
 * build writes counts as missing. */
export async function readCardImagePointer(bucket, pageId) {
  const object = await bucket.head(cardImagePointerKey(pageId));
  if (!object) return null;
  const metadata = object.customMetadata ?? {};
  const themes = {};
  for (const theme of CARD_IMAGE_THEMES)
    if (MEDIA_TYPES[metadata[theme]]) themes[theme] = metadata[theme];
  const revision = Number(metadata.revision);
  return {
    etag: object.etag,
    card_hash: validCardHash(metadata.card_hash) ? metadata.card_hash : null,
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 0,
    themes,
  };
}

/** What a reader learns about a pointer: its hash only when every theme is
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

/**
 * Store one theme's image for `hash` and point `latest` at it. Returns the
 * pointer it wrote. Authorization belongs to the caller.
 *
 * The image lands first, so the pointer never names a missing object. The
 * pointer swap is fenced on the etag it read; a refused put reads again, up
 * to POINTER_ATTEMPTS times. Once the swap lands, images the previous
 * pointer named and this one doesn't are deleted.
 *
 * The etag orders writes to the bucket, not first screens. `revision` does:
 * the Page host hands out one per admitted upload, in order, from durable
 * storage, and admits only its current `card_hash`, so a later revision is
 * always a later (or the same) first screen. The pointer keeps the highest
 * revision it has seen, and a swap to another hash with a lower revision is
 * refused as stale (409), its image deleted. Uploads of the same hash merge
 * whatever their order.
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
  for (let attempt = 0; attempt < POINTER_ATTEMPTS; attempt++) {
    const previous = await readCardImagePointer(bucket, pageId);
    const same = previous?.card_hash === hash;
    if (previous && !same && previous.revision > revision) {
      // A later first screen's image landed first. This upload was admitted
      // for an older one; its image is an orphan no pointer names.
      await bucket.delete(imageKey).catch(() => {});
      throw new HttpError(409, "This card image is for an older first screen", "card_image_stale");
    }
    const themes = { ...(same ? previous.themes : {}), [theme]: inspected.ext };
    const kept = same ? Math.max(previous.revision, revision) : revision;
    const written = await bucket.put(cardImagePointerKey(pageId), "", {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        card_hash: hash,
        revision: String(kept),
        light: themes.light ?? "",
        dark: themes.dark ?? "",
      },
      onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: "*" },
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

/** Delete every card image of `pageId` and its pointer: the images the
 * pointer names, then whatever a prefix listing finds (orphans of a failed
 * delete or a lost race), when the bucket lists. */
export async function deleteCardImages(bucket, pageId) {
  const keys = new Set([cardImagePointerKey(pageId)]);
  const pointer = await readCardImagePointer(bucket, pageId).catch(() => null);
  if (pointer?.card_hash)
    for (const [theme, ext] of Object.entries(pointer.themes))
      keys.add(cardImageKey(pageId, pointer.card_hash, theme, ext));
  if (typeof bucket.list === "function") {
    let cursor;
    // A Page holds a handful of objects; a few pages of listing is plenty.
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

function cardImageHeaders(response, cache = "private, no-store") {
  response.headers.set("Cache-Control", cache);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return response;
}

/**
 * The card image routes, at the Worker edge. Bytes never enter a Durable
 * Object.
 *
 * - `PUT /api/pages/:id/card-image?hash=&theme=`: the owner's upload.
 *   `authorizeUpload({ hash, theme })` is the Page host's check; it answers
 *   `{ revision }` (see storeCardImage). After the write, `recheckUpload()`
 *   asks the host again: a Page purged meanwhile admits no one, and its card
 *   images are deleted here.
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
    const parsed = image ? FILE.exec(file) : null;
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
    } else if (!(await authorizeRead(identity))) {
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
        await deleteCardImages(bucket, pageId).catch(() => {});
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
      const view = cardImageView(pageId, await readCardImagePointer(bucket, pageId));
      return cardImageHeaders(Response.json({ card_hash: view?.card_hash ?? null }));
    }
    const [, imageHash, imageTheme, ext] = parsed;
    const key = cardImageKey(pageId, imageHash, imageTheme, ext);
    const object = await (request.method === "HEAD" ? bucket.head(key) : bucket.get(key));
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
