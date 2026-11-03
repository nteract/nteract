import { defineMachine, reject } from "../shared/machine.mjs";

/**
 * When a Page's content last changed, as its host records and reports it.
 *
 * Content is the Page document's `title` and `blocks`. The host records the
 * time it accepted a change to either, from a browser, an agent tool or any
 * other writer, on its own clock: an author's clock never sets it. Comments
 * live in their own document, and presence, ACL and lifecycle changes live
 * outside the Page document, so none of them count. Neither do the host's own
 * migrations (preserved Markdown conversion, moving legacy comments out),
 * which rewrite how content is stored but not what it says; the host ignores
 * changes while its conversion machine is `converting`.
 *
 * Writes coalesce. The first change after a quiet window flushes at once; later
 * changes in the window keep only the newest time in memory, and one flush at
 * the window's end writes it. A flush stores the time under
 * `CONTENT_ACTIVITY_KEY` and then reports it (one D1 batch and one call to the
 * owner's Catalog), so a Page writes storage and reports at most once per
 * `intervalMs`, however fast it's edited. A host evicted before its trailing
 * flush loses at most one window: the stored time lags the last accepted
 * change by at most `intervalMs`.
 *
 * States, each carrying `latest` (newest observed, ISO), `durable` (newest
 * stored and reported, ISO), `flushedAt` (ms of the last good flush) and
 * `attempt` (failed flushes in a row):
 * - idle: nothing newer than `durable` waits.
 * - waiting: `latest` waits for `dueAt` (window end or retry backoff).
 * - flushing: a flush of `value` is running.
 * - stopped: the host closed this Page (Trash, purge, deletion). Terminal:
 *   every later event is refused, so a late flush outcome, change or nudge
 *   can't arm a timer or write into a deleted Page.
 *
 * Events: `restored` (the stored time, at startup, at `now`), `changed`
 * (content changed at `now`), `due` (the timer, or a request nudging a lost
 * one, at `now`), `flushed` and `failed` (the running flush's outcome, at
 * `now`), `stop`.
 *
 * Effects: `arm` a timer for `at`; `flush` `value`; `cancel` the timer and
 * anything not yet run.
 *
 * Where effects run. celld 0.6.3 runs a promise continuation inside a Durable
 * Object under the request that started the awaiting code, and drops the
 * timers and I/O started there once that request has responded. The
 * repository's `change` events come from its scheduler's loop, which keeps
 * the context of the request that opened the document, long finished. A flush
 * started from the listener stores its time, then its D1 batch, its Catalog
 * call and their timeouts never settle, and the machine waits in `flushing`
 * for good. So `changed()` only steps the machine and defers its effects;
 * they run from a live request: `pump()` at a request's edges, and `serve()`,
 * a loop a resident socket's request runs while it's open. A window timer
 * armed from a live request is held on it until it fires; a longer retry
 * backoff isn't, and the next request or socket wake nudges it.
 */
export const CONTENT_ACTIVITY_KEY = "host/content-activity";
export const CONTENT_ACTIVITY_INTERVAL_MS = 60_000;
export const CONTENT_ACTIVITY_MAX_BACKOFF_MS = 15 * 60_000;
/** How far ahead of a writer's clock a content time may be. page10 and Pages
 * run on more than one node, and a Page host can move between them. */
export const CONTENT_ACTIVITY_MAX_SKEW_MS = 5 * 60_000;

// Exactly `Date#toISOString`'s format: listings compare these as strings, so
// the latest is the lexical max only while every value has the same shape.
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** A timestamp as listings store and compare it. */
export const validTime = (value) =>
  typeof value === "string" && isoTime.test(value) && Number.isFinite(Date.parse(value));
/** The later of two timestamps; null when neither is one. */
export const laterTime = (a, b) => {
  const x = validTime(a) ? a : null;
  const y = validTime(b) ? b : null;
  return x === null ? y : y === null ? x : x < y ? y : x;
};
/** True when `value` is further ahead of `now` (ms) than clocks may skew. */
export const aheadOfClock = (value, now) =>
  validTime(value) && Date.parse(value) > now + CONTENT_ACTIVITY_MAX_SKEW_MS;
/** `value` when it's a timestamp a writer whose clock reads `now` may store,
 * otherwise null: a time from a clock running ahead would pin the Page to the
 * top of activity listings until real time caught up. */
export const acceptedTime = (value, now = Date.now()) =>
  validTime(value) && !aheadOfClock(value, now) ? value : null;

/** Delay before retry `attempt` (1 for the first failure). */
export const retryDelay = (attempt) =>
  Math.min(CONTENT_ACTIVITY_INTERVAL_MS * 2 ** (attempt - 1), CONTENT_ACTIVITY_MAX_BACKOFF_MS);

/** True when `patches` touch the Page's title or blocks. */
export const changesContent = (patches) =>
  Array.isArray(patches) &&
  patches.some((patch) => patch?.path?.[0] === "title" || patch?.path?.[0] === "blocks");

