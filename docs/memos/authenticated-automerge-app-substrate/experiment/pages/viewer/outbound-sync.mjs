/**
 * The interpreter for outbound-sync-machine.mjs: it holds what waits to go
 * out and runs the machine's timer on an RxJS scheduler.
 *
 * What waits is one start callback per native tree (the backend's
 * scheduleLocalSync hook) and the newest caret publication. A send starts the
 * sync rounds first, so a caret never goes out ahead of a round that was
 * already waiting with it.
 */
import { EMPTY, Subject, asyncScheduler, switchMap, timer } from "rxjs";
import { outboundSyncMachine } from "./outbound-sync-machine.mjs";

export class OutboundSync {
  #state = outboundSyncMachine.initial;
  #scheduler;
  #onError;
  #syncs = new Map();
  #presence = null;
  #arm$ = new Subject();
  #timer;

  /** `onError` hears a start or publish callback that threw; the rest of the
   * send still runs. */
  constructor({ scheduler = asyncScheduler, onError = () => {} } = {}) {
    this.#scheduler = scheduler;
    this.#onError = onError;
    this.#timer = this.#arm$
      .pipe(switchMap((ms) => (ms === null ? EMPTY : timer(ms, scheduler))))
      .subscribe(() => this.#dispatch({ type: "timer" }));
  }

  /** The machine's state, for tests and diagnostics. */
  get state() {
    return this.#state;
  }

  /** SubductionBackend's `scheduleLocalSync` option. A tree's later request
   * replaces its earlier one: either starts the same coalescing round. */
  scheduleLocalSync = (id, start) => {
    this.#syncs.set(id, start);
    this.#request();
  };

  /** Publish a caret with the next send. Only the newest publication goes. */
  publish(send) {
    this.#presence = send;
    this.#request();
  }

  /** Send whatever is waiting now. */
  flush() {
    this.#dispatch({ type: "flush" });
  }

  /** Send whatever is waiting and stop batching: later requests go out at
   * once. */
  close() {
    this.#dispatch({ type: "close" });
    this.#timer.unsubscribe();
  }

  #request() {
    this.#dispatch({ type: "request", at: this.#scheduler.now() });
  }

  #dispatch(event) {
    const result = outboundSyncMachine.step(this.#state, event);
    if (result.rejected) return;
    this.#state = result.state;
    for (const effect of result.effects)
      if (effect.type === "arm") this.#arm$.next(effect.ms);
      else if (effect.type === "cancel") this.#arm$.next(null);
      else if (effect.type === "send") this.#send();
  }

  #send() {
    const starts = [...this.#syncs.values()];
    const presence = this.#presence;
    this.#syncs.clear();
    this.#presence = null;
    for (const run of [...starts, ...(presence ? [presence] : [])])
      try {
        run();
      } catch (error) {
        this.#onError(error);
      }
  }
}
