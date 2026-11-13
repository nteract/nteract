// A Page's view documents on this replica, read-only: one HostDocReplica
// (host-doc-replica.mjs) per view id, each driven by host-doc-open-machine.mjs.
// The host lists no view in discovery, so each view is found by the id it
// derives from the Page id and the view id, on the live connection.
//
// Who holds each view, and whether it has a slot, is view-hold-machine.mjs.
// A held view with a slot has an open replica that asks for its document for
// as long as it is held: one lookup per look-again window while the document
// isn't there. The last holder letting go starts the close delay, so an
// embed the editor moves keeps its document.
//
// At most `limit` views (MAX_VIEWS) have a slot at once. The cap bounds the
// lookups and timers in flight; it is not a verdict on any view. A view
// named while every slot is taken waits, and gets a slot when one frees:
//
// - a view in its close delay (no holder) gives its slot up first;
// - a view with no document drawn (missing, or its lookups failed) gives its
//   slot to a view that hasn't had one, and waits behind it;
// - views whose documents are missing take turns: a waiting one whose
//   look-again window ended takes the slot of one that already looked in
//   its slot and whose window ended too. Each turn is one lookup, so the
//   slots together run about one lookup per slot per window however many
//   ids wait. A replica keeps its misses and its window through a turn
//   (host-doc-open-machine.mjs), so a turn never starts a new burst.
//
// The host holds at most MAX_VIEWS views per Page, so a body can name more
// than MAX_VIEWS ids only with ids whose documents are missing. Those are
// the ones that give way: every existing view gets a slot, and draws, while
// its embed holds it.
//
// Before a connection, a held view with a slot reads this tab's stored copy
// once. A view whose stored read missed keeps its slot until a connection
// answers: its replica is closed, neither undrawn nor due, so nothing evicts
// it. On a Page that names more than the limit, a view this tab stored can
// wait behind one of those until the connection is admitted.
//
// A waiting view reads as over the limit, or as missing (or failed) once it
// gave its slot up. A view that gave its slot up after failing is looked up
// again when it next has one; one with a slot is looked up again on each
// admitted connection. Nothing here writes a view document.
import { BehaviorSubject, asyncScheduler, of, switchMap, timer } from "rxjs";
import { HostDocReplica } from "./host-doc-replica.mjs";
import { slotted, viewHoldMachine } from "./view-hold-machine.mjs";
import { MAX_VIEWS, validViewId } from "../shared/views.mjs";
import { VIEW_SENTENCES, viewStore } from "./view-store.mjs";

export { MAX_VIEWS };
/** How long a view replica stays open after its last holder lets go: longer
 * than an embed's park (wordgard-dataframes.mjs), so an embed the editor
 * moves keeps its view document. */
export const VIEW_CLOSE_DELAY_MS = 2_000;

const unavailable = (reason) =>
  of(Object.freeze({ status: "unavailable", reason, sentence: VIEW_SENTENCES[reason] }));
const LIMIT = unavailable("limit");
const MISSING = unavailable("missing");
const CLOSED = unavailable("closed");
const FAILED = unavailable("failed");

/** Whether a replica in `state` (host-doc-open-machine.mjs) runs a look-again
 * lookup: its document was missing and its window ended. */
export const lookingAgain = (state) =>
  (state.name === "opening" || state.name === "retrying") && state.misses !== undefined;

/** Whether a replica in `state` has no document and nothing in hand: the
 * host answered it holds none, it is looking again for one it held none of,
 * or its lookups failed. A view that hasn't had a slot may take the slot of
 * one in this state. */
export const undrawn = (state) =>
  state.name === "absent" ||
  state.name === "unserved" ||
  state.name === "unreadable" ||
  state.name === "failed" ||
  lookingAgain(state);

/** Whether a replica in `state` is due another lookup of a missing
 * document: its window ended. */
const due = (state) => lookingAgain(state) || (state.name === "absent" && !state.cooling);

export class ViewReplicas {
  #entries = new Map();
  #retired = false;
  #options;
  /** Orders waiting views: the first to wait is the first admitted. */
  #arrivals = 0;
  #scheduled = false;

