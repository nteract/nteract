/** Setting headers on a response that may not allow it.
 *
 * A response the Worker built itself has mutable headers. One that came back
 * from a Durable Object stub, a subrequest, R2 or the asset binding does not:
 * on Cloudflare Workers `headers.set` on it throws a TypeError. Callers here
 * hold either kind, so they set through this function. */

// The Response constructor refuses a body for these statuses, and a response
// with immutable headers can still carry an empty stream body for them.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Set each `[name, value]` on `response`. Returns the same response when its
 * headers are mutable, and a copy with the same status, body and other headers
 * when they are not. Not for WebSocket upgrades: a copy drops the socket. */
export function setResponseHeaders(response, headers) {
  try {
    for (const [name, value] of headers) response.headers.set(name, value);
    return response;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  const copy = new Response(
    NULL_BODY_STATUSES.has(response.status) ? null : response.body,
    response,
  );
  for (const [name, value] of headers) copy.headers.set(name, value);
  return copy;
}
