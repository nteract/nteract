// One host-written document on this replica, read-only: the interpreter for
// host-doc-open-machine.mjs. The Page's sources document and each view
// document run one each. It finds the document discovery names, or the one
// its derived id names when something on the Page asks for it: on an
// admitted connection, or before one in this tab's stored bytes when the
// Page is open from them. It retries a failed lookup on a connection on a
// timer, and publishes the open document's current value
// as `doc$`, the only thing it exposes besides its state. Nothing here writes
// the document; the host refuses any change a browser sends for it. On
// retirement the replica drops the document from memory; its synced bytes
// stay in the tab's replica database, the same as the Page's and comments'
// synced bytes.
import { BehaviorSubject, asyncScheduler, timer } from "rxjs";
import { parseDocumentDescriptor } from "../model/document-types.mjs";
import { Store } from "./store.mjs";
import { monotonicNow } from "./monotonic.mjs";
import { discoveryEvent, hostDocOpenMachine } from "./host-doc-open-machine.mjs";

/** How long one lookup may take before it counts as failed. */
export const LOOKUP_TIMEOUT_MS = 15_000;

/** Repo's answer when the host said it holds no such document. */
export const UNAVAILABLE = /^Document \S+ is unavailable$/;

/**
 * The monotonic clock deadlines are measured on, in ms: monotonicNow
 * (monotonic.mjs) when timers run on RxJS's asyncScheduler, whose own now()
 * is the wall clock and can jump, and the scheduler's clock otherwise (a
 * virtual scheduler in tests), so deadlines and timers share one clock.
 */
export const monotonicClock = (scheduler) =>
  scheduler === asyncScheduler ? monotonicNow : () => scheduler.now();

/**
 * Drop `repo`'s cached answer that document `id` is unavailable, so the next
 * find asks the host. Only an entry still unavailable is evicted: the repo's
 * eviction closes the document for anyone holding it, so a document that
 * loaded since the miss stays. An entry still loading is a cancelled read
 * whose answer hasn't settled (a stored read with no connection settles
 * unavailable a moment later): the eviction waits for that answer, until
 * `signal` aborts.
 */
export async function evictUnavailable(repo, id, { signal } = {}) {
  const progress = repo?.findWithProgress?.(id);
  if (!progress) return;
  if (progress.peek().state === "loading") await progress.whenReady({ signal }).catch(() => {});
  if (progress.peek().state !== "unavailable") return;
  await repo.removeFromCache(id);
}

export class HostDocReplica {
  /** The machine's state (host-doc-open-machine.mjs). */
  state$ = new Store(hostDocOpenMachine.initial);
  #doc = new BehaviorSubject(undefined);
  /** The open document's current value, or undefined while none is open.
   * Emits synchronously on subscribe. */
  doc$ = this.#doc.asObservable();
  #handle;
  #found;
  #onChange;
  #lookup;
  #timer;
  /** The id whose unavailable answer the repo still holds from this
   * replica's last miss, until the next lookup of it evicts that answer. */
  #stale;
  #find;
  #forget;
  #claims;
  #installed;
  #link;
  #derive;
  #derived;
  #scheduler;
  #lookupTimeout;
  #linked;
  #stored;
  /** How many things on the Page ask for the document now (demand()). */
  #demand = 0;
  #clock;
  /** When the look-again window last armed ends, on #clock, and how long it
   * was: what is left of it is never longer than the window itself. */
  #lookAgainAt = -Infinity;
  #lookAgainWindow = 0;
  /** Advances on retire and close, so a derivation that settles after
   * either steps nothing. */
  #epoch = 0;

