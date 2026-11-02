/**
 * The interpreter for catch-up-machine.mjs: it steps the machine, runs its
 * threshold and limit timers on an RxJS scheduler, checks frontiers against
 * this replica with `holds`, and says when "Catching up…" starts or stops
 * showing.
 */
import { EMPTY, Subject, asyncScheduler, map, merge, switchMap, timer } from "rxjs";
import { catchingUp, keptFrontier, viewerCatchUpMachine } from "./catch-up-machine.mjs";
import { Store } from "./store.mjs";

const NOTHING = () => false;

export class CatchUp {
  store = new Store(viewerCatchUpMachine.initial);
  #timer$ = new Subject();
  #limit$ = new Subject();
  #timers;
  #holds;
  #onChange;
  #onTimeout;

  /**
   * - `holds(frontier)`: whether this replica holds a `{ page, comments }`
   *   frontier now.
   * - `onChange(showing)`: each change in whether catch-up shows.
   * - `onTimeout(attempt)`: the limit passed before this replica was proven
   *   current.
   */
  constructor({
    scheduler = asyncScheduler,
    holds = NOTHING,
    onChange = () => {},
    onTimeout = () => {},
  } = {}) {
    this.#holds = holds;
    this.#onChange = onChange;
    this.#onTimeout = onTimeout;
    const arm = (subject, type) =>
      subject.pipe(
        switchMap((armed) =>
          armed === null
            ? EMPTY
            : timer(armed.ms, scheduler).pipe(map(() => ({ type, attempt: armed.attempt }))),
        ),
      );
    this.#timers = merge(arm(this.#timer$, "elapsed"), arm(this.#limit$, "expired")).subscribe(
      (event) => this.dispatch(event),
    );
  }

  /** Whether the status line says "Catching up…". */
  get showing() {
    return catchingUp(this.store.snapshot());
  }

  /** The admitted socket's count; frontier requests carry it back. */
  get attempt() {
    return this.store.snapshot().attempt;
  }

  admitted() {
    return this.dispatch({ type: "admitted" });
  }

  disconnected() {
    return this.dispatch({ type: "disconnected" });
  }

  /** A remote change was applied: recheck the kept frontier. */
  remote() {
    const frontier = keptFrontier(this.store.snapshot());
    return this.dispatch({ type: "remote", held: !!frontier && this.#check(frontier) });
  }

  /** The host answered a request sent during `attempt` with `frontier`. */
  answered(attempt, frontier) {
    return this.dispatch({ type: "answered", attempt, frontier, held: this.#check(frontier) });
  }

  #check(frontier) {
    try {
      return !!this.#holds(frontier);
    } catch {
      return false;
    }
  }

  /** Step the machine. A rejected event changes nothing. */
  dispatch(event) {
    const before = this.showing;
    const result = viewerCatchUpMachine.step(this.store.snapshot(), event);
    if (result.rejected) return result;
    this.store.update(() => result.state);
    for (const effect of result.effects)
      if (effect.type === "startTimer") this.#timer$.next(effect);
      else if (effect.type === "cancelTimer") this.#timer$.next(null);
      else if (effect.type === "startLimit") this.#limit$.next(effect);
      else if (effect.type === "cancelLimit") this.#limit$.next(null);
      else if (effect.type === "timedOut") this.#onTimeout(effect.attempt);
    if (this.showing !== before) this.#onChange(this.showing);
    return result;
  }

  /** Stop the timers. Later events still step the machine but arm nothing. */
  close() {
    this.#timers.unsubscribe();
  }
}
