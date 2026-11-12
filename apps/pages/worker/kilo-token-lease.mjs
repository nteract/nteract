/** How long this isolate keeps what Kilo said about an agent token, so a
 * token costs one exchange with Kilo and not one per call.
 *
 * Each token, keyed by its SHA-256, has one lifecycle:
 *
 * - `absent`: nothing is known. A request starts an exchange.
 * - `exchanging`: attempt `generation` is asking Kilo. It holds the key until
 *   its exchange settles, or at most until `deadline`, its own hold from the
 *   moment it started. Holding the key keeps one token's exchanges serial:
 *   other requests for it wait on their own timers.
 * - `leased`: Kilo accepted the token. Every request uses `value` until
 *   `until`.
 * - `refused`: Kilo refused the token itself, until `until`. Every request
 *   for it gets the same `failure` without an exchange. The caller decides
 *   which failures are refusals and how long each is kept (`rememberFor`).
 * - `expired`: a lease, a refusal or an attempt is over, or an attempt
 *   failed in a way that says nothing about the token. The entry leaves.
 *
 * A transient failure, such as Kilo being unreachable, reaches only the
 * request that made that exchange. A request that was waiting acts on the
 * state it finds next: it uses a lease, takes a refusal, waits on a running
 * attempt, or starts its own.
 *
 * Two clocks run here, and each has one owner:
 *
 * - An attempt owns the key and one in-flight slot from its start until its
 *   exchange settles, and never past `holdMs` from its start, which is
 *   longer than the exchange's own timeout. Its answer drives the
 *   transition whether or not anyone still waits for it: a late success
 *   installs the lease for the next request, a late refusal is kept, a late
 *   transient failure leaves nothing.
 * - A request waits at most `holdMs` from its arrival, whether it waits on
 *   another attempt, starts its own, or both. When it gives up, the attempt
 *   it started keeps running.
 *
 * Gateway requests never await a promise another request started
 * (isolate-setup.mjs says why): the request that starts an attempt awaits
 * it, and the others poll the state on their own timers.
 *
 * The table is bounded twice, so tokens nobody has seen can't crowd out
 * tokens in use:
 *
 * - At most `maxInFlight` attempts hold a slot at once: started, not
 *   settled, and within their own hold. A request that would start another
 *   is refused with `busy()` without asking Kilo.
 * - At most `maxEntries` tokens are kept. To admit a new token, a refusal
 *   leaves first, then any entry whose time is over, oldest first. A running
 *   exchange and a live lease never leave early: when only they remain, the
 *   new token is refused with `busy()`.
 *
 * The table holds account ids, names, verified addresses, organizations and
 * refusals, never a token. */

/** The longest a lease lasts after its exchange, whatever the token says. */
export const MAX_LEASE_MS = 15 * 60 * 1000;
/** How many tokens one isolate remembers. */
export const MAX_ENTRIES = 1000;
/** How many exchanges one isolate runs at once. */
export const MAX_IN_FLIGHT = 8;
/** The longest token lifetime (`exp - iat`, seconds) Pages leases. */
export const MAX_TOKEN_LIFETIME_SECONDS = 900;
/** How far Pages' clock may run behind Kilo's before a lease outlives `exp`. */
export const CLOCK_ALLOWANCE_MS = 30_000;

/** When an entry's time is over, or undefined for one with no end. */
function endOf(state) {
  if (state.name === "exchanging") return state.deadline;
  if (state.name === "leased" || state.name === "refused") return state.until;
  return undefined;
}

/**
 * One token's transition. Events:
 *
 * - `start` (`generation`, `now`, `deadline`): a request begins an attempt,
 *   which holds the key until `deadline`. Refused while a lease or a refusal
 *   is live or an attempt holds the token.
 * - `settle` (`generation`, `now`, `value`, `until`): the attempt succeeded,
 *   even after the request that started it gave up. A lease that would
 *   already be over is `expired`.
 * - `refuse` (`generation`, `failure`, `until`): Kilo refused the token;
 *   every request gets `failure` until `until`.
 * - `fail` (`generation`): the attempt failed and nothing is kept.
 * - `expire` (`now`): a lease, a refusal or an attempt is over.
 *
 * `settle`, `refuse` and `fail` change only the attempt they name, so a late
 * answer from an abandoned attempt changes nothing. Returns `{ state }`, or
 * `{ state, rejected }` with the state unchanged.
 */
export function leaseTransition(state, event) {
  const reject = (rejected) => ({ state, rejected });
  const current = state.name === "exchanging" && state.generation === event.generation;
  switch (event.type) {
    case "start":
      if (state.name === "leased" && event.now < state.until) return reject("the lease is live");
      if (state.name === "refused" && event.now < state.until) return reject("the refusal is live");
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
    case "refuse":
      if (!current) return reject("not the running exchange");
      return { state: { name: "refused", failure: event.failure, until: event.until } };
    case "fail":
      if (!current) return reject("not the running exchange");
      return { state: { name: "expired" } };
    case "expire": {
      const end = endOf(state);
      if (end === undefined) return reject("nothing to expire");
      if (event.now < end) return reject("not yet over");
      return { state: { name: "expired" } };
    }
    default:
      return reject("unknown event");
  }
}

/** What a request does in `state` at `now`: `use` the lease, `fail` with the
 * refusal, `wait` for the running exchange, or `start` an exchange. */
export function leaseAction(state, now) {
  if (state.name === "leased" && now < state.until) return "use";
  if (state.name === "refused" && now < state.until) return "fail";
  if (state.name === "exchanging" && now < state.deadline) return "wait";
  return "start";
}

/** Whether an entry may leave to admit another token at `now`: anything but
 * a running exchange or a live lease. */
