/**
 * The interpreter for catch-up-machine.mjs: it steps the machine, runs its
 * threshold timer on an RxJS scheduler, and says when "Catching up…" starts
 * or stops showing.
 */
import { EMPTY, Subject, asyncScheduler, map, switchMap, timer } from "rxjs";
import { catchingUp, viewerCatchUpMachine } from "./catch-up-machine.mjs";
import { Store } from "./store.mjs";

export class CatchUp {
  store = new Store(viewerCatchUpMachine.initial);
  #arm$ = new Subject();
  #timer;
  #onChange;

  /** `onChange(showing)` hears each change in whether catch-up shows. */
  constructor({ scheduler = asyncScheduler, onChange = () => {} } = {}) {
    this.#onChange = onChange;
    this.#timer = this.#arm$
      .pipe(
        switchMap((armed) =>
          armed === null ? EMPTY : timer(armed.ms, scheduler).pipe(map(() => armed.attempt)),
        ),
      )
      .subscribe((attempt) => this.dispatch({ type: "elapsed", attempt }));
  }

  /** Whether the status line says "Catching up…". */
  get showing() {
    return catchingUp(this.store.snapshot());
  }

  /** Step the machine. A rejected event changes nothing. */
  dispatch(event) {
    const before = this.showing;
    const result = viewerCatchUpMachine.step(this.store.snapshot(), event);
    if (result.rejected) return result;
    this.store.update(() => result.state);
    for (const effect of result.effects)
      this.#arm$.next(effect.type === "startTimer" ? effect : null);
    if (this.showing !== before) this.#onChange(this.showing);
    return result;
  }

  /** Stop the timer. Later events still step the machine but arm nothing. */
  close() {
    this.#timer.unsubscribe();
  }
}
