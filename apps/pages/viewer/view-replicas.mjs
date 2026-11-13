// A Page's view documents on this replica, read-only: one HostDocReplica
// (host-doc-replica.mjs) per view id, each driven by host-doc-open-machine.mjs.
// The host lists no view in discovery, so each view is found by the id it
// derives from the Page id and the view id, on the live connection.
//
// Who holds each replica is view-hold-machine.mjs: a replica is open while
// something names its view (an embed near the viewport, or the view's own
// address) and closes `closeDelay` after the last holder lets go, so an
// embed the editor moves keeps its document.
//
// A Page holds at most MAX_VIEWS views, so at most that many replicas are
// open at once. A holder past the cap gets a view that reads as over the
// limit: nothing is derived, looked up or timed for it. Nothing here writes
// a view document.
import { asyncScheduler, of, timer } from "rxjs";
import { HostDocReplica } from "./host-doc-replica.mjs";
import { viewHoldMachine } from "./view-hold-machine.mjs";
import { VIEW_SENTENCES, validViewId, viewStore } from "./view-store.mjs";

/** The most views a Page holds (the contract's MAX_VIEWS). */
export const MAX_VIEWS = 10;
/** How long a view replica stays open after its last holder lets go: longer
 * than an embed's park (wordgard-dataframes.mjs), so an embed the editor
 * moves keeps its view document. */
export const VIEW_CLOSE_DELAY_MS = 2_000;

const unavailable = (reason) =>
  of(Object.freeze({ status: "unavailable", reason, sentence: VIEW_SENTENCES[reason] }));

export class ViewReplicas {
  #entries = new Map();
  #retired = false;
  #options;

  /**
   * `viewDocumentId(pageId, viewId)` derives a view's document id (it may
   * return a promise). `find`, `forget`, `claims`, `link` and `scheduler`
   * are each replica's (host-doc-replica.mjs). `linked()` says whether a
   * connection is admitted now, so a replica opened while connected looks
   * its view up at once; one opened before that waits for connected().
   */
  constructor({
    pageId,
    viewDocumentId,
    find,
    forget,
    claims,
    link,
    linked = () => false,
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
      scheduler,
      lookupTimeout,
      closeDelay,
      limit,
    };
  }

  /** View ids with an open replica, sorted. */
  get open() {
    return [...this.#entries]
      .filter(([, entry]) => entry.replica && entry.state.name !== "retired")
      .map(([viewId]) => viewId)
      .sort();
  }

  /** The replica for `viewId`, while one is open or retired. */
  replica(viewId) {
    return this.#entries.get(viewId)?.replica;
  }

  /**
   * Name view `viewId`. Returns `{ view$, want, release }`: the view's
   * projection (view-store.mjs), a function that asks for the view again
   * when its replica rests absent, and the function that lets go. An id the
   * contract doesn't allow reads as missing, one past the cap as over the
   * limit, and one named after retirement as closed; none of them opens
   * anything.
   */
  hold(viewId) {
    if (!validViewId(viewId)) return detached("missing");
    let entry = this.#entries.get(viewId);
    if (!entry) {
      if (!this.#retired && this.open.length >= this.#options.limit) return detached("limit");
      entry = { state: viewHoldMachine.initial, replica: null, view$: null, timer: null };
      this.#entries.set(viewId, entry);
      if (this.#retired) this.#step(viewId, entry, { type: "retire" });
    }
    this.#step(viewId, entry, { type: "hold" });
    const view$ = entry.view$ ?? unavailable("closed");
    let held = true;
    return {
      view$,
      want: () => {
        if (held && entry.state.name === "held") entry.replica.want();
      },
      release: () => {
        if (!held) return;
        held = false;
        this.#step(viewId, entry, { type: "release" });
      },
    };
  }

  /** A connection was admitted: every open view not already open looks its
   * document up on it. */
  connected() {
    for (const entry of this.#entries.values())
      if (entry.state.name !== "retired") entry.replica?.connected();
  }

  /** The Page's documents are retiring: every view replica retires with
   * them, and nothing opens again. */
  retire() {
    this.#retired = true;
    for (const [viewId, entry] of this.#entries) this.#step(viewId, entry, { type: "retire" });
  }

  /** The Page's replica closed or is being replaced: every view replica
   * closes, as the sources replica does. A view still held looks its
   * document up again on the next admitted connection. */
  close() {
    for (const [viewId, entry] of this.#entries) this.#step(viewId, entry, { type: "close" });
  }

  #step(viewId, entry, event) {
    const result = viewHoldMachine.step(entry.state, event);
    if (result.rejected) return result;
    entry.state = result.state;
    for (const effect of result.effects) this.#run(viewId, entry, effect);
    if (entry.state.name === "closed" && this.#entries.get(viewId) === entry)
      this.#entries.delete(viewId);
    return result;
  }

  #run(viewId, entry, effect) {
    switch (effect.type) {
      case "open":
        return this.#open(viewId, entry);
      case "arm":
        entry.timer?.unsubscribe();
        entry.timer = timer(this.#options.closeDelay, this.#options.scheduler).subscribe(() => {
          entry.timer = null;
          this.#step(viewId, entry, { type: "closeTimer" });
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

  #open(viewId, entry) {
    const { pageId, viewDocumentId, find, forget, claims, link, linked, scheduler, lookupTimeout } =
      this.#options;
    entry.replica = new HostDocReplica({
      find,
      forget,
      claims,
      link,
      scheduler,
      ...(lookupTimeout && { lookupTimeout }),
      derive: () => viewDocumentId(pageId, viewId),
    });
    entry.view$ = viewStore(viewId, entry.replica);
    if (linked()) entry.replica.connected();
  }
}

/** What a holder reads when no replica opens for it. */
const detached = (reason) => ({ view$: unavailable(reason), want: () => {}, release: () => {} });