export function evictable(state, now) {
  if (state.name === "exchanging") return now >= state.deadline;
  if (state.name === "leased") return now >= state.until;
  return true;
}

/**
 * The end of the lease of a token Kilo accepted, or null for none. `claims`
 * are the token's `iat` and `exp`, read only after Kilo accepted it;
 * `sentAt` and `settledAt` are Pages' clock when the exchange was sent and
 * when it answered. Pages can't know Kilo's clock, so the lease ends at the
 * earliest of: `exp` by Pages' clock less `CLOCK_ALLOWANCE_MS`; the token's
 * whole lifetime (`exp - iat`) after the exchange was sent, or after it
 * answered if the clock moved back between the two; and `MAX_LEASE_MS` after
 * the same moment. A lease can therefore outlast the token by the clock
 * difference between Pages and Kilo, never by more than the token's whole
 * lifetime. `iat` and `exp` must be whole seconds with
 * `0 < exp - iat <= MAX_TOKEN_LIFETIME_SECONDS`; anything else, millisecond
 * values included, gives no lease.
 */
export function leaseEnd(claims, { sentAt, settledAt }) {
  const iat = claims?.iat;
  const exp = claims?.exp;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return null;
  const lifetime = exp - iat;
  if (lifetime <= 0 || lifetime > MAX_TOKEN_LIFETIME_SECONDS) return null;
  const anchor = Math.min(sentAt, settledAt);
  const until = Math.min(
    exp * 1000 - CLOCK_ALLOWANCE_MS,
    anchor + lifetime * 1000,
    anchor + MAX_LEASE_MS,
  );
  return until > settledAt ? until : null;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
const realSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * A lease table for one isolate. `resolve(key, exchange)` returns the leased
 * value for `key`, or runs `exchange()` when there is none. `exchange`
 * returns `{ value, until }`, with `until` null for no lease, and throws to
 * fail. `rememberFor(failure)` says how many milliseconds a failure is kept
 * as a refusal of the token; 0 keeps nothing. `busy(reason)` builds the
 * failure for a request turned away by a bound or by its own deadline.
 *
 * `holdMs` is how long one request waits at most from its arrival, and how
 * long an attempt may hold its key and slot from its start; it is longer
 * than the exchange's own timeout. `now`, `sleep` and `pollMs` let tests
 * drive time.
 */
export function kiloTokenLease({
  holdMs,
  busy,
  rememberFor = () => 0,
  pollMs = 5,
  maxEntries = MAX_ENTRIES,
  maxInFlight = MAX_IN_FLIGHT,
  now = Date.now,
  sleep = realSleep,
} = {}) {
  if (!(holdMs > 0)) throw new TypeError("holdMs is required");
  if (typeof busy !== "function") throw new TypeError("busy is required");
  const entries = new Map();
  let generations = 0;
  const stateOf = (key) => entries.get(key) ?? { name: "absent" };
  const step = (key, event) => {
    const result = leaseTransition(stateOf(key), event);
    if (result.rejected) return result;
    // Re-inserted, so iteration order is the order of last transition.
    entries.delete(key);
    if (result.state.name !== "expired") entries.set(key, result.state);
    return result;
  };
  const inFlight = (at) => {
    let count = 0;
    for (const state of entries.values())
      if (state.name === "exchanging" && at < state.deadline) count++;
    return count;
  };
  /** Makes room for one more token, or returns false when only running
   * exchanges and live leases remain. */
  const admit = (at) => {
    if (entries.size < maxEntries) return true;
    for (const pass of [(state) => state.name === "refused", (state) => evictable(state, at)])
      for (const [key, state] of entries)
        if (pass(state)) {
          entries.delete(key);
          return true;
        }
    return false;
  };
  const resolve = async (key, exchange) => {
    const deadline = now() + holdMs;
    for (;;) {
      if (now() >= deadline) throw busy("wait_timeout");
      const state = stateOf(key);
      const action = leaseAction(state, now());
      if (action === "use") return state.value;
      if (action === "fail") throw state.failure;
      if (action === "start") break;
      await sleep(Math.min(pollMs, deadline - now()));
    }
    // Checked and claimed in the same synchronous step. The attempt holds
    // the key and a slot from now until its exchange settles, or for
    // `holdMs` from now at most, whatever becomes of this request.
    const at = now();
    step(key, { type: "expire", now: at });
    if (inFlight(at) >= maxInFlight) throw busy("exchanges_in_flight");
    if (!entries.has(key) && !admit(at)) throw busy("lease_capacity");
    const generation = ++generations;
    step(key, { type: "start", generation, now: at, deadline: at + holdMs });
    const attempt = Promise.resolve().then(exchange);
    // The attempt's answer drives the transition even after this request
    // has given up; a stale generation changes nothing.
    attempt.then(
      (answer) => {
        const settledAt = now();
        step(key, {
          type: "settle",
          generation,
          now: settledAt,
          value: answer.value,
          until: answer.until ?? settledAt,
        });
      },
      (failure) => {
        const remember = rememberFor(failure);
        step(
          key,
          remember > 0
            ? { type: "refuse", generation, failure, until: now() + remember }
            : { type: "fail", generation },
        );
      },
    );
    const stop = new AbortController();
    const abandoned = {};
    let answer;
    try {
      answer = await Promise.race([
        attempt,
        sleep(Math.max(0, deadline - now()), stop.signal).then(() => abandoned),
      ]);
    } finally {
      stop.abort();
    }
    if (answer === abandoned) throw busy("wait_timeout");
    return answer.value;
  };
  return { resolve, size: () => entries.size, state: stateOf, inFlight: () => inFlight(now()) };
}
