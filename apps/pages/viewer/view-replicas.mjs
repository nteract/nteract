// A Page's view documents on this replica, read-only: one HostDocReplica
// (host-doc-replica.mjs) per view id, each driven by host-doc-open-machine.mjs.
// The host lists no view in discovery, so each view is found by the id it
// derives from the Page id and the view id, on the live connection.
//
// A replica is open while something names its view: a view node in the Page
// body (each drawn embed holds one) or the view's own address. When the last
// holder lets go, the replica closes after `closeDelay`, so an embed the
// editor redraws in place keeps its document. Nothing here writes a view
// document.
import { asyncScheduler, timer } from "rxjs";
import { HostDocReplica } from "./host-doc-replica.mjs";
import { validViewId, viewStore } from "./view-store.mjs";

export class ViewReplicas {
  #entries = new Map();
  #retired = false;
  #options;

  /**
   * `viewDocumentId(pageId, viewId)` derives a view's document id (it may
   * return a promise). `find`, `forget`, `link` and `scheduler` are each
   * replica's (host-doc-replica.mjs). `linked()` says whether a connection is
   * admitted now, so a replica opened while connected looks its view up at
   * once; one opened before that waits for connected().
   */
  constructor({
    pageId,
    viewDocumentId,
    find,
    forget,
    link,
    linked = () => false,
    scheduler = asyncScheduler,
    lookupTimeout,
    closeDelay = 0,
  }) {
    if (typeof viewDocumentId !== "function") throw Error("Views need viewDocumentId");
    this.#options = {
      pageId,
      viewDocumentId,
      find,
      forget,
      link,
      linked,
      scheduler,
      lookupTimeout,
      closeDelay,
    };
  }

  /** View ids with an open replica, sorted. */
  get open() {
    return [...this.#entries.keys()].sort();
  }

  /** The replica for `viewId`, while one is open. */
  replica(viewId) {
    return this.#entries.get(viewId)?.replica;
  }

  /**
   * Name view `viewId`: open its replica if none is open. Returns
   * `{ view$, want, release }`: the view's projection (view-store.mjs), a
   * function that asks for the view again when its replica rests absent, and
   * the function that lets go. A retired collection opens nothing;
   * its view$ reads the view as unavailable. An id the contract doesn't allow
   * opens nothing either, and reads as missing.
   */
  hold(viewId) {
    const entry = this.#entry(viewId);
    if (!entry) return detached(viewId, this.#retired ? "closed" : "missing");
    entry.holders++;
    entry.pendingClose?.unsubscribe();
    entry.pendingClose = undefined;
    let held = true;
    return {
      view$: entry.view$,
      want: () => {
        if (held) entry.replica.want();
      },
      release: () => {
        if (!held) return;
        held = false;
        this.#release(viewId, entry);
      },
    };
  }

  /** A connection was admitted: every open view not already open looks its
   * document up on it. */
  connected() {
    for (const { replica } of this.#entries.values()) replica.connected();
  }

  /** The Page's documents are retiring: every view replica retires with
   * them, and nothing opens again. */
  retire() {
    this.#retired = true;
    for (const entry of this.#entries.values()) {
      entry.pendingClose?.unsubscribe();
      entry.replica.retire();
    }
  }

  /** The Page's replica closed or is being replaced: every view replica
   * closes, as the sources replica does, and a view still held looks its
   * document up again on the next admitted connection. */
  close() {
    for (const [viewId, entry] of this.#entries) {
      entry.pendingClose?.unsubscribe();
      entry.pendingClose = undefined;
      entry.replica.close();
      if (entry.holders === 0) this.#entries.delete(viewId);
    }
  }

  #entry(viewId) {
    const existing = this.#entries.get(viewId);
    if (existing) return existing;
    if (this.#retired || !validViewId(viewId)) return undefined;
    const { pageId, viewDocumentId, find, forget, link, linked, scheduler, lookupTimeout } =
      this.#options;
    const replica = new HostDocReplica({
      find,
      forget,
      link,
      scheduler,
      ...(lookupTimeout && { lookupTimeout }),
      derive: () => viewDocumentId(pageId, viewId),
    });
    const entry = { replica, view$: viewStore(viewId, replica), holders: 0 };
    this.#entries.set(viewId, entry);
    if (linked()) replica.connected();
    return entry;
  }

  #release(viewId, entry) {
    entry.holders--;
    if (entry.holders > 0 || this.#entries.get(viewId) !== entry) return;
    entry.pendingClose = timer(this.#options.closeDelay, this.#options.scheduler).subscribe(() => {
      entry.pendingClose = undefined;
      if (entry.holders > 0 || this.#entries.get(viewId) !== entry) return;
      this.#entries.delete(viewId);
      entry.replica.close();
    });
  }
}

/** What a holder reads when no replica opens for it. */
function detached(viewId, reason) {
  const replica = new HostDocReplica({ find: () => Promise.reject(Error("closed")) });
  replica.step(reason === "closed" ? { type: "retire" } : { type: "discovered", answer: "none" });
  return { view$: viewStore(viewId, replica), want: () => {}, release: () => {} };
}
