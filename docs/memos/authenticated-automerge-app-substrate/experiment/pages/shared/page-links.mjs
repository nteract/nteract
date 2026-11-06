// Links in Page content that go to this deployment's app, and which Page a
// link names. One test for everything that treats such a link specially:
// in-place navigation (viewer/heading-links.mjs inAppLink), the Page glyph
// and hover card (viewer/link-destination.mjs linkAttributes), and later the
// server, which will pass the deployment's public origin as `base`.
//
// A link counts only when all of these hold:
// - `safeUrl(href)` (model/marks.mjs): no spaces or control characters, and no
//   scheme other than http(s), mailto or tel. A script URL never counts.
// - Resolved against `base`, its origin is exactly `base`'s. URL parsing
//   lowercases the scheme and host and drops a default port, so
//   `HTTPS://Pages.Example:443/p/<id>` counts; a look-alike host
//   (`pages.example.evil.example`), a trailing-dot host (`pages.example.`),
//   another deployment and another scheme don't. A relative `/p/<id>` counts.
// - It carries no user name or password. `https://pages.example@evil.example`
//   already fails the origin test; this also refuses
//   `https://someone@pages.example/p/<id>`, which nothing in Pages writes.
// - readPageRoute reads its path as a Page or a Project. Anything longer than
//   the route, such as `/p/<id>/meta.json`, reads as missing.
//
// This module has no DOM or editor dependencies; the Worker can import it.
import { safeUrl } from "../model/marks.mjs";
import { readPageRoute } from "./routes.mjs";

/** The anchor a fragment names, percent-decoded, or null for none. */
export function anchorFromHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Where `href` goes in this app, read against `base` (an absolute URL: the
 * address showing now in a browser): `{ route, url }`, where `route` is
 * readPageRoute's answer (`kind` "page" or "project") and `url` the resolved
 * URL. Null for any link that isn't one of this deployment's Page or Project
 * routes (see the rules above).
 */
export function appRoute(href, base) {
  if (typeof href !== "string" || !href || !safeUrl(href)) return null;
  let url, here;
  try {
    here = new URL(base);
    url = new URL(href, here);
  } catch {
    return null;
  }
  if (url.origin !== here.origin || url.username || url.password) return null;
  const route = readPageRoute(url.href);
  if (route.kind !== "page" && route.kind !== "project") return null;
  return { route, url };
}

/**
 * The Page a link names: `{ pageId, anchor }`, or null when `href` isn't a
 * link to one of this deployment's Pages. `anchor` is the heading the
 * fragment names, percent-decoded, or null.
 */
export function pageLink(href, base) {
  const target = appRoute(href, base);
  if (target?.route.kind !== "page") return null;
  return { pageId: target.route.pageId, anchor: anchorFromHash(target.url.hash) };
}

/**
 * A link to another Page: pageLink's answer, or null for a link to the Page
 * open now, which is a section link. That Page is `currentPageId`, or the
 * Page `base` shows. Links that pass get the Page glyph and the hover card.
 */
export function linkedPage(href, base, { currentPageId = null } = {}) {
  const page = pageLink(href, base);
  if (!page) return null;
  if (currentPageId && page.pageId === currentPageId) return null;
  let here;
  try {
    here = readPageRoute(base);
  } catch {
    return null;
  }
  if (here.kind === "page" && here.pageId === page.pageId) return null;
  return page;
}