  /**
   * `viewDocumentId(pageId, viewId)` derives a view's document id (it may
   * return a promise). `find`, `forget`, `claims`, `link`, `linked`,
   * `stored` and `scheduler` are each replica's (host-doc-replica.mjs).
   * `linked()` says whether a connection is admitted now, so a replica
   * opened while connected looks its view up at once. One opened before
   * that reads this tab's stored copy through its demand, when `stored()`
   * says the Page is open from it, and otherwise waits for connected(). A
   * stored read that finds nothing keeps its slot and counts as no look:
   * the replica is closed, not undrawn, until a connection answers.
   */
  constructor({
    pageId,
    viewDocumentId,
    find,
    forget,
    claims,
    link,
    linked = () => false,
    stored = () => false,
    scheduler = asyncScheduler,
    lookupTimeout,
    closeDelay = 0,
    limit = MAX_VIEWS,
  }) {
    if (typeof viewDocumentId !== "function") throw Error("Views need viewDocumentId");
    this.#options = {
      pageId,
      viewDocumentId,
      find,
      forget,
      claims,
      link,
      linked,
      stored,
      scheduler,
      lookupTimeout,
      closeDelay,
      limit,
    };
  }

  /** View ids with a slot, sorted. */
  get open() {
    return [...this.#entries]
      .filter(([, entry]) => slotted(entry.state))
      .map(([viewId]) => viewId)
      .sort();
  }

  /** View ids waiting for a slot, in the order they will get one. */
  get waiting() {
    return this.#queue().map((entry) => entry.viewId);
  }

  /** The replica for `viewId`, while it has one. */
  replica(viewId) {
    return this.#entries.get(viewId)?.replica ?? undefined;
  }

  /**
   * Name view `viewId`. Returns `{ view$, release }`: the view's projection
   * (view-store.mjs), which follows the view from waiting to its slot, and
   * the function that lets go. While held with a slot, the view asks for its
   * document. An id the contract doesn't allow reads as missing, and one
   * named after retirement as closed; neither opens anything.
   */
  hold(viewId) {
    if (!validViewId(viewId)) return detached(MISSING);
    let entry = this.#entries.get(viewId);
    if (!entry) {
      entry = {
        viewId,
        state: viewHoldMachine.initial,
        replica: null,
        view$: null,
        timer: null,
        stopDemand: null,
        arrival: 0,
        looked: false,
        parked: null,
        shown$: new BehaviorSubject(CLOSED),
        watch: null,
      };
      this.#entries.set(viewId, entry);
      if (this.#retired) this.#step(entry, { type: "retire" });
    }
    this.#step(entry, { type: "hold" });
    this.#admit();
    let held = true;
    return {
      view$: entry.shown$.pipe(switchMap((view$) => view$)),
      release: () => {
        if (!held) return;
        held = false;
        this.#step(entry, { type: "release" });
        this.#admit();
      },
    };
  }

  /** A connection was admitted: every view with a slot looks its document
   * up on it. */
  connected() {
    for (const entry of this.#entries.values())
      if (slotted(entry.state)) entry.replica?.connected();
  }

  /** The Page's documents are retiring: every view replica retires with
   * them, and nothing opens again. */
  retire() {
    this.#retired = true;
    // A step may drop its entry, so each walk reads a copy.
    for (const entry of Array.from(this.#entries.values())) this.#step(entry, { type: "retire" });
  }

  /** The Page's replica closed or is being replaced: every view replica
   * closes, as the sources replica does. A view still held looks its
   * document up again on the next admitted connection. */
  close() {
    for (const entry of Array.from(this.#entries.values())) this.#step(entry, { type: "close" });
    this.#admit();
  }

  /** Waiting views, fresh ones first, each kind in the order it began to
   * wait. */
  #queue() {
    const waiting = [...this.#entries.values()].filter((entry) => entry.state.name === "waiting");
    const fresh = waiting.filter((entry) => entry.state.rank === "fresh");
    const missing = waiting.filter((entry) => entry.state.rank === "missing");
    const byArrival = (a, b) => a.arrival - b.arrival;
    return [...fresh.sort(byArrival), ...missing.sort(byArrival)];
  }

  /** Give free slots to waiting views. When none is free, a view in its
   * close delay gives its slot up; a view whose document is missing gives
   * its slot to a fresh one, or, once its window ended, to a missing one
   * that waited. */
  #admit() {
    if (this.#retired) return;
    for (;;) {
      const queue = this.#queue();
      if (!queue.length) return;
      const slots = [...this.#entries.values()].filter((entry) => slotted(entry.state));
      if (slots.length < this.#options.limit) {
        this.#step(queue[0], { type: "admit" });
        continue;
      }
      const closing = slots.find((entry) => entry.state.name === "closing");
      const fresh = queue[0].state.rank === "fresh";
      const next =
        closing || fresh ? queue[0] : queue.find((entry) => !entry.replica || entry.replica.due);
      if (!next) return;
      const yields = fresh
        ? (entry) => undrawn(entry.replica.state$.snapshot())
        : (entry) => entry.looked && due(entry.replica.state$.snapshot());
      const victim = closing ?? slots.find((entry) => entry.replica && yields(entry));
      if (!victim) return;
      this.#step(victim, { type: "evict" });
      this.#step(next, { type: "admit" });
    }
  }

  /** Run #admit after the current step: a replica that settles missing may
   * free a slot for a waiting view. */
  #admitSoon() {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#admit();
    });
  }

  #step(entry, event) {
    const result = viewHoldMachine.step(entry.state, event);
    if (result.rejected) return result;
    const before = entry.state;
    entry.state = result.state;
    if (entry.state.name === "waiting" && before.name !== "waiting") {
      entry.arrival = ++this.#arrivals;
      // What a view that gave its slot up reads while it waits.
      entry.parked = entry.replica?.state$.snapshot().name === "failed" ? FAILED : MISSING;
    }
    // A view's turn in a slot starts with no lookup made there.
    if (event.type === "admit") entry.looked = false;
    for (const effect of result.effects) this.#run(entry, effect);
    this.#show(entry);
    if (entry.state.name === "closed" && this.#entries.get(entry.viewId) === entry) {
      entry.watch?.unsubscribe();
      this.#entries.delete(entry.viewId);
    }
    return result;
  }

  /** What the view's holders read in its current state. */
  #show(entry) {
    const { state } = entry;
    const next =
      state.name === "waiting"
        ? state.rank === "fresh"
          ? LIMIT
          : (entry.parked ?? MISSING)
        : (entry.view$ ?? CLOSED);
    if (entry.shown$.getValue() !== next) entry.shown$.next(next);
  }

  #run(entry, effect) {
    switch (effect.type) {
      case "open":
        return this.#open(entry);
      case "demand":
        entry.stopDemand = entry.replica.demand();
        return;
      case "undemand":
        entry.stopDemand?.();
        entry.stopDemand = null;
        return;
      case "arm":
        entry.timer?.unsubscribe();
        entry.timer = timer(this.#options.closeDelay, this.#options.scheduler).subscribe(() => {
          entry.timer = null;
          this.#step(entry, { type: "closeTimer" });
          this.#admit();
        });
        return;
      case "disarm":
        entry.timer?.unsubscribe();
        entry.timer = null;
        return;
      case "shut":
      case "closeReplica":
        entry.replica?.close();
        return;
      case "retireReplica":
        entry.replica?.retire();
        return;
    }
    throw new Error(`unknown effect ${effect.type}`);
  }

  /** Make the view's replica on its first slot; a view that gave its slot
   * up keeps its closed replica, and with it the miss it last saw. */
  #open(entry) {
    const {
      pageId,
      viewDocumentId,
      find,
      forget,
      claims,
      link,
      linked,
      stored,
      scheduler,
      lookupTimeout,
    } = this.#options;
    if (!entry.replica) {
      entry.replica = new HostDocReplica({
        find,
        forget,
        claims,
        link,
        linked,
        stored,
        scheduler,
        ...(lookupTimeout && { lookupTimeout }),
        derive: () => viewDocumentId(pageId, entry.viewId),
      });
      entry.view$ = viewStore(entry.viewId, entry.replica);
      // A replica that settles without its document has looked in its slot
      // and may give the slot up; so may one whose window then ends.
      entry.watch = entry.replica.state$.state$.subscribe((state) => {
        if (!undrawn(state)) return;
        if (!lookingAgain(state) && slotted(entry.state)) entry.looked = true;
        if (this.#queue().length) this.#admitSoon();
      });
    }
    // Not linked: the `demand` effect that follows `open` asks, and the
    // replica reads this tab's stored copy if the Page is open from it.
    if (linked()) entry.replica.connected();
  }
}

/** What a holder reads when no replica opens for it. */
const detached = (view$) => ({ view$, release: () => {} });
