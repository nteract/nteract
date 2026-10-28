import * as A from "@automerge/automerge";
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge";
import { HistoryCapacityError } from "@automerge/automerge-repo-subduction";

export function isHistoryCapacityError(error) {
  const seen = new Set();
  while (error && !seen.has(error)) {
    if (error instanceof HistoryCapacityError) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

/** The record bridge exclusively owns admission, including native WebSocket
 * writes. Its reservation callback persists the immutable host intent while
 * that same writer is held. The host must first flush the intent's dependency
 * base and restore all pending intents before allowing native connections.
 *
 * In buffered mode PageRecords is a passive ordered sink, never a second
 * admission owner. Host intent sync precedes any later accepted native record;
 * restart loads that sink and restores the host reservations before admitting
 * more work. Only release after both record and receipt durability barriers.
 */
export class DocumentAdmission {
  constructor(backend, tree) {
    this.backend = backend;
    this.tree = tree;
    this.intents = new Map();
  }
  get hasPending() {
    return this.intents.size > 0;
  }
  pending(key) {
    const entry = this.intents.get(key);
    return entry === undefined ? undefined : structuredClone(entry);
  }
  reserve(key, entry, candidate, persist) {
    return this.backend.reserveRecords(this.tree, key, extractRecords(candidate), async () => {
      // A failed put may have taken effect. A live retry must reuse these exact
      // bytes even when storage.get still returns nothing, never reauthor them.
      this.intents.set(key, structuredClone(entry));
      await persist();
    });
  }
  async replay(key, entry, handle) {
    // Validate dependencies and capacity on a disposable CRDT clone. Never
    // optimistically update the serving handle before native record admission.
    const candidate = A.applyChanges(A.clone(handle.doc()), entry.changes)[0];
    try {
      if (!A.hasHeads(candidate, entry.receipt.heads))
        throw Error("Recorded edit dependencies are unavailable");
      // Also covers pending intents restored after a crash. Reserved identities
      // are exact even if unrelated native changes advanced the current handle.
      await this.reserve(key, entry, candidate, async () => {});
      await this.apply(candidate, entry.changes, handle);
    } finally {
      A.free(candidate);
    }
  }
  async apply(candidate, changes, handle) {
    await this.backend.storeSnapshot(this.tree, extractRecords(candidate));
    // Backend observation may already have delivered the admitted records.
    // Applying the same encoded changes preserves identities and is idempotent.
    await handle.update((doc) => A.applyChanges(doc, changes)[0]);
  }
  async release(key) {
    // Callers have already synced the terminal receipt. Cleanup failure must
    // never turn it back into a trusted pending intent, even after receipt GC.
    // A leftover bridge reservation only retains already-stored identities.
    this.intents.delete(key);
    await this.backend.releaseReservation(this.tree, key);
  }
}
