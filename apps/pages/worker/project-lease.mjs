import { defineMachine, reject } from "../shared/machine.mjs";

/**
 * In-place renewal of a Page host's cached Project access lease while
 * Project-inherited sync sockets are open.
 *
 * One runner per Page host renews the shared Project snapshot ahead of
 * `valid_until`, so healthy Project readers stay connected across lease
 * boundaries without closing and reconnecting every 15 seconds. One Project
 * lookup serves every open socket on the Page. When the Project is
 * unavailable, existing socket deadlines remain untouched and each socket's
 * own expiry timer still closes fail-closed at `valid_until`.
 *
 * States, each carrying a monotonic `token` fencing late refresh outcomes:
 * - idle: no open socket is bound to the Page's Project lease.
 * - armed: waiting until `at` (ahead of `validUntil`, or retry backoff) to
 *   refresh the Project snapshot.
 * - refreshing: one `resolve` call for `token` is running.
 * - stopped: terminal state once the Page host retires or deletes.
 *
 * Where effects run. On celld 0.6.3 a timer or fetch started inside a closed
 * request context is dropped. Each open resident socket passes its lifetime
 * into `serve(until)`; one active socket acts as the timer/fetch driver at a
 * time, and if that socket closes while another remains open, the next socket
 * takes over and re-arms the pending renewal in its own live request.
 */

export const PROJECT_LEASE_RENEW_AHEAD_MS = 5_000;
export const PROJECT_LEASE_RETRY_MS = 1_000;

/** When to start renewing a lease that ends at `validUntil`, from `now`. */
export const renewAt = (validUntil, now) =>
  Math.max(now, validUntil - PROJECT_LEASE_RENEW_AHEAD_MS);

const ms = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`${label} must be a time in ms`);
};
const token = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) throw Error("token must be a count");
};
const at = (event) => ms(event.now, "now");

export const projectLeaseMachine = defineMachine({
  name: "project-lease",
  states: ["idle", "armed", "refreshing", "stopped"],
  events: ["leaseBound", "due", "resolved", "unavailable", "socketsGone", "stop"],
  initial: { name: "idle", token: 0 },
  cases: {
    "armed/leaseBound": ["unchanged", "later", "earlier-rearm", "earlier-keep"],
    "refreshing/leaseBound": ["later", "not-later"],
    "armed/due": ["early", "on-time"],
    "refreshing/resolved": ["stale", "still-bound", "unbound"],
    "refreshing/unavailable": ["stale", "retry", "no-room"],
  },
  validate: {
    states: {
      idle: (state) => token(state.token),
      armed: (state) => {
        token(state.token);
        ms(state.validUntil, "validUntil");
        ms(state.at, "at");
      },
      refreshing: (state) => {
        token(state.token);
        ms(state.validUntil, "validUntil");
      },
      stopped: (state) => token(state.token),
    },
    events: {
      leaseBound: (event) => {
        ms(event.validUntil, "validUntil");
        at(event);
      },
      due: at,
      resolved: (event) => {
        token(event.token);
        if (event.validUntil !== null) ms(event.validUntil, "validUntil");
        at(event);
      },
      unavailable: (event) => {
        token(event.token);
        at(event);
      },
      socketsGone: () => {},
      stop: () => {},
    },
    effects: {
      arm: (effect) => ms(effect.at, "at"),
      resolve: (effect) => token(effect.token),
      cancel: () => {},
    },
  },
  transition(state, event) {
    if (state.name === "stopped") return reject(state, "the Project lease runner stopped");
    switch (event.type) {
      case "leaseBound": {
        if (state.name === "idle") {
          const nextAt = renewAt(event.validUntil, event.now);
          return {
            state: { name: "armed", token: state.token, validUntil: event.validUntil, at: nextAt },
            effects: [{ type: "arm", at: nextAt }],
          };
        }
        if (state.name === "armed") {
          if (event.validUntil === state.validUntil)
            return reject(state, "already armed for this lease");
          if (event.validUntil > state.validUntil) {
            const nextAt = renewAt(event.validUntil, event.now);
            return {
              state: {
                name: "armed",
                token: state.token,
                validUntil: event.validUntil,
                at: nextAt,
              },
              effects: [{ type: "arm", at: nextAt }],
            };
          }
          const nextAt = Math.min(state.at, renewAt(event.validUntil, event.now));
          return {
            state: { name: "armed", token: state.token, validUntil: event.validUntil, at: nextAt },
            effects: nextAt === state.at ? [] : [{ type: "arm", at: nextAt }],
          };
        }
        if (event.validUntil > state.validUntil)
          return {
            state: { name: "refreshing", token: state.token, validUntil: event.validUntil },
            effects: [],
          };
        return reject(state, "a refresh is already running");
      }
      case "due": {
        if (state.name === "idle") return reject(state, "no lease is armed");
        if (state.name === "refreshing") return reject(state, "a refresh is already running");
        if (event.now < state.at) return reject(state, "not due yet");
        const nextToken = state.token + 1;
        return {
          state: { name: "refreshing", token: nextToken, validUntil: state.validUntil },
          effects: [{ type: "resolve", token: nextToken }],
        };
      }
      case "resolved": {
        if (state.name !== "refreshing") return reject(state, "no refresh is running");
        if (event.token !== state.token) return reject(state, "stale refresh outcome");
        if (event.validUntil === null)
          return { state: { name: "idle", token: state.token }, effects: [] };
        const nextAt = renewAt(event.validUntil, event.now);
        return {
          state: { name: "armed", token: state.token, validUntil: event.validUntil, at: nextAt },
          effects: [{ type: "arm", at: nextAt }],
        };
      }
      case "unavailable": {
        if (state.name !== "refreshing") return reject(state, "no refresh is running");
        if (event.token !== state.token) return reject(state, "stale refresh outcome");
        const retryAt = event.now + PROJECT_LEASE_RETRY_MS;
        if (retryAt < state.validUntil)
          return {
            state: { name: "armed", token: state.token, validUntil: state.validUntil, at: retryAt },
            effects: [{ type: "arm", at: retryAt }],
          };
        return { state: { name: "idle", token: state.token }, effects: [] };
      }
      case "socketsGone": {
        if (state.name === "idle") return reject(state, "already idle");
        return { state: { name: "idle", token: state.token }, effects: [{ type: "cancel" }] };
      }
      case "stop":
        return { state: { name: "stopped", token: state.token }, effects: [{ type: "cancel" }] };
    }
  },
});

