import { LIBRARY_CATALOG_REVISION, LIBRARY_PATH } from "../shared/library-catalog.mjs";
import { LIBRARY_MANIFEST, archiveKey, catalogArchive } from "./library-archive.mjs";

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
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });

/** The file from the build's assets as {body, etag, length}, or null when
 * the build does not carry it. The asset binding answers a missing path with
 * the app's HTML shell (single-page-application handling), so an HTML answer
 * counts as missing. */
async function fromAssets(env, url) {
  let found;
  try {
    found = await env.ASSETS.fetch(
      new Request(new URL(url.pathname, url.origin), { method: "GET" }),
    );
  } catch {
    return null;
  }
  if (found.status !== 200 || /^text\/html\b/i.test(found.headers.get("content-type") ?? "")) {
    await found.body?.cancel();
    return null;
  }
  return {
    body: found.body,
    etag: found.headers.get("etag"),
    length: found.headers.get("content-length"),
  };
}

/** The file from the archive in `env.PAGES_ASSETS` (library-archive.mjs) as
 * {body, etag, length}, or null when the host has no bucket or the bucket
 * lacks it. `key` is the matched path behind the fixed catalog/ prefix. */
async function fromArchive(env, key, method) {
  const bucket = env.PAGES_ASSETS;
  if (!bucket) return null;
  let object;
  try {
    object = method === "HEAD" ? await bucket.head(key) : await bucket.get(key);
  } catch {
    return null;
  }
  if (!object) return null;
  return { body: object.body ?? null, etag: object.httpEtag ?? null, length: String(object.size) };
}

/**
 * The answer to a GET or HEAD for one view library file,
 * /catalog/<revision>/<name>; null for any other request, which the caller
 * routes on. The build's static assets (`env.ASSETS`) answer first; on a
 * miss, the archive of revisions in the asset bucket (`env.PAGES_ASSETS`,
 * library-archive.mjs) does. Both are read only for such a path, and both
 * answers carry the same headers. A host with no bucket binding serves its
 * build's assets alone.
 *
 * An output frame has an opaque origin and loads these modules in CORS mode,
 * so every file answers with Access-Control-Allow-Origin: * and
 * Cross-Origin-Resource-Policy: cross-origin. A revision names its bytes, so
 * a file is immutable. The files are the same public build output for every
 * reader: this route runs before any session or account code, reads no
 * cookie or credential and sets none.
 *
 * A file or revision neither holds answers 404 with no long-lived caching,
 * and with the same CORS headers, so a viewer on another origin that names
 * this host as its library origin can read the 404 and fall back to its own
 * build's revision.
 *
 * Serving this build's own manifest from its assets starts the archive of
 * this build's revision under `ctx.waitUntil`. The response never waits on
 * it and never fails because of it. `options.revision` and `options.archive`
 * stand in for this build's revision and the isolate's archive in tests.
 */
export async function libraryCatalogResponse(
  request,
  env,
  ctx,
  { revision = LIBRARY_CATALOG_REVISION, archive = catalogArchive } = {},
) {
  if (!["GET", "HEAD"].includes(request.method)) return null;
  const url = new URL(request.url);
  const match = LIBRARY_PATH.exec(url.pathname);
  if (!match) return url.pathname.startsWith("/catalog/") ? notFound(request.method) : null;
  // The whole anchored match without its leading slash: catalog/<revision>/<name>.
  const key = match[0].slice(1);
  let found = await fromAssets(env, url);
  if (found) {
    if (env.PAGES_ASSETS && key === archiveKey(revision, LIBRARY_MANIFEST))
      ctx?.waitUntil?.(
        archive.request({
          revision,
          assets: env.ASSETS,
          bucket: env.PAGES_ASSETS,
          origin: url.origin,
        }),
      );
  } else {
    found = await fromArchive(env, key, request.method);
  }
  if (!found) return notFound(request.method);
  const headers = new Headers({
    "Content-Type": CONTENT_TYPES[match[1]],
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  if (found.etag) headers.set("ETag", found.etag);
  if (request.method === "HEAD") {
    await found.body?.cancel();
    if (found.length) headers.set("Content-Length", found.length);
    return new Response(null, { status: 200, headers });
  }
  return new Response(found.body, { status: 200, headers });
}
