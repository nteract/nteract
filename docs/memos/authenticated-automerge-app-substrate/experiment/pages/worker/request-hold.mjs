/**
 * Keep a Durable Object request running until `work` settles.
 *
 * celld 0.6.3 cancels a Durable Object request when its caller goes away: the
 * client of the gateway request that forwarded it disconnects (a tab
 * navigating away mid-fetch), or the calling object aborts its stub fetch.
 * Work the request already started then never resumes. Its timers and I/O are
 * dropped and its promise never settles. A request still waiting in a
 * serialized queue starts in that dead context when its turn comes. Either
 * way every later request in that queue waits behind it, and a shared read or
 * setup the request started never settles for the requests reusing it.
 *
 * `ctx.waitUntil` keeps the request running after its caller goes away, so
 * the work finishes and anything waiting on it moves on. Call this in the
 * same synchronous step that starts or queues the work, while the request is
 * still live. The hold never rejects; the caller still owns `work`'s result.
 * Partial objects without a `ctx`, as unit tests build them, hold nothing.
 */
export function holdUntilSettled(ctx, work) {
  ctx?.waitUntil?.(work.then(noop, noop));
}

function noop() {}
