import { LIBRARY_PATH } from "../shared/library-catalog.mjs";

const CONTENT_TYPES = Object.freeze({
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  wasm: "application/wasm",
  json: "application/json; charset=utf-8",
});

const notFound = (method) =>
  new Response(method === "HEAD" ? null : "No such library file\n", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });

/**
 * The answer to a GET or HEAD for one view library file,
 * /catalog/<revision>/<name>, from the build's static assets (`env.ASSETS`,
 * read only for such a path); null for any other request, which the caller
 * routes on.
 *
 * An output frame has an opaque origin and loads these modules in CORS mode,
 * so every file answers with Access-Control-Allow-Origin: * and
 * Cross-Origin-Resource-Policy: cross-origin. A revision names its bytes, so
 * a file is immutable. The files are the same public build output for every
 * reader: this route runs before any session or account code, reads no
 * cookie or credential and sets none.
 *
 * A file or revision this build does not carry answers 404 with no long-lived
 * caching. The asset binding answers a missing path with the app's HTML shell
 * (single-page-application handling), so an HTML answer counts as missing.
 */
export async function libraryCatalogResponse(request, env) {
  if (!["GET", "HEAD"].includes(request.method)) return null;
  const url = new URL(request.url);
  const match = LIBRARY_PATH.exec(url.pathname);
  if (!match) return url.pathname.startsWith("/catalog/") ? notFound(request.method) : null;
  let found;
  try {
    found = await env.ASSETS.fetch(
      new Request(new URL(url.pathname, url.origin), { method: "GET" }),
    );
  } catch {
    return notFound(request.method);
  }
  if (found.status !== 200 || /^text\/html\b/i.test(found.headers.get("content-type") ?? "")) {
    await found.body?.cancel();
    return notFound(request.method);
  }
  const headers = new Headers({
    "Content-Type": CONTENT_TYPES[match[3]],
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  const etag = found.headers.get("etag");
  if (etag) headers.set("ETag", etag);
  if (request.method === "HEAD") {
    await found.body?.cancel();
    const length = found.headers.get("content-length");
    if (length) headers.set("Content-Length", length);
    return new Response(null, { status: 200, headers });
  }
  return new Response(found.body, { status: 200, headers });
}
