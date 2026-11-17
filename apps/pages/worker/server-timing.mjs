// Phase timings for the `Server-Timing` response header.
//
// A recorder collects named phases of one request: how long each took, how
// many times it ran, and the slowest single run. Phases that run at once
// (shared-row checks, R2 reads) count their busy time, the wall time during
// which at least one run was in flight, never the sum of the runs.
//
// Clock: in Workers, `performance.now()` and `Date.now()` advance only across
// I/O. Every phase measured here waits on I/O (a Durable Object, D1, R2, an
// identity provider), so its duration is real. A phase of pure CPU work reads
// as zero; that is the platform's timer protection, not a bug to work around.
//
// What leaves: fixed lowercase metric names, durations in milliseconds and
// counts. Never an ID, principal, title, path, hash, error text or document
// content: the serializer accepts only names matching METRIC_NAME and writes
// only numbers after them.
//
// The Catalog Durable Object records its own phases and returns them on its
// internal answer in PHASE_TIMING_HEADER, in this same serialized form; the
// gateway merges them under a `cat_` prefix and removes the header.

/** Sent on a gateway request to the Catalog: record phases and return them. */
export const TIMING_REQUEST_HEADER = "x-pages-timing";
/** The Catalog's phases on its internal answer. The gateway always strips it. */
export const PHASE_TIMING_HEADER = "x-pages-phase-timing";

/** A metric name: lowercase token characters, short. */
const METRIC_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** The most characters one header value may hold. Metrics past it are dropped. */
export const SERVER_TIMING_MAX_LENGTH = 1536;

/** Whether this deployment sends `Server-Timing`. On unless
 * PAGES_SERVER_TIMING is `off`, `false` or `0`. */
export function serverTimingEnabled(env) {
  const value = env?.PAGES_SERVER_TIMING;
  if (typeof value !== "string") return true;
  return !["off", "false", "0"].includes(value.trim().toLowerCase());
}

const millis = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : 0);
const wholeCount = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);

/** A recorder. `now` returns milliseconds; tests pass a fake clock. */
export function createTiming({ now = () => performance.now() } = {}) {
  /** name -> { dur, n, max, active, since, timed } */
  const metrics = new Map();
  const entry = (name) => {
    let metric = metrics.get(name);
    if (!metric) {
      metric = { dur: 0, n: 0, max: 0, active: 0, since: 0, timed: false };
      metrics.set(name, metric);
    }
    return metric;
  };
  const timing = {
    /** Start one run of `name`; call the returned function when it ends.
     * Ending twice counts once. An invalid name records nothing. */
    start(name) {
      if (!METRIC_NAME.test(name)) return () => {};
      const metric = entry(name);
      const began = now();
      if (metric.active === 0) metric.since = began;
      metric.active += 1;
      metric.n += 1;
      metric.timed = true;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const at = now();
        metric.max = Math.max(metric.max, at - began);
        metric.active -= 1;
        if (metric.active === 0) metric.dur += at - metric.since;
      };
    },
    /** Run `work()` as one run of `name`, ending it however `work` settles. */
    async measure(name, work) {
      const end = timing.start(name);
      try {
        return await work();
      } finally {
        end();
      }
    },
    /** Add `amount` to `name`'s count without timing anything. */
    count(name, amount = 1) {
      if (!METRIC_NAME.test(name) || !wholeCount(amount)) return;
      entry(name).n += amount;
    },
    /** Add another recorder's entries, or a serialized header's, each name
     * behind `prefix`. Durations and counts add; the slowest run is kept. */
    merge(source, { prefix = "" } = {}) {
      const incoming = typeof source === "string" ? parseTiming(source) : (source?.entries() ?? []);
      for (const { name, dur, n, max } of incoming) {
        const full = `${prefix}${name}`;
        if (!METRIC_NAME.test(full)) continue;
        const metric = entry(full);
        if (dur !== undefined) {
          metric.timed = true;
          metric.dur += millis(dur);
          metric.max = Math.max(metric.max, millis(max ?? dur));
        }
        metric.n += wholeCount(n) || 1;
      }
    },
    /** `[{ name, dur?, n, max? }]` in first-recorded order. A run still in
     * flight counts up to now. */
    entries() {
      const at = now();
      return [...metrics].map(([name, metric]) => {
        if (!metric.timed) return { name, n: metric.n };
        const dur = metric.dur + (metric.active > 0 ? at - metric.since : 0);
        return { name, dur: millis(dur), n: metric.n, max: millis(metric.max) };
      });
    },
    /** The `Server-Timing` value, or "" when nothing was recorded. */
    header() {
      return serializeTiming(timing.entries());
    },
  };
  return timing;
}