  /**
   * `find(id, { signal })` looks a document up in the replica's repo.
   * `forget(id, { signal })` drops the repo's record of a document it found
   * unavailable, so the next find asks the host again; `signal` is the
   * lookup's, which ends any wait for that record. It is called only
   * just before this replica looks `id` up again, and never for an id in
   * `claims`, the ids every replica on this repo has installed; the caller's
   * `forget` still checks the repo holds the unavailable answer.
   * `link()` names the connection a lookup runs on (undefined while none is
   * up): an unavailable answer on a link that is still up is the host's
   * answer, and one after the link changed is a lost connection.
   * `derive()` resolves with the document's derived id; without it the
   * replica opens only what discovery names.
   * `linked()` says whether lookups may run now (a connection is admitted
   * and the Page is shown); an ask while it is false waits for the next
   * connection.
   * `stored()` says whether the Page is open from this tab's stored copy and
   * shown. While it is true and `linked()` is false, an ask reads the
   * document from this tab's stored bytes, once (host-doc-open-machine.mjs
   * `stored`). Nothing reads storage until something asks.
   * `scheduler` runs the retry, look-again and lookup timers. `clock()`
   * reads monotonic ms for the look-again deadline (monotonicClock).
   */
  constructor({
    find,
    forget = async () => {},
    claims = new Set(),
    link = () => true,
    linked = () => true,
    stored = () => false,
    derive,
    scheduler = asyncScheduler,
    lookupTimeout = LOOKUP_TIMEOUT_MS,
    clock = monotonicClock(scheduler),
  }) {
    this.#clock = clock;
    this.#find = find;
    this.#forget = forget;
    this.#claims = claims;
    this.#link = link;
    this.#linked = linked;
    this.#stored = stored;
    this.#derive = derive;
    this.#scheduler = scheduler;
    this.#lookupTimeout = lookupTimeout;
  }

  /** The open document's value, or undefined. */
  get doc() {
    return this.#doc.getValue();
  }

