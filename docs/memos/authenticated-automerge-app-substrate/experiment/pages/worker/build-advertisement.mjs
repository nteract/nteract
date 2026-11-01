import {
  BUILD_HEADER,
  MIN_VIEWER_PROTOCOL,
  MIN_VIEWER_PROTOCOL_HEADER,
  PAGES_BUILD,
} from "../shared/build-identity.mjs";

const advertised = (pathname) => pathname === "/health" || pathname.startsWith("/api/");

/** Stamp the live build on API and health responses, so open viewers can see
 * a deploy from requests they already make. WebSocket upgrades pass through
 * unchanged: their 101 response cannot be rebuilt.
 *
 * This is one of two gates that keep an old viewer from editing what it can't
 * express. The minimum viewer protocol is per build: it retires a viewer
 * contract and makes every open tab reload. The schema stamp
 * (model/schema-features.mjs) is per document: a Page whose
 * `schema.features` names an id this build lacks opens read-only, and the host
 * refuses tool writes to it with `unsupported_schema_feature`. Raising the
 * protocol floor is the only way to stop an old tab's native sync; the stamp
 * relies on the viewer honoring it. */
export function advertiseBuild(request, response) {
  if (!advertised(new URL(request.url).pathname)) return response;
  if (response.status === 101 || response.webSocket) return response;
  // Durable Object and asset responses carry immutable headers.
  const stamped = new Response(response.body, response);
  stamped.headers.set(BUILD_HEADER, PAGES_BUILD);
  stamped.headers.set(MIN_VIEWER_PROTOCOL_HEADER, String(MIN_VIEWER_PROTOCOL));
  return stamped;
}
