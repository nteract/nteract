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
 * which rewrite how content is stored but not what it says; the host
 * suppresses observation while one runs.
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
 *
 * Events: `restored` (the stored time, at startup), `changed` (content changed
 * at `now`), `due` (the timer, or a request nudging a lost one, at `now`),
 * `flushed` and `failed` (the running flush's outcome, at `now`).
 *
 * Effects: `arm` a timer for `at`; `flush` `value`.
 *
 * The timer isn't held open: a request that arrives after `dueAt` nudges a
 * timer that never fired, and so does the next change.
 */
export const CONTENT_ACTIVITY_KEY = "host/content-activity";
export const CONTENT_ACTIVITY_INTERVAL_MS = 60_000;
export const CONTENT_ACTIVITY_MAX_BACKOFF_MS = 15 * 60_000;

const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
/** A timestamp as listings store and compare it. */
export const validTime = (value) => typeof value === "string" && isoTime.test(value);
/** The later of two timestamps; null when neither is one. */
export const laterTime = (a, b) => {
  const x = validTime(a) ? a : null;
  const y = validTime(b) ? b : null;
  return x === null ? y : y === null ? x : x < y ? y : x;
};

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
  states: ["idle", "waiting", "flushing"],
  events: ["restored", "changed", "due", "flushed", "failed"],
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
    },
    events: {
      restored: (event) => {
        time(event.value, "value");
        if (event.value === null) throw Error("restored needs a value");
      },
      changed: at,
      due: at,
      flushed: at,
      failed: at,
    },
    effects: {
      arm: (effect) => ms(effect.at, "at"),
      flush: (effect) => time(effect.value, "value"),
    },
  },
  transition(state, event) {
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
        // idle only (see unreachable).
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
    }
  },
});

/**
 * Runs the machine for one Page host. `flush(value)` stores and reports one
 * time and rejects on failure; `hold(work)` keeps a flush running if its
 * request goes away. Timers come from `timers` so tests can drive them.
 */
export class ContentActivity {
  #state = contentActivityMachine.initial;
  #timer;
  #restored;
  constructor({ storage, report, hold = () => {}, onError = () => {}, now = () => Date.now() }) {
    this.storage = storage;
    this.report = report;
    this.hold = hold;
    this.onError = onError;
    this.now = now;
  }

  /** The machine's state, for tests and diagnostics. */
  get state() {
    return this.#state;
  }

  /** The newest content change this host knows of, or null. */
  get value() {
    return this.#state.latest;
  }

  /** Read the stored time once. Call before observing changes. */
  restore() {
    this.#restored ??= (async () => {
      const stored = await this.storage.get(CONTENT_ACTIVITY_KEY);
      if (validTime(stored?.content_updated_at))
        this.#step({ type: "restored", value: stored.content_updated_at });
    })();
    return this.#restored;
  }

  /** Content changed now. */
  changed() {
    this.#step({ type: "changed", now: this.now() });
  }

  /** Flush a wait whose timer never fired. Cheap when nothing is due. */
  nudge() {
    if (this.#state.name === "waiting" && this.now() >= this.#state.dueAt)
      this.#step({ type: "due", now: this.now() });
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #step(event) {
    const result = contentActivityMachine.step(this.#state, event);
    this.#state = result.state;
    for (const effect of result.effects) {
      if (effect.type === "arm") {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(
          () => {
            this.#timer = undefined;
            if (this.#state.name === "waiting") this.#step({ type: "due", now: this.now() });
          },
          Math.max(0, effect.at - this.now()),
        );
        // A Durable Object stays resident while it serves; Node and tests
        // don't stay up for it.
        this.#timer?.unref?.();
      } else if (effect.type === "flush") this.hold(this.#flush(effect.value));
    }
  }

  async #flush(value) {
    try {
      await this.storage.put(CONTENT_ACTIVITY_KEY, { content_updated_at: value });
      await this.report(value);
    } catch (error) {
      this.onError(error);
      this.#step({ type: "failed", now: this.now() });
      return;
    }
    this.#step({ type: "flushed", now: this.now() });
  }
}
