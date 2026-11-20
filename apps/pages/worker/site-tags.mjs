// The link-preview tags for the pages people pass around that have no
// published snapshot of their own: `/`, `/connect`, and the app shell every
// other route serves. A link unfurler has no session and runs no script, so
// what it shows must be in the HTML the Worker sends.
//
// Every value here is fixed text or the deployment's public origin, so these
// tags are the same bytes for every caller and say nothing about any Page or
// Project. A Page's own tags (published-preview.mjs previewTags) use the same
// renderer, so the two stay one shape.
//
// The image is the product's card (shared/social-card.mjs, drawn by
// scripts/social-card.mjs), served at SOCIAL_CARD_PATH. A relative URL fails
// in most unfurlers, so tags that carry it need the origin. The URL carries
// the card's version: services keep an image by its URL, so a new card must
// be a new URL.
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

/** The card's absolute URL at `origin`. */
export const socialCardUrl = (origin) => `${origin}${SOCIAL_CARD_PATH}?v=${SOCIAL_CARD_VERSION}`;

/** The tags that show the product's card as a link's image, and ask for the
 * wide layout it is drawn for. */
export function socialCardTags(origin, alt = PRODUCT_NAME) {
  const url = socialCardUrl(origin);
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
 * `url` is the page's canonical address; leave it out where the path stands
 * for something private (a Page or Project the caller may not read).
 */
export function siteTags(
  origin,
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
    ...socialCardTags(origin),
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

/** `GET /social-card.png`: the card. Public and the same for everyone. The
 * URL the tags name carries this build's version and never changes its
 * bytes, so it may be kept for good; any other `v` is some other build's
 * URL and is kept only briefly. */
export function socialCardResponse(request) {
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const current = new URL(request.url).searchParams.get("v") === SOCIAL_CARD_VERSION;
  return new Response(request.method === "HEAD" ? null : decodeCard(), {
    headers: {
      "content-type": "image/png",
      "cache-control": current ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}

const HEAD_END = /<\/head>/;
/**
 * The app shell with the product's preview tags in its head, for a GET or
 * HEAD. The shell serves `/` and every route the app owns (`/project/<id>`,
 * `/trash`, ...), so only `/` names a canonical URL. Any other request, and
 * any answer that isn't a 200 HTML shell (a redirect, a 304, a built file), is
 * the asset's own response, untouched.
 *
 * The rewritten body names the deployment's origin, so the asset's validators
 * don't describe it and the answer carries none. A browser then asks again
 * each time and gets the full shell.
 */
export async function siteShellResponse(request, assets, origin) {
  const response = await assets.fetch(request);
  if (
    !["GET", "HEAD"].includes(request.method) ||
    response.status !== 200 ||
    !(response.headers.get("content-type") ?? "").startsWith("text/html")
  )
    return response;
  const { pathname } = new URL(request.url);
  const tags = siteTags(origin, {
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
