/** HTTPS for requests that reach the gateway through Cloudflare.
 *
 * The tunnel's last hop (cloudflared -> celld) is plain HTTP, so `request.url`
 * always says `http:` and can't tell a visitor's scheme. The Cloudflare edge
 * adds `CF-Visitor: {"scheme":"http"|"https"}` to every proxied request, and
 * cloudflared passes it through to the origin. That header is the only signal
 * read here:
 *
 * - `http` -> 308 to the same URL with `https:`, before any routing. The
 *   session cookie is `__Host-` and Secure, and the viewer needs a secure
 *   context, so nothing on plain HTTP can work.
 * - `https` -> the response gains `Strict-Transport-Security`.
 * - absent or unreadable -> served as-is. That covers the local listener
 *   (operator calls on the host, deploy health polls), `npm run dev` and tests.
 *
 * `X-Forwarded-Proto` is not read. The gateway already treats it as
 * untrusted client input (see mcp-gateway and access-gateway tests), and
 * Cloudflare sets both headers together, so it adds nothing.
 *
 * HSTS has no `includeSubDomains` or `preload`: other runtimed.run hosts are
 * not Pages', and pinning them is not this host's call. */

import { setResponseHeaders } from "./response-headers.mjs";

export const HSTS = "max-age=31536000";

/** The visitor's scheme at the Cloudflare edge, or null when the request did
 * not come through Cloudflare or the header is malformed. */
export function edgeScheme(request) {
  const raw = request.headers.get("cf-visitor");
  if (!raw || raw.length > 256) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const scheme = typeof parsed?.scheme === "string" ? parsed.scheme.toLowerCase() : null;
  return scheme === "http" || scheme === "https" ? scheme : null;
}

/** A 308 to the HTTPS form of a plain-HTTP edge request, or null. Path and
 * query are kept; 308 keeps the method and body. The host comes from
 * `NOTEBOOK_CLOUD_PUBLIC_ORIGIN` when set, because a tunnel can give the
 * inbound URL a private origin; otherwise from the request URL. A WebSocket
 * upgrade gets the same answer: clients don't follow redirects on a handshake,
 * so it fails with a visible 308 instead of syncing over a scheme that can't
 * carry the cookie. */
export function httpsRedirect(request, env = {}) {
  if (edgeScheme(request) !== "http") return null;
  const inbound = new URL(request.url);
  const publicOrigin = env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN?.trim();
  // Set path and query as fields: resolving them as a relative URL would let
  // a `//host/...` path pick the redirect's host.
  const url = new URL(publicOrigin || inbound.origin);
  url.pathname = inbound.pathname;
  url.search = inbound.search;
  url.protocol = "https:";
  if (!publicOrigin) url.port = "";
  return new Response(`Pages is served over HTTPS: ${url.href}\n`, {
    status: 308,
    headers: { location: url.href, "content-type": "text/plain; charset=utf-8" },
  });
}

/** Add HSTS to a response for an HTTPS edge request. Other responses, and
 * WebSocket upgrades, are returned untouched. */
export function withTransportSecurity(request, response) {
  if (edgeScheme(request) !== "https") return response;
  if (response.status === 101 || response.webSocket) return response;
  return setResponseHeaders(response, [["strict-transport-security", HSTS]]);
}
