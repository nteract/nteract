/*
 * Isolate-wide lookup caches that never share a pending promise.
 *
 * celld 0.6.3 resumes a promise continuation under the request whose I/O
 * settled that promise. If gateway request B awaits a module-level promise that
 * request A created, the rest of B runs inside A. When A responds, celld drops
 * the timers and I/O that B started, and B never settles. A pending promise
 * that never settles wedges every later caller on any runtime.
 *
 * So these caches hold settled values only. The request that starts a lookup
 * awaits its own attempt. Other requests for the same key poll on their own
 * timers until the attempt settles, then read the value in their own context.
 * An attempt holds its key until its deadline. Past it, the attempt is
 * abandoned: the next request starts a fresh one, and the abandoned attempt's
 * late result names an old generation, so it changes nothing. A failed attempt
 * frees the key at once and is not cached.
 *
 * Each request starts at most one attempt and waits at most `waitMs` for other
 * requests' attempts, so retries are bounded per request.
 *
 * `scripts/celld-context-probe.mjs` exits 0 once celld keeps request context
 * across shared promises. The deadlines here still bound hung lookups then.
 */

/**
 * One key's lifecycle.
 *
 * - `empty`: no fresh value and no running attempt.
 * - `loading`: attempt `generation` holds the key until `deadline`.
 * - `ready`: an attempt produced `value`, fresh until `expiresAt`.
 */
export type LookupState<V> =
  | { name: "empty" }
  | { name: "loading"; generation: number; deadline: number }
  | { name: "ready"; value: V; expiresAt: number };

/**
 * - `start`: a request starts attempt `generation` at `now`, held until `deadline`.
 * - `succeed` / `fail`: attempt `generation` settled.
 * - `expire`: the starter of attempt `generation` saw its deadline pass at `now`.
 * - `evict`: drop a cached `value` that a caller found unusable. Fenced by
 *   identity, so it never drops a newer value.
 */
export type LookupEvent<V> =
  | { type: "start"; generation: number; now: number; deadline: number }
  | { type: "succeed"; generation: number; value: V; expiresAt: number }
  | { type: "fail"; generation: number }
  | { type: "expire"; generation: number; now: number }
  | { type: "evict"; value: V };

export interface LookupTransition<V> {
  state: LookupState<V>;
  rejected?: string;
}

const EMPTY: LookupState<never> = { name: "empty" };

/** Pure transition. A rejected event returns the state unchanged. */
export function lookupTransition<V>(
  state: LookupState<V>,
  event: LookupEvent<V>,
): LookupTransition<V> {
  const reject = (rejected: string): LookupTransition<V> => ({ state, rejected });
  const running = (generation: number) =>
    state.name === "loading" && state.generation === generation ? state : undefined;
  switch (event.type) {
    case "start":
      if (state.name === "ready" && event.now < state.expiresAt) return reject("a value is fresh");
      if (state.name === "loading" && event.now < state.deadline)
        return reject("an attempt holds the key");
      return {
        state: { name: "loading", generation: event.generation, deadline: event.deadline },
      };
    case "succeed":
      return running(event.generation)
        ? { state: { name: "ready", value: event.value, expiresAt: event.expiresAt } }
        : reject("not the running attempt");
    case "fail":
      return running(event.generation) ? { state: EMPTY } : reject("not the running attempt");
    case "expire": {
      const attempt = running(event.generation);
      if (!attempt) return reject("not the running attempt");
      if (event.now < attempt.deadline) return reject("the attempt has time left");
      return { state: EMPTY };
    }
    case "evict":
      return state.name === "ready" && Object.is(state.value, event.value)
        ? { state: EMPTY }
        : reject("not the cached value");
  }
}

/** What a request does in `state` at `now`: use the value, wait, or start. */
export function lookupAction<V>(state: LookupState<V>, now: number): "hit" | "wait" | "start" {
  if (state.name === "ready" && now < state.expiresAt) return "hit";
  if (state.name === "loading" && now < state.deadline) return "wait";
  return "start";
}

export interface SettledLookupOptions {
  /** How long one attempt holds its key before the next request may replace it. */
  attemptMs: number;
  /** How long a request waits on attempts that other requests started. */
  waitMs: number;
  /** Interval of a waiting request's own timer. */
  pollMs?: number;
  /** Bound for string-keyed caches. Expired entries go first, then the least recently used. */
  maxEntries?: number;
  /** Error for a request whose attempt or wait ran out of time. */
  timeoutError: () => Error;
}

