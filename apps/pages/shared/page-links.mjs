// Links in Page content that go to this deployment's app, and which Page or
// Project a link names. One test for everything that treats such a link
// specially: in-place navigation (viewer/heading-links.mjs inAppLink), the
// Page and Project glyphs and the hover card (viewer/link-destination.mjs
// linkAttributes), and later the server, which will pass the deployment's
// public origin as `base`.
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
// - readPageRoute reads its path as a Page (`/p/<uuid>`, or
//   `/p/<uuid>/<slug>`, which names the same Page) or a Project
//   (`/project/<prj_id>`, or the older `/s/<id>`, either with a `prj_` or an
//   older `sp_` ID). Anything else after the route, such as
//   `/p/<id>/meta.json` or `/project/<id>/meta.json`, reads as missing.
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
 * What a link names: `{ kind: "page", pageId, anchor }`, `{ kind: "project",
 * projectId, anchor }`, or null when `href` isn't a link to one of this
 * deployment's Pages or Projects. `anchor` is the heading the fragment names
 * (in a Project, a heading in its content), percent-decoded, or null.
 */
export function linkTarget(href, base) {
  const target = appRoute(href, base);
  if (!target) return null;
  const anchor = anchorFromHash(target.url.hash);
  return target.route.kind === "page"
    ? { kind: "page", pageId: target.route.pageId, anchor }
    : { kind: "project", projectId: target.route.projectId, anchor };
}

/**
 * The Page a link names: `{ pageId, anchor }`, or null when `href` isn't a
 * link to one of this deployment's Pages. `anchor` is the heading the
 * fragment names, percent-decoded, or null.
 */
export function pageLink(href, base) {
  const target = linkTarget(href, base);
  return target?.kind === "page" ? { pageId: target.pageId, anchor: target.anchor } : null;
}

/**
 * A link to another Page or Project: linkTarget's answer, or null for a link
 * to what is open now. That is the Page open now (`currentPageId`, or the
 * Page `base` shows), whose links are section links, and the Project whose
 * content is open now (`currentProjectId`, or the Project `base` shows): on
 * a Project's route the open document is its content. A Project link inside
 * an ordinary Page of that Project still counts. Links that pass get a glyph
 * and the hover card.
 */
export function linkedTarget(href, base, { currentPageId = null, currentProjectId = null } = {}) {
  const target = linkTarget(href, base);
  if (!target) return null;
  let here;
  try {
    here = readPageRoute(base);
  } catch {
    return null;
  }
  if (target.kind === "page") {
    if (currentPageId && target.pageId === currentPageId) return null;
    if (here.kind === "page" && here.pageId === target.pageId) return null;
  } else {
    if (currentProjectId && target.projectId === currentProjectId) return null;
    if (here.kind === "project" && here.projectId === target.projectId) return null;
  }
  return target;
}

/**
 * A link to another Page: linkedTarget's answer for a Page, as `{ pageId,
 * anchor }`, or null.
 */
export function linkedPage(href, base, { currentPageId = null } = {}) {
  const target = linkedTarget(href, base, { currentPageId });
  return target?.kind === "page" ? { pageId: target.pageId, anchor: target.anchor } : null;
}
