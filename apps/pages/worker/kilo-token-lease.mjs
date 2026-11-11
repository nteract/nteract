/** How long this isolate keeps the person a Kilo agent token names, so a
 * token costs one exchange with Kilo and not one per call.
 *
 * Each token, keyed by its SHA-256, has one lifecycle:
 *
 * - `absent`: nothing is known. The next request starts an exchange.
 * - `exchanging`: attempt `generation` is asking Kilo, until `deadline`.
 *   Other requests for the token wait for it on their own timers.
 * - `leased`: Kilo accepted the token. Requests use `value` until `until`.
 * - `expired`: the lease ended, or the attempt was abandoned at its deadline.
 *   The next request starts an exchange, which Kilo then refuses for a token
 *   past its own expiry.
 * - `refused`: attempt `generation` failed. Only the requests that waited for
 *   that attempt get its failure, and only until `until`; any other request
 *   starts a new exchange. A refusal is never reused.
 *
 * Gateway requests never await a promise another request started
 * (isolate-setup.mjs says why): the request that starts an exchange awaits
 * it, and the others poll the state on their own timers.
 *
 * The lease holds an account id and name, never the token. Entries are kept
 * in the order of their last transition, and the oldest leave first once
 * there are `maxEntries`. */

/** The longest a lease lasts after its exchange, whatever the token says. */
export const MAX_LEASE_MS = 15 * 60 * 1000;
/** How many tokens one isolate remembers. */
export const MAX_ENTRIES = 1000;

/**
 * One token's transition. Events:
 *
 * - `start` (`generation`, `now`, `deadline`): a request begins an exchange.
 *   Refused while a lease is live or an attempt holds the token.
 * - `settle` (`generation`, `now`, `value`, `until`): the attempt succeeded.
 *   A lease that would already be over is `expired`.
 * - `fail` (`generation`, `failure`, `until`): the attempt failed; its waiters
 *   may read `failure` until `until`.
 * - `expire` (`now`): a lease, an attempt or a refusal is past its time.
 *
 * `settle` and `fail` change only the attempt they name, so a late answer
 * from an abandoned attempt changes nothing. Returns `{ state }`, or
 * `{ state, rejected }` with the state unchanged.
 */
export function leaseTransition(state, event) {
  const reject = (rejected) => ({ state, rejected });
  const current = state.name === "exchanging" && state.generation === event.generation;
  switch (event.type) {
    case "start":
      if (state.name === "leased" && event.now < state.until) return reject("the lease is live");
      if (state.name === "exchanging" && event.now < state.deadline)
        return reject("an exchange holds the token");
      return {
        state: { name: "exchanging", generation: event.generation, deadline: event.deadline },
      };
    case "settle":
      if (!current) return reject("not the running exchange");
      return {
        state:
          event.until > event.now
            ? { name: "leased", value: event.value, until: event.until }
            : { name: "expired" },
      };
    case "fail":
      if (!current) return reject("not the running exchange");
      return {
        state: {
          name: "refused",
          generation: event.generation,
          failure: event.failure,
          until: event.until,
        },
      };
    case "expire": {
      const end =
        state.name === "leased" || state.name === "refused"
          ? state.until
          : state.name === "exchanging"
            ? state.deadline
            : undefined;
      if (end === undefined) return reject("nothing to expire");
      if (event.now < end) return reject("not yet over");
      return { state: { name: "expired" } };
    }
    default:
      return reject("unknown event");
  }
}

/** What a request does in `state` at `now`: `use` the lease, `wait` for the
 * running exchange, `fail` with the failure of the exchange it waited for
 * (`joined`), or `start` an exchange of its own. */
export function leaseAction(state, now, joined) {
  if (state.name === "leased" && now < state.until) return "use";
  if (state.name === "exchanging" && now < state.deadline) return "wait";
  if (
    state.name === "refused" &&
    joined !== undefined &&
    state.generation === joined &&
    now < state.until
  )
    return "fail";
  return "start";
}

/** The end of a lease that starts at `now` for a token whose `exp` (seconds)
 * Kilo has accepted: the token's own expiry, and never more than
 * `MAX_LEASE_MS` away. A missing or malformed `exp` gives no lease. */
export function leaseEnd(exp, now) {
  if (typeof exp !== "number" || !Number.isFinite(exp)) return now;
  return Math.min(exp * 1000, now + MAX_LEASE_MS);
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A lease table for one isolate. `resolve(key, exchange)` returns the leased
 * value for `key`, or runs `exchange()` when there is none. `exchange` returns
 * `{ value, until }` and throws to refuse; its error reaches this request and
 * the requests that waited for it, and is not kept for any other.
 *
 * `holdMs` is how long an exchange holds its key before it is abandoned and
 * how long its waiters may read a failure; it is longer than the exchange's
 * own timeout. `now`, `sleep` and `pollMs` let tests drive time.
 */
export function kiloTokenLease({
  holdMs,
  pollMs = 5,
  maxEntries = MAX_ENTRIES,
  now = Date.now,
  sleep = realSleep,
} = {}) {
  if (!(holdMs > 0)) throw new TypeError("holdMs is required");
  const entries = new Map();
  let generations = 0;
  const stateOf = (key) => entries.get(key) ?? { name: "absent" };
  const step = (key, event) => {
    const result = leaseTransition(stateOf(key), event);
    if (result.rejected) return result;
    // Re-inserted, so iteration order is the order of last transition.
    entries.delete(key);
    if (result.state.name !== "expired") entries.set(key, result.state);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return result;
  };
  const resolve = async (key, exchange) => {
    let joined;
    for (;;) {
      const state = stateOf(key);
      const action = leaseAction(state, now(), joined);
      if (action === "use") return state.value;
      if (action === "fail") throw state.failure;
      if (action === "start") break;
      joined = state.generation;
      await sleep(pollMs);
    }
    // Claimed in the same synchronous step as the check above.
    const generation = ++generations;
    step(key, { type: "expire", now: now() });
    step(key, { type: "start", generation, now: now(), deadline: now() + holdMs });
    try {
      const { value, until } = await exchange();
      step(key, { type: "settle", generation, now: now(), value, until });
      return value;
    } catch (failure) {
      step(key, { type: "fail", generation, failure, until: now() + holdMs });
      throw failure;
    }
  };
  return { resolve, size: () => entries.size, state: stateOf };
}
