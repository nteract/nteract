// The app shell for a Page link that carries a slug, `/p/<id>/<slug>`
// (shared/routes.mjs isPageSlug). A link unfurler has no session, so it can
// read nothing about the Page; the slug's words are the only title it gets.
//
// The slug is the link author's text and is trusted as a title: it names
// nothing and finds nothing. The shell is the static asset with its
// `<title>` replaced by the words and an `og:title` beside it, and nothing
// else changes. No lookup happens, so the bytes are the same for a Page that
// exists, one that doesn't and one the caller can't read. The words reach
// only those two tags, HTML-escaped; never a script, a header or a log line.
//
// A rewritten body has no validator: the asset's ETag names other bytes. The
// asset is asked without the caller's conditional headers, so it always
// answers the full shell, and the answer is `no-store`, so no cache keeps one
// path's words for another.
import { tabTitle } from "../shared/product.mjs";
import { pageSlugWords, readPageRoute } from "../shared/routes.mjs";

const escapeHtml = (value) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );

const TITLE = /<title>[^<]*<\/title>/;
const CONDITIONAL = [
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "if-range",
];

/** The slug `request` names a Page by, for a GET or HEAD of a Page route
 * that carries one; null otherwise. */
export function pageShellSlug(request, url = new URL(request.url)) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (!url.pathname.startsWith("/p/")) return null;
  const route = readPageRoute(url.href);
  return route.kind === "page" ? route.slug : null;
}

/** `html` with its title naming `slug`'s words, and an `og:title` with them. */
export function titledShell(html, slug) {
  const words = pageSlugWords(slug);
  return html.replace(
    TITLE,
    () =>
      `<title>${escapeHtml(tabTitle(words))}</title>` +
      `<meta property="og:title" content="${escapeHtml(words)}" />`,
  );
}

/** The app shell for a slugged Page route, from `assets` (the ASSETS
 * binding). Any answer other than a 200 HTML shell passes through. */
export async function slugShellResponse(request, assets, slug) {
  const headers = new Headers(request.headers);
  for (const name of CONDITIONAL) headers.delete(name);
  const response = await assets.fetch(new Request(request.url, { method: "GET", headers }));
  const type = response.headers.get("content-type") ?? "";
  if (response.status !== 200 || !type.startsWith("text/html")) return response;
  const body = titledShell(await response.text(), slug);
  const out = new Headers(response.headers);
  for (const name of ["etag", "last-modified", "content-length", "content-encoding"])
    out.delete(name);
  out.set("cache-control", "no-store");
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: out });
}
