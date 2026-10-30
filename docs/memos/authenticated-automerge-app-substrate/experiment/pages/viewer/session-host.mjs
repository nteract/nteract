/**
 * The Page sessions this tab owns, in one Store.
 *
 * `current` is the installed session. `owned` lists every session that still
 * holds a replica: the installed one (`held: true`) and any being left
 * (`held: false`) until its backend is released. The reload gate reads this
 * store and each owned session's phase, so no caller registers sessions with
 * it. `generation` counts navigations; an open that started under an earlier
 * generation is stale and closes instead of installing.
 */
import { filter, take } from "rxjs";
import { Store } from "./store.mjs";

const keyOf = (session) => `${session.identity?.principal}:${session.pageId}`;
const terminal = (phase) => phase.name === "closed" || phase.name === "deleted";

export class SessionHost {
  store = new Store({ current: null, owned: [], generation: 0 });
  #request = null;
  #closing = new Map();
  #reloading = null;
  #watched = new WeakSet();

  get current() {
    return this.store.snapshot().current;
  }
  get generation() {
    return this.store.snapshot().generation;
  }
  isCurrent(generation) {
    return generation === this.generation;
  }

  /** Start a navigation: abort the previous opening request and make any
   * open still in flight stale. `request` is this navigation's own. */
  navigate(request = null) {
    this.#request?.abort();
    this.#request = request;
    const generation = this.generation + 1;
    this.store.update((state) => ({ ...state, generation }));
    return generation;
  }
  finishRequest(request) {
    if (this.#request === request) this.#request = null;
  }

  /** Install a session opened under `generation` for `principal`. Returns
   * false when the navigation or account moved on; the caller closes it. */
  install(session, generation, principal) {
    if (generation !== this.generation || session.identity?.principal !== principal) return false;
    this.store.update((state) => ({
      ...state,
      current: session,
      owned: [...state.owned.filter((entry) => entry.session !== session), { session, held: true }],
    }));
    this.#watch(session);
    return true;
  }

  /** Forget the installed session without leaving it; the caller leaves it. */
  detach() {
    const session = this.current;
    if (session) this.store.update((state) => ({ ...state, current: null }));
    return session;
  }

  /** Leave the installed session through its drain. `restore` says the owner
   * restored its previewed Page. */
  release({ restore = false, onError } = {}) {
    const session = this.detach();
    if (!session) return undefined;
    return this.leave(session, {
      onError,
      leaving: restore ? (left) => left.restore() ?? left.leave() : undefined,
    });
  }

  /** Leave a session through its drain, and track the close by Page until
   * the backend is released. The returned promise never rejects; `onError`
   * hears a failed close. */
  leave(session, { leaving = (left) => left.leave(), onError } = {}) {
    session.publishPresence?.(null);
    this.#own(session, false);
    const key = keyOf(session);
    let left;
    try {
      left = Promise.resolve(leaving(session));
    } catch (error) {
      left = Promise.reject(error);
    }
    const closing = left
      .catch((error) => onError?.(error))
      .finally(() => {
        if (this.#closing.get(key) === closing) this.#closing.delete(key);
        this.#drop(session);
      });
    this.#closing.set(key, closing);
    return closing;
  }

  /** Close a session at once, without the drain (sign-out, unmount). It is
   * tracked like any leave, so Reload waits for its checkpoint and keeps a
   * record if its edits never reached the server. */
  close(session, { onError } = {}) {
    if (!session) return Promise.resolve();
    return this.leave(session, { onError, leaving: (left) => left.close() });
  }

  /** The close of a Page this tab is leaving, if any. A quick Back waits for
   * it before opening the same Page again. */
  closingFor(principal, pageId) {
    return this.#closing.get(`${principal}:${pageId}`);
  }
  closingPages() {
    return [...this.#closing.values()];
  }

  /** Reload the installed session for its changed grant: archive and release
   * it, open the replacement, and install that. A failed archive returns the
   * session to the held set so its unsent edits keep blocking Reload. */
  async reloadAccess(previous, { install, onError }) {
    if (!previous || this.current !== previous || this.#reloading === previous) return;
    this.#reloading = previous;
    const generation = this.navigate();
    this.#own(previous, false);
    try {
      const next = await previous.reloadForAccess();
      await install(next, generation);
    } catch (error) {
      if (this.current === previous) onError?.(error);
    } finally {
      if (this.#reloading === previous) this.#reloading = null;
      if (previous.alive) this.#own(previous, true);
      else this.#drop(previous);
    }
  }

  #own(session, held) {
    this.store.update((state) => {
      const entry = state.owned.find((item) => item.session === session);
      if (entry?.held === held) return state;
      return {
        ...state,
        owned: entry
          ? state.owned.map((item) => (item === entry ? { session, held } : item))
          : [...state.owned, { session, held }],
      };
    });
    this.#watch(session);
  }

  #drop(session) {
    this.store.update((state) =>
      state.owned.some((entry) => entry.session === session)
        ? { ...state, owned: state.owned.filter((entry) => entry.session !== session) }
        : state,
    );
  }

  /** A held session can close on its own: deletion, sign-out, unmount. Drop
   * it once its backend is released. An access reload drops its own. */
  #watch(session) {
    if (this.#watched.has(session) || !session.phase$) return;
    this.#watched.add(session);
    session.phase$.state$
      .pipe(
        filter((phase) => terminal(phase) && !phase.archived),
        take(1),
      )
      .subscribe(() => {
        void Promise.resolve(session.closing)
          .catch(() => {})
          .then(() => this.#drop(session));
      });
  }
}
