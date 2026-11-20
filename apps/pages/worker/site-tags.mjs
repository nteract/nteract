// The link-preview tags for the pages people pass around that have no
// published snapshot of their own: `/`, `/connect`, and the app shell every
// other route serves. A link unfurler has no session and runs no script, so
// what it shows must be in the HTML the Worker sends.
//
// Every value here is fixed text, the deployment's public origin or its card,
// so these tags are the same bytes for every caller and say nothing about any
// Page or Project. A Page's own tags (published-preview.mjs previewTags) use
// the same renderer, so the two stay one shape.
//
// The image is the deployment's card, served at SOCIAL_CARD_PATH. By default
// that is the product's card (shared/social-card.mjs, drawn by
// scripts/social-card.mjs). A deployment that sets PAGES_SOCIAL_CARD to the
// key of its own card in PAGES_ASSETS serves that one instead (socialCard).
// A relative URL fails in most unfurlers, so tags that carry it need the
// origin. The URL carries the card's version: services keep an image by its
// URL, so a new card must be a new URL.
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from "../shared/product.mjs";
import {
  SOCIAL_CARD_BASE64,
  SOCIAL_CARD_HEIGHT,
  SOCIAL_CARD_PATH,
  SOCIAL_CARD_VERSION,
  SOCIAL_CARD_WIDTH,
} from "../shared/social-card.mjs";

export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** The `<meta>` lines for `tags` (`og:*` are properties, `twitter:*` names,
 * null values skipped), led by the plain `description` tag. */
export function renderMetaTags(description, tags) {
  return (
    `<meta name="description" content="${escapeHtml(description)}">\n` +
    Object.entries(tags)
      .filter(([, value]) => value != null)
      .map(
        ([name, value]) =>
          `<meta ${name.startsWith("twitter:") ? "name" : "property"}="${name}" content="${escapeHtml(value)}">`,
      )
      .join("\n")
  );
}

/** The key a deployment's own card has in PAGES_ASSETS. The capture is its
 * version: the first 12 hex digits of the PNG's sha256, as
 * scripts/social-card.mjs prints it. */
export const BRAND_CARD_KEY = /^brand\/social-card-([0-9a-f]{12})\.png$/;
export const brandCardKey = (version) => `brand/social-card-${version}.png`;

/** The committed card: inlined in the Worker, with no object to read. */
export const COMMITTED_CARD = Object.freeze({ version: SOCIAL_CARD_VERSION, key: null });