const iso = (now) => new Date(now).toISOString();
const base = ({ latest, durable, flushedAt, attempt }) => ({ latest, durable, flushedAt, attempt });
const time = (value, label) => {
  if (value !== null && !validTime(value)) throw Error(`${label} must be an ISO time or null`);
};
const ms = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`${label} must be a time in ms`);
};
const fields = (state) => {
  time(state.latest, "latest");
  time(state.durable, "durable");
  if (state.flushedAt !== null) ms(state.flushedAt, "flushedAt");
  if (!Number.isSafeInteger(state.attempt) || state.attempt < 0)
    throw Error("attempt must be a count");
};
const at = (event) => ms(event.now, "now");

export const contentActivityMachine = defineMachine({
  name: "content-activity",
  states: ["idle", "waiting", "flushing", "stopped"],
  events: ["restored", "changed", "due", "flushed", "failed", "stop"],
  initial: { name: "idle", latest: null, durable: null, flushedAt: null, attempt: 0 },
  unreachable: [
    ["waiting", "restored", "the host restores before it observes a change"],
    ["flushing", "restored", "the host restores before it observes a change"],
    ["idle", "flushed", "only a running flush reports an outcome"],
    ["idle", "failed", "only a running flush reports an outcome"],
    ["waiting", "flushed", "only a running flush reports an outcome"],
    ["waiting", "failed", "only a running flush reports an outcome"],
  ],
  cases: {
    "idle/restored": ["stored", "ahead"],
    "idle/changed": ["not-newer", "window-open", "window-closed"],
    "waiting/changed": ["before-due", "past-due"],
    "waiting/due": ["early", "on-time"],
    "flushing/flushed": ["caught-up", "newer-waits"],
  },
  validate: {
    states: {
      idle: fields,
      waiting: (state) => {
        fields(state);
        ms(state.dueAt, "dueAt");
      },
      flushing: (state) => {
        fields(state);
        time(state.value, "value");
        if (state.value === null) throw Error("a flush needs a value");
      },
      stopped: fields,
    },
    events: {
      restored: (event) => {
        time(event.value, "value");
        if (event.value === null) throw Error("restored needs a value");
        at(event);
      },
      changed: at,
      due: at,
      flushed: at,
      failed: at,
      stop: () => {},
    },
    effects: {
      arm: (effect) => ms(effect.at, "at"),
      flush: (effect) => time(effect.value, "value"),
      cancel: () => {},
    },
  },
  transition(state, event) {
    if (state.name === "stopped") return reject(state, "the Page host stopped");
    const flush = (fieldsNow) => ({
      state: { name: "flushing", ...fieldsNow, value: fieldsNow.latest },
      effects: [{ type: "flush", value: fieldsNow.latest }],
    });
    const wait = (fieldsNow, dueAt) => ({
      state: { name: "waiting", ...fieldsNow, dueAt },
      effects: [{ type: "arm", at: dueAt }],
    });
    switch (event.type) {
      case "restored": {
        // idle only (see unreachable). A time stored by this Page's host on a
        // node whose clock ran ahead would refuse every real change until
        // that clock's time passed.
        if (aheadOfClock(event.value, event.now))
          return reject(state, "the stored time is ahead of this clock");
        return {
          state: {
            ...state,
            latest: laterTime(state.latest, event.value),
            durable: laterTime(state.durable, event.value),
          },
          effects: [],
        };
      }
      case "changed": {
        const next = { ...base(state), latest: laterTime(state.latest, iso(event.now)) };
        if (state.name === "flushing") return { state: { ...state, ...next }, effects: [] };
        if (state.name === "waiting") {
          if (event.now >= state.dueAt) return flush(next);
          return { state: { ...state, ...next }, effects: [] };
        }
        // A clock behind the stored time observes nothing newer.
        if (next.latest === state.durable) return reject(state, "not newer than the stored time");
        if (state.flushedAt === null || event.now - state.flushedAt >= CONTENT_ACTIVITY_INTERVAL_MS)
          return flush(next);
        return wait(next, state.flushedAt + CONTENT_ACTIVITY_INTERVAL_MS);
      }
      case "due": {
        if (state.name === "idle") return reject(state, "nothing waits");
        if (state.name === "flushing") return reject(state, "a flush is running");
        if (event.now < state.dueAt) return reject(state, "not due yet");
        return flush(base(state));
      }
      case "flushed": {
        const next = {
          ...base(state),
          durable: laterTime(state.durable, state.value),
          flushedAt: event.now,
          attempt: 0,
        };
        if (next.latest === next.durable) return { state: { name: "idle", ...next }, effects: [] };
        return wait(next, event.now + CONTENT_ACTIVITY_INTERVAL_MS);
      }
      case "failed": {
        const attempt = state.attempt + 1;
        return wait({ ...base(state), attempt }, event.now + retryDelay(attempt));
      }
      case "stop":
        return { state: { name: "stopped", ...base(state) }, effects: [{ type: "cancel" }] };
    }
  },
});

