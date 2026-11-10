// A minute clock for relative times on screen. The store holds the current
// time in epoch milliseconds and moves once a period while connected, so
// "5m" becomes "6m" without a reload. React connects it on mount and
// disconnects it on unmount, like a Listing.
import { asyncScheduler, interval } from "rxjs";
import { Store } from "./store.mjs";

/** How often relative times refresh. */
export const CLOCK_PERIOD_MS = 60_000;

export class Clock {
  #now;
  #period;
  #scheduler;
  store;
  constructor({ now = Date.now, period = CLOCK_PERIOD_MS, scheduler = asyncScheduler } = {}) {
    this.#now = now;
    this.#period = period;
    this.#scheduler = scheduler;
    this.store = new Store(now());
  }
  snapshot() {
    return this.store.snapshot();
  }
  /** Tick while connected. Connecting reads the time at once, so a clock
   * built before mount shows the mount's time. Returns the disconnect. */
  connect() {
    const tick = () => this.store.update(() => this.#now());
    tick();
    const subscription = interval(this.#period, this.#scheduler).subscribe(tick);
    return () => subscription.unsubscribe();
  }
}
