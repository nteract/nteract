import {
  BUILD_HEADER,
  MIN_VIEWER_PROTOCOL,
  MIN_VIEWER_PROTOCOL_HEADER,
  PAGES_BUILD,
} from "../shared/build-identity.mjs";

const advertised = (pathname) => pathname === "/health" || pathname.startsWith("/api/");

/** Stamp the live build on API and health responses, so open viewers can see
 * a deploy from requests they already make. WebSocket upgrades pass through
 * unchanged: their 101 response cannot be rebuilt. */
export function advertiseBuild(request, response) {
  if (!advertised(new URL(request.url).pathname)) return response;
  if (response.status === 101 || response.webSocket) return response;
  // Durable Object and asset responses carry immutable headers.
  const stamped = new Response(response.body, response);
  stamped.headers.set(BUILD_HEADER, PAGES_BUILD);
  stamped.headers.set(MIN_VIEWER_PROTOCOL_HEADER, String(MIN_VIEWER_PROTOCOL));
  return stamped;
}
