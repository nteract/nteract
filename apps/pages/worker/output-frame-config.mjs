import { LIBRARY_CATALOG_REVISION } from "../shared/library-catalog.mjs";
import { outputFrameUrl } from "../shared/output-frame-config.mjs";
import { viewerCsp } from "../shared/viewer-csp.mjs";

const escapeAttribute = (value) =>
  value.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]);

/** Configure the app shell at delivery, including shells used by link previews.
 * A configured shell names the output frame URL (`value`), with the CSP that
 * admits it, and this build's library catalog revision
 * (`pages-library-catalog`), which the viewer loads for a view whose pinned
 * catalog this host doesn't serve (viewer/library-catalog.mjs). Without a
 * frame URL the shell is the build's own. Asset bytes stay immutable;
 * configured HTML has no build-time validator. */
export function outputFrameAssets(
  assets,
  value,
  pageOrigin,
  libraryRevision = LIBRARY_CATALOG_REVISION,
) {
  if (value === undefined) return assets;
  const frameUrl = outputFrameUrl(value, pageOrigin);
  const metas =
    `<meta name="pages-library-catalog" content="${escapeAttribute(libraryRevision)}" />` +
    `<meta name="pages-output-frame-url" content="${escapeAttribute(frameUrl)}" />`;
  return {
    async fetch(request) {
      if (!["GET", "HEAD"].includes(request.method)) return assets.fetch(request);
      // Hashed JS/CSS/WASM and other files keep their normal cache behavior.
      const path = new URL(request.url).pathname;
      if (/\.[a-z0-9]+$/i.test(path) && !path.endsWith(".html")) return assets.fetch(request);
      const headers = new Headers(request.headers);
      for (const key of [
        "if-none-match",
        "if-modified-since",
        "if-match",
        "if-unmodified-since",
        "if-range",
        "range",
      ])
        headers.delete(key);
      const response = await assets.fetch(new Request(request, { method: "GET", headers }));
      if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html"))
        return request.method === "HEAD" ? new Response(null, response) : response;
      const html = await response.text();
      const body = html.replace("</head>", () => `${metas}</head>`);
      const out = new Headers(response.headers);
      // Set this here even when the host's asset binding omits _headers.
      out.set("content-security-policy", viewerCsp(frameUrl));
      for (const key of ["etag", "last-modified", "content-length", "content-encoding"])
        out.delete(key);
      out.set("cache-control", "no-store");
      return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: out });
    },
  };
}