/** A loaded value and the time it stops being fresh. */
export interface SettledLookupResult<V> {
  value: V;
  expiresAt: number;
}

/**
 * Runs one attempt. `startedAt` is when the attempt began, before any provider
 * I/O. Measure `expiresAt` from it, never from completion, so a slow response
 * does not stretch how long a value stays reusable.
 */
export type SettledLookupLoader<V> = (
  signal: AbortSignal,
  startedAt: number,
) => Promise<SettledLookupResult<V>>;

export interface SettledLookup<K, V> {
  /**
   * Return the fresh value for `key`, wait for another request's attempt, or
   * run `load` as a new attempt. `signal` aborts when the attempt is abandoned.
   */
  get(key: K, load: SettledLookupLoader<V>): Promise<V>;
  /** Drop `value` for `key` if it is still the cached value. */
  evict(key: K, value: V): void;
  /** Current state for `key`. */
  state(key: K): LookupState<V>;
}

interface StateStore<K, V> {
  get(key: K): LookupState<V> | undefined;
  set(key: K, state: LookupState<V>): void;
  delete(key: K): void;
}

const DEFAULT_POLL_MS = 5;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createSettledLookup<K extends string, V>(
  options: SettledLookupOptions,
): SettledLookup<K, V>;
export function createSettledLookup<K extends object, V>(
  options: SettledLookupOptions & { weakKeys: true },
): SettledLookup<K, V>;
export function createSettledLookup<K, V>(
  options: SettledLookupOptions & { weakKeys?: boolean },
): SettledLookup<K, V> {
  const map = options.weakKeys ? undefined : new Map<K, LookupState<V>>();
  const states: StateStore<K, V> =
    map ?? (new WeakMap<object, LookupState<V>>() as unknown as StateStore<K, V>);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let generations = 0;

  const read = (key: K): LookupState<V> => states.get(key) ?? EMPTY;
  const step = (key: K, event: LookupEvent<V>): LookupTransition<V> => {
    const result = lookupTransition(read(key), event);
    if (!result.rejected) {
      if (result.state.name === "empty") states.delete(key);
      else states.set(key, result.state);
    }
    return result;
  };

  // Map order is recency: a hit moves its key to the end.
  const touch = (key: K, state: LookupState<V>) => {
    if (!map) return;
    map.delete(key);
    map.set(key, state);
  };

  // Make room before `key` starts an attempt. An evicted attempt's result is
  // fenced like an abandoned one.
  const prune = (key: K, now: number) => {
    if (!map || options.maxEntries === undefined) return;
    for (const [entryKey, state] of map) {
      if (entryKey !== key && lookupAction(state, now) === "start") map.delete(entryKey);
    }
    while (map.size >= options.maxEntries && !map.has(key)) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  };

  async function get(key: K, load: SettledLookupLoader<V>): Promise<V> {
    const waitUntil = Date.now() + options.waitMs;
    for (;;) {
      const state = read(key);
      const action = lookupAction(state, Date.now());
      if (action === "hit" && state.name === "ready") {
        touch(key, state);
        return state.value;
      }
      if (action === "start") break;
      if (Date.now() >= waitUntil) throw options.timeoutError();
      await sleep(pollMs);
    }

    // Claimed in the same synchronous step as the check above.
    const generation = ++generations;
    const startedAt = Date.now();
    const deadline = startedAt + options.attemptMs;
    prune(key, startedAt);
    step(key, { type: "start", generation, now: startedAt, deadline });

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          step(key, { type: "expire", generation, now: Date.now() });
          controller.abort();
          reject(options.timeoutError());
        },
        Math.max(0, deadline - Date.now()),
      );
    });
    try {
      const attempt = Promise.resolve().then(() => load(controller.signal, startedAt));
      const { value, expiresAt } = await Promise.race([attempt, expired]);
      step(key, { type: "succeed", generation, value, expiresAt });
      return value;
    } catch (error) {
      // No-op when the attempt already expired or was replaced.
      step(key, { type: "fail", generation });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get,
    evict: (key, value) => {
      step(key, { type: "evict", value });
    },
    state: read,
  };
}