/**
 * Runs the machine for one Page host. `flush(value)` stores and reports one
 * time and rejects on failure; `hold(work)` keeps the calling request running
 * until `work` settles. `setTimer` and `clearTimer` default to the globals;
 * tests pass their own to lose a timer as celld does.
 */
export class ContentActivity {
  #state = contentActivityMachine.initial;
  #timer;
  #timerDone;
  #restored;
  /** Effects `changed()` stepped to but didn't run, at most one per type. */
  #deferred = [];
  /** Resolvers for `serve()` loops waiting for deferred effects. */
  #waiters = new Set();
  constructor({
    storage,
    report,
    hold = () => {},
    onError = () => {},
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (timer) => clearTimeout(timer),
  }) {
    this.storage = storage;
    this.report = report;
    this.hold = hold;
    this.onError = onError;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  /** The machine's state, for tests and diagnostics. */
  get state() {
    return this.#state;
  }

  /** The newest content change this host knows of, or null. */
  get value() {
    return this.#state.latest;
  }

  /** Whether effects wait for a live request to run them. */
  get pending() {
    return this.#deferred.length > 0;
  }

  /** Read the stored time once. Call before observing changes. */
  restore() {
    this.#restored ??= (async () => {
      const stored = await this.storage.get(CONTENT_ACTIVITY_KEY);
      if (validTime(stored?.content_updated_at) && this.#state.name === "idle")
        this.#step({ type: "restored", value: stored.content_updated_at, now: this.now() });
    })();
    return this.#restored;
  }

  /** Content changed now. Safe from any context: effects wait for `pump()`. */
  changed() {
    this.#step({ type: "changed", now: this.now() }, { defer: true });
  }

  /** From a live request: run deferred effects, then flush a wait whose timer
   * never fired. Cheap when nothing waits. */
  pump() {
    this.#run(this.#deferred.splice(0));
    this.nudge();
  }

  /** Flush a wait whose timer never fired. Call from a live request. */
  nudge() {
    if (this.#state.name === "waiting" && this.now() >= this.#state.dueAt)
      this.#step({ type: "due", now: this.now() });
  }

  /** From a live request that stays open, such as a resident socket's: pump
   * whenever `changed()` defers effects, until `until` settles or the host
   * stops. Its continuations run in the caller's request. */
  async serve(until) {
    let open = true;
    const close = () => {
      open = false;
      this.#wake();
    };
    until.then(close, close);
    while (open && this.#state.name !== "stopped") {
      if (this.#deferred.length) this.pump();
      await new Promise((resolve) => this.#waiters.add(resolve));
    }
  }

  /** Terminal: cancels the timer and anything deferred; later events are
   * refused, including a running flush's outcome. */
  stop() {
    this.#step({ type: "stop" });
  }

  #wake() {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const resolve of waiters) resolve();
  }

  #step(event, { defer = false } = {}) {
    const result = contentActivityMachine.step(this.#state, event);
    this.#state = result.state;
    if (!defer) return this.#run(result.effects);
    for (const effect of result.effects) {
      this.#deferred = this.#deferred.filter((queued) => queued.type !== effect.type);
      this.#deferred.push(effect);
    }
    if (result.effects.length) this.#wake();
  }

  #run(effects) {
    for (const effect of effects) {
      if (effect.type === "arm") this.#arm(effect.at);
      else if (effect.type === "flush") this.hold(this.#flush(effect.value));
      else if (effect.type === "cancel") {
        this.#clearTimer();
        this.#deferred = [];
        this.#wake();
      }
    }
  }

  #arm(at) {
    this.#clearTimer();
    const delay = Math.max(0, at - this.now());
    let done;
    const fired = new Promise((resolve) => {
      done = resolve;
    });
    this.#timerDone = done;
    this.#timer = this.setTimer(() => {
      this.#timer = undefined;
      this.#timerDone = undefined;
      try {
        if (this.#state.name === "waiting") this.#step({ type: "due", now: this.now() });
      } finally {
        done();
      }
    }, delay);
    // A Durable Object stays resident while it serves; Node and tests don't
    // stay up for it.
    this.#timer?.unref?.();
    // The window's end flushes in this live request. A retry backoff can be
    // fifteen minutes, longer than a request should stay open.
    if (delay <= CONTENT_ACTIVITY_INTERVAL_MS) this.hold(fired);
  }

  #clearTimer() {
    if (this.#timer !== undefined) this.clearTimer(this.#timer);
    this.#timer = undefined;
    this.#timerDone?.();
    this.#timerDone = undefined;
  }

  async #flush(value) {
    try {
      await this.storage.put(CONTENT_ACTIVITY_KEY, { content_updated_at: value });
      // Stopped while storing: the host deletes the key after this put.
      if (this.#state.name === "stopped") return;
      await this.report(value);
    } catch (error) {
      if (this.#state.name === "stopped") return;
      this.onError(error);
      this.#step({ type: "failed", now: this.now() });
      return;
    }
    if (this.#state.name === "stopped") return;
    this.#step({ type: "flushed", now: this.now() });
  }
}