// Problems this isolate has already logged. The setting changes only with a
// deploy, which starts new isolates, so each one is logged once per isolate
// rather than once per unfurl.
const warned = new Set();
function warnOnce(event, fields) {
  const id = JSON.stringify([event, fields]);
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(
    JSON.stringify({
      service: "nteract-pages-native",
      event,
      ...fields,
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * The card `env` selects, as `{ version, key }`. `PAGES_SOCIAL_CARD` names
 * the deployment's own card by its PAGES_ASSETS key (BRAND_CARD_KEY), and the
 * key's digits are its version. Unset or empty selects the committed card,
 * and so does any value that doesn't match, which is logged once.
 *
 * Callers read it from `env` for each response and pass it to the tag
 * renderers, so every route names the same card.
 */
export function socialCard(env) {
  const value = env?.PAGES_SOCIAL_CARD;
  if (value === undefined || value === "") return COMMITTED_CARD;
  const match = typeof value === "string" ? BRAND_CARD_KEY.exec(value) : null;
  if (!match) {
    warnOnce("site.social_card_setting_refused", {
      setting: "PAGES_SOCIAL_CARD",
      expected: "brand/social-card-<12 hex digits>.png",
    });
    return COMMITTED_CARD;
  }
  return Object.freeze({ version: match[1], key: value });
}

/** The URL of `card` (from socialCard) at `origin`. */
export const socialCardUrl = (origin, card) => `${origin}${SOCIAL_CARD_PATH}?v=${card.version}`;

/** The tags that show `card` as a link's image, and ask for the wide layout
 * it is drawn for. A deployment's own card must be drawn at the same size. */
export function socialCardTags(origin, card, alt = PRODUCT_NAME) {
  const url = socialCardUrl(origin, card);
  return {
    "twitter:card": "summary_large_image",
    "og:image": url,
    "og:image:alt": alt,
    "og:image:type": "image/png",
    "og:image:width": SOCIAL_CARD_WIDTH,
    "og:image:height": SOCIAL_CARD_HEIGHT,
    "twitter:image": url,
    "twitter:image:alt": alt,
  };
}

/**
 * The preview tags for a page of the product itself, as HTML for its head.
 * `card` is socialCard(env). `url` is the page's canonical address; leave it
 * out where the path stands for something private (a Page or Project the
 * caller may not read).
 */
export function siteTags(
  origin,
  card,
  { title = PRODUCT_NAME, description = PRODUCT_DESCRIPTION, url, type = "website" } = {},
) {
  return renderMetaTags(description, {
    "og:type": type,
    "og:site_name": PRODUCT_NAME,
    "og:title": title,
    "og:description": description,
    "og:url": url,
    "twitter:title": title,
    "twitter:description": description,
    ...socialCardTags(origin, card),
  });
}

let cardBytes;
const decodeCard = () => {
  if (!cardBytes) {
    const text = atob(SOCIAL_CARD_BASE64);
    cardBytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
  }
  return cardBytes;
};

const cardHeaders = (kept) => ({
  "content-type": "image/png",
  "cache-control": kept ? "public, max-age=31536000, immutable" : "public, max-age=300",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "cross-origin",
});

/** The deployment's own card from `bucket`, or null when it can't be read.
 * HEAD reads only its metadata. */
async function readBrandCard(bucket, key, method) {
  try {
    const object = method === "HEAD" ? await bucket.head(key) : await bucket.get(key);
    if (object) return object;
    warnOnce("site.social_card_unavailable", { key, reason: "missing" });
  } catch {
    warnOnce("site.social_card_unavailable", { key, reason: "read_failed" });
  }
  return null;
}

/** `GET /social-card.png`: the card. Public and the same for everyone. The
 * URL the tags name carries the selected card's version and never changes
 * its bytes, so it may be kept for good. The selected card is the committed
 * one, or the deployment's own, streamed from PAGES_ASSETS.
 *
 * Every other answer is the committed card, kept only briefly. Any other `v`
 * is some other build's or setting's URL. A deployment card that can't be
 * read still leaves the link an image. */
export async function socialCardResponse(request, env) {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const card = socialCard(env);
  const current = new URL(request.url).searchParams.get("v") === card.version;
  if (current && card.key) {
    const object = await readBrandCard(env.PAGES_ASSETS, card.key, request.method);
    if (object)
      return new Response(request.method === "HEAD" ? null : object.body, {
        headers: cardHeaders(true),
      });
  }
  return new Response(request.method === "HEAD" ? null : decodeCard(), {
    headers: cardHeaders(current && !card.key),
  });
}

const HEAD_END = /<\/head>/;
/**
 * The app shell with the product's preview tags in its head, for a GET or
 * HEAD. `card` is socialCard(env). The shell serves `/` and every route the
 * app owns (`/project/<id>`, `/trash`, ...), so only `/` names a canonical
 * URL. Any other request, and any answer that isn't a 200 HTML shell (a
 * redirect, a 304, a built file), is the asset's own response, untouched.
 *
 * The rewritten body names the deployment's origin, so the asset's validators
 * don't describe it and the answer carries none. A browser then asks again
 * each time and gets the full shell.
 */
export async function siteShellResponse(request, assets, origin, card) {
  const response = await assets.fetch(request);
  if (
    !["GET", "HEAD"].includes(request.method) ||
    response.status !== 200 ||
    !(response.headers.get("content-type") ?? "").startsWith("text/html")
  )
    return response;
  const { pathname } = new URL(request.url);
  const tags = siteTags(origin, card, {
    url: pathname === "/" ? `${origin}/` : undefined,
  });
  const html = (await response.text()).replace(HEAD_END, () => `${tags}\n</head>`);
  const out = new Headers(response.headers);
  for (const name of ["etag", "last-modified", "content-length", "content-encoding"])
    out.delete(name);
  out.set("cache-control", "no-cache");
  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: out,
  });
}