/** Entries as a `Server-Timing` value: `name;dur=12.3`, with `desc="n=4"`
 * and a `name_max` metric for the slowest run when a phase ran more than
 * once. Invalid names are dropped, and metrics stop before the value passes
 * SERVER_TIMING_MAX_LENGTH. */
export function serializeTiming(entries) {
  const parts = [];
  let length = 0;
  for (const { name, dur, n, max } of entries) {
    if (!METRIC_NAME.test(name)) continue;
    const runs = wholeCount(n);
    const metrics = [];
    if (dur === undefined) metrics.push(`${name};desc="n=${runs}"`);
    else {
      metrics.push(`${name};dur=${millis(dur)}${runs > 1 ? `;desc="n=${runs}"` : ""}`);
      if (runs > 1 && METRIC_NAME.test(`${name}_max`))
        metrics.push(`${name}_max;dur=${millis(max)}`);
    }
    const piece = metrics.join(", ");
    const added = (parts.length ? 2 : 0) + piece.length;
    if (length + added > SERVER_TIMING_MAX_LENGTH) break;
    parts.push(piece);
    length += added;
  }
  return parts.join(", ");
}

/** The entries of a value `serializeTiming` wrote. Anything else in it is
 * skipped: a metric whose name or parameters don't match this module's own
 * form contributes nothing. A `name_max` beside `name` becomes its `max`. */
export function parseTiming(value) {
  if (typeof value !== "string" || value.length > SERVER_TIMING_MAX_LENGTH) return [];
  const parsed = new Map();
  for (const metric of value.split(",")) {
    const [name, ...params] = metric.trim().split(";");
    if (!METRIC_NAME.test(name)) continue;
    let dur;
    let n = 1;
    let valid = true;
    for (const param of params) {
      const duration = /^dur=(\d+(?:\.\d+)?)$/.exec(param);
      const runs = /^desc="n=(\d+)"$/.exec(param);
      if (duration) dur = Number(duration[1]);
      else if (runs) n = Number(runs[1]);
      else valid = false;
    }
    if (!valid || (dur !== undefined && !Number.isFinite(dur)) || !wholeCount(n)) continue;
    parsed.set(name, { name, ...(dur !== undefined && { dur, max: dur }), n });
  }
  for (const [name, metric] of parsed) {
    const base = name.endsWith("_max") ? parsed.get(name.slice(0, -4)) : undefined;
    if (base?.dur !== undefined && metric.dur !== undefined && base.n > 1) {
      base.max = metric.dur;
      parsed.delete(name);
    }
  }
  return [...parsed.values()];
}

/** A recorder that records nothing, for requests that aren't timed. */
export const NO_TIMING = Object.freeze({
  start: () => () => {},
  measure: async (_name, work) => work(),
  count() {},
  merge() {},
  entries: () => [],
  header: () => "",
});

const requestTimings = new WeakMap();

/** Time `request`'s phases in `timing`. Code that receives the request reads
 * it back with `timingFor`, so no signature has to carry it. */
export function attachTiming(request, timing) {
  requestTimings.set(request, timing);
  return request;
}

/** The recorder attached to `request`, or NO_TIMING. */
export function timingFor(request) {
  return requestTimings.get(request) ?? NO_TIMING;
}

/** `response` with `timing`'s `Server-Timing` value, when it has one. A
 * response whose headers refuse writes is copied first. */
export function withServerTiming(response, timing) {
  const value = timing.header();
  if (!value) return response;
  try {
    response.headers.set("server-timing", value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set("server-timing", value);
    return copy;
  }
}