/**
 * Runs `projectLeaseMachine` for one Page host.
 * `resolve()` refreshes the Page's Project snapshot, updates connected sockets,
 * and returns the next Project-bound `validUntil` in ms, or `null` when no
 * Project-bound socket remains. Throwing signals transient unavailability.
 */
export class ProjectLease {
  #state = projectLeaseMachine.initial;
  #timer;
  #timerAt;
  #driver = null;
  #runners = new Map();
  #pendingResolve = null;

  constructor({
    resolve,
    onError = () => {},
    now = () => Date.now(),
    setTimer = (fn, msDelay) => setTimeout(fn, msDelay),
    clearTimer = (timer) => clearTimeout(timer),
  }) {
    this.resolve = resolve;
    this.onError = onError;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  get state() {
    return this.#state;
  }

  leaseBound(validUntil) {
    this.#step({ type: "leaseBound", validUntil, now: this.now() });
  }

  socketsGone() {
    this.#step({ type: "socketsGone" });
  }

  stop() {
    this.#step({ type: "stop" });
  }

  /** Keep renewal timers and fetches inside a live resident socket's request.
   * One socket drives at a time; when it closes, another live socket takes
   * over and re-arms the timer (or retries an interrupted refresh). */
  async serve(until) {
    let open = true;
    const runner = { wake: null };
    this.#runners.set(runner, runner);
    const close = () => {
      if (!open) return;
      open = false;
      this.#runners.delete(runner);
      if (this.#driver === runner) {
        this.#clearTimer();
        this.#pendingResolve = null;
        this.#driver = null;
        if (this.#state.name === "refreshing" && this.#runners.size > 0)
          this.#step({
            type: "unavailable",
            token: this.#state.token,
            now: this.now(),
          });
        this.#wakeOne();
      }
      runner.wake?.();
    };
    until.then(close, close);
    while (open && this.#state.name !== "stopped") {
      if (!this.#driver) this.#driver = runner;
      if (this.#driver === runner) this.#drive();
      await new Promise((resolve) => {
        runner.wake = resolve;
      });
      runner.wake = null;
    }
    close();
  }

  #wakeDriver() {
    if (this.#driver?.wake) this.#driver.wake();
    else this.#wakeOne();
  }

  #wakeOne() {
    for (const runner of this.#runners.values()) {
      if (runner.wake) {
        runner.wake();
        return;
      }
    }
  }

  #step(event) {
    const result = projectLeaseMachine.step(this.#state, event);
    this.#state = result.state;
    if (result.rejected) return result;
    for (const effect of result.effects) {
      if (effect.type === "cancel") {
        this.#clearTimer();
        this.#pendingResolve = null;
        if (this.#state.name === "stopped") {
          for (const runner of this.#runners.values()) runner.wake?.();
        }
      } else if (effect.type === "arm") {
        this.#clearTimer();
        this.#wakeDriver();
      } else if (effect.type === "resolve") {
        this.#pendingResolve = effect.token;
        this.#wakeDriver();
      }
    }
    return result;
  }

  #drive() {
    if (this.#pendingResolve !== null) {
      const activeToken = this.#pendingResolve;
      this.#pendingResolve = null;
      if (this.#state.name === "refreshing" && activeToken === this.#state.token) {
        this.#runResolve(activeToken);
        return;
      }
    }
    if (this.#state.name === "armed") {
      if (this.#timer !== undefined && this.#timerAt === this.#state.at) return;
      this.#arm(this.#state.at);
    } else {
      this.#clearTimer();
    }
  }

  #arm(targetAt) {
    this.#clearTimer();
    this.#timerAt = targetAt;
    const delay = Math.max(0, targetAt - this.now());
    this.#timer = this.setTimer(() => {
      this.#timer = undefined;
      this.#timerAt = undefined;
      if (this.#state.name !== "armed") return;
      const current = this.now();
      if (current < this.#state.at) {
        this.#arm(this.#state.at);
        return;
      }
      this.#step({ type: "due", now: current });
    }, delay);
    this.#timer?.unref?.();
  }

  #clearTimer() {
    if (this.#timer !== undefined) this.clearTimer(this.#timer);
    this.#timer = undefined;
    this.#timerAt = undefined;
  }

  #runResolve(activeToken) {
    void (async () => {
      let validUntil;
      try {
        validUntil = await this.resolve();
      } catch (error) {
        this.onError(error);
        this.#step({ type: "unavailable", token: activeToken, now: this.now() });
        return;
      }
      this.#step({ type: "resolved", token: activeToken, validUntil, now: this.now() });
    })();
  }
}
