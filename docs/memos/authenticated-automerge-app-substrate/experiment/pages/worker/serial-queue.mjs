import { logFailure } from "./auth.mjs";
import { holdUntilSettled } from "./request-hold.mjs";

/*
 * One request at a time for a Durable Object, with a stuck-head watchdog.
 *
 * Catalog and Space objects serialize their requests. A request awaits Page
 * and Space fetches and credential checks that carry no deadline of their
 * own, so one await that never settles holds every later request until the
 * object is discarded. The watchdog discards it: once the running request
 * has run for `serialQueueBounds.runMs`, the object resets through
 * `ctx.abort()`, and the next request reaches a fresh instance.
 *
 * Two paths notice a stuck request. The running request's own timer fires at
 * the bound, and each arriving request checks the running request's age. The
 * second path does not depend on the stuck request's timer still running.
 *
 * Reset is safe for objects whose state is all in durable storage, which is
 * why Catalog and Space use this and Page does not: a Page holds live
 * document state and sockets. Catalog and Space operations already recover
 * from a restart through their stored operation intents.
 *
 * Each queued request also holds itself open with `holdUntilSettled`, so a
 * caller that goes away cannot leave its work half-run at the head
 * (request-hold.mjs).
 */

/** Mutable so tests can shorten them. A request still running at `runMs` has
 * outlived its caller's 60 s tool deadline twice. `projectionMs` bounds how
 * long a Page waits for its owner's or a member's Catalog to apply a title
 * projection. A caller without its own deadline needs one, because a reset
 * instance never answers the requests queued on it. */
export const serialQueueBounds = { runMs: 120_000, projectionMs: 10_000 };

const stuckError = () =>
  Object.assign(new Error("A queued request did not settle"), {
    status: 503,
    code: "request_timeout",
  });

/**
 * Serialize `work` for one object. `ctx` is the object's state; `stage`
 * names the object kind in logs. Returns a function with the shape of a
 * Durable Object's `fetch`: pass it the work for one request.
 */
export function serialQueue(ctx, stage) {
  let tail = Promise.resolve();
  let running;
  const reset = () => {
    logFailure(stuckError(), stage);
    // Throws in the calling invocation. Requests already queued on this
    // instance never settle; their callers' own deadlines answer them.
    ctx.abort?.(new Error("Pages restarted this account's queue. Try again."));
  };
  return (work) => {
    if (running && Date.now() - running.startedAt >= serialQueueBounds.runMs) reset();
    const next = tail.then(async () => {
      const current = { startedAt: Date.now() };
      running = current;
      const timer = setTimeout(() => {
        if (running !== current) return;
        try {
          reset();
        } catch {
          // The reset already took effect; nothing in this timer can recover.
        }
      }, serialQueueBounds.runMs);
      try {
        return await work();
      } finally {
        clearTimeout(timer);
        if (running === current) running = undefined;
      }
    });
    tail = next.catch(() => {});
    holdUntilSettled(ctx, tail);
    return next;
  };
}