  /** A connection was admitted with `connection` as its discovery, which
   * names the sources document. */
  discovered(connection) {
    const result = this.step(discoveryEvent(connection, parseDocumentDescriptor));
    // Discovery that names no document leaves it absent; standing demand
    // looks it up by its derived id.
    if (this.#demand > 0) this.want();
    return result;
  }

  /** A connection was admitted, and this document is found by its derived
   * id: a view document, which discovery doesn't list. */
  connected() {
    this.#withId((id) => {
      const wait = this.#remaining();
      return { type: "discovered", answer: "derived", id, ...(wait > 0 && { wait }) };
    });
  }

  /** Whether the look-again window last armed has ended (or none was). A
   * document that missed is due for its next lookup from then. */
  get due() {
    return this.#remaining() === 0;
  }

  /** Whole ms left in the look-again window last armed, at most the
   * window's own length, so no clock reading can stretch a rest. */
  #remaining() {
    const left = Math.ceil(this.#lookAgainAt - this.#clock());
    return Math.max(0, Math.min(left, this.#lookAgainWindow));
  }

  /** Something on the Page asks for the document. On a connection, only an
   * absent one is looked up again, at most once per look-again window.
   * Before one, a fresh closed replica reads this tab's stored copy once,
   * when the Page is open from it. A replica in any other state answers at
   * once, without deriving anything. */
  want() {
    const state = this.state$.snapshot();
    if (state.name === "absent" && this.#linked())
      return this.#withId((id) => ({ type: "wanted", id }));
    if (!this.#unread(state) || this.#linked() || !this.#stored()) return;
    // The derivation settles later: a connection admitted meanwhile looks
    // the document up on it instead.
    this.#withId((id) => (this.#linked() || !this.#stored() ? undefined : { type: "stored", id }));
  }

  /** A closed replica that hasn't read this tab's copy and has no misses. */
  #unread(state) {
    return state.name === "closed" && state.misses === undefined && !state.checked;
  }

  /** Something on the Page keeps asking for the document until it calls the
   * function this returns: it asks now (want()), and while any demand
   * stands, each look-again window that ends runs one lookup. */
  demand() {
    this.#demand++;
    this.want();
    let standing = true;
    return () => {
      if (!standing) return;
      standing = false;
      this.#demand--;
    };
  }

  /** The replica is retiring with the Page's other documents: a lookup is
   * cancelled and the document dropped from memory. */
  retire() {
    this.#epoch++;
    return this.step({ type: "retire" });
  }

  /** The replica closed or is being replaced. */
  close() {
    this.#epoch++;
    return this.step({ type: "close" });
  }

  /** Step the machine and run its effects at the edge. */
  step(event) {
    const result = hostDocOpenMachine.step(this.state$.snapshot(), event);
    if (result.rejected) return result;
    this.state$.update(() => result.state);
    for (const effect of result.effects) this.#run(effect);
    return result;
  }

  /** Step `event(id)` once the derived id is known, unless it reads
   * undefined then. */
  #withId(event) {
    if (!this.#derive) return;
    const epoch = this.#epoch;
    this.#derived ??= Promise.resolve().then(() => this.#derive());
    this.#derived.then(
      (id) => {
        if (epoch !== this.#epoch) return;
        const next = event(id);
        if (next) this.step(next);
      },
      () => {
        // A derivation that failed is tried again by the next ask.
        this.#derived = undefined;
      },
    );
  }

  #run(effect) {
    switch (effect.type) {
      case "lookup":
        return this.#start(effect);
      case "cancel":
        this.#lookup?.abort();
        this.#lookup = undefined;
        return;
      case "schedule":
        return this.#arm(effect.delay, () => ({ type: "timer", attempt: effect.attempt }));
      case "cool":
        this.#lookAgainAt = this.#clock() + effect.delay;
        this.#lookAgainWindow = effect.delay;
        return this.#arm(effect.delay, () => ({
          type: "cooled",
          ...(this.#demand > 0 && this.#linked() && { demanded: true }),
        }));
      case "clearTimer":
        this.#timer?.unsubscribe();
        this.#timer = undefined;
        return;
      case "forget":
        this.#stale = effect.id;
        return;
      case "install":
        return this.#install();
      case "uninstall":
        return this.#uninstall();
    }
    throw new Error(`unknown effect ${effect.type}`);
  }

  /** Arm the one timer; `event()` reads the event when it fires. */
  #arm(delay, event) {
    this.#timer?.unsubscribe();
    this.#timer = timer(delay, this.#scheduler).subscribe(() => {
      this.#timer = undefined;
      this.step(event());
    });
  }

  /** Evict the repo's unavailable answer for `id` if this replica's last
   * miss left one, right before looking `id` up again. */
  async #evict(id, signal) {
    if (this.#stale !== id) return;
    this.#stale = undefined;
    if (this.#claims.has(id)) return;
    try {
      await this.#forget(id, { signal });
    } catch {}
  }

  /** One lookup. Its result reaches the machine only through events that
   * name its attempt, so a cancelled one is ignored there. A stale answer
   * from this replica's last miss is evicted first. */
  #start({ attempt, id }) {
    this.#lookup?.abort();
    const lookup = new AbortController();
    this.#lookup = lookup;
    const link = this.#link();
    const deadline = timer(this.#lookupTimeout, this.#scheduler).subscribe(() =>
      lookup.abort(Object.assign(Error("The lookup timed out"), { name: "TimeoutError" })),
    );
    const settle = (event) => {
      deadline.unsubscribe();
      if (this.#lookup === lookup) this.#lookup = undefined;
      if (lookup.signal.aborted && lookup.signal.reason?.name !== "TimeoutError") return;
      this.step(event);
    };
    this.#evict(id, lookup.signal)
      .then(() => {
        lookup.signal.throwIfAborted();
        return this.#find(id, { signal: lookup.signal });
      })
      .then(
        (handle) => {
          if (lookup.signal.aborted) return settle({ type: "lookupFailed", attempt });
          this.#found = handle;
          settle({ type: "opened", attempt });
          if (this.#found === handle) this.#found = undefined;
        },
        (error) =>
          settle({
            // The host answered on a connection still up that it holds no
            // such document. Anything else may pass.
            type:
              !lookup.signal.aborted &&
              UNAVAILABLE.test(error?.message ?? "") &&
              link !== undefined &&
              this.#link() === link
                ? "unknown"
                : "lookupFailed",
            attempt,
          }),
      );
  }

  #install() {
    const handle = this.#found;
    this.#found = undefined;
    this.#uninstall();
    this.#handle = handle;
    this.#installed = this.state$.snapshot().id;
    this.#claims.add(this.#installed);
    this.#onChange = () => {
      if (this.#handle === handle) this.#doc.next(handle.doc());
    };
    handle.on("change", this.#onChange);
    this.#doc.next(handle.doc());
  }

  #uninstall() {
    if (this.#handle) this.#handle.off?.("change", this.#onChange);
    if (this.#installed !== undefined) this.#claims.delete(this.#installed);
    this.#installed = undefined;
    this.#handle = this.#onChange = undefined;
    if (this.#doc.getValue() !== undefined) this.#doc.next(undefined);
  }
}
