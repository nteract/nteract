import * as A from "@automerge/automerge";
import {
  extractRecords,
  getRecordMetadata,
  recordMetadataKey,
} from "@automerge/automerge-repo/sedimentree/automerge";
import { HistoryCapacityError } from "@automerge/automerge-repo-subduction";
import { recordIdentity, reservationMachine } from "./reservation-machine.mjs";

/** The records `candidate` adds to the serving document `base`, selected the
 * way the Repo's document delegate selects new records. Records that `base`
 * already represents are stored already, and possibly encoded by another peer:
 * a fragment's bundle orders concurrent changes in each peer's application
 * order, so the same fragment can differ byte for byte between peers. The
 * storage bridge accepts one representation per key, so the host must not
 * re-encode history it already holds.
 */
export function addedRecords(candidate, base) {
  const represented = new Set(getRecordMetadata(base).map(recordMetadataKey));
  return extractRecords(candidate, (metadata) => !represented.has(recordMetadataKey(metadata)));
}

export function isHistoryCapacityError(error) {
  const seen = new Set();
  while (error && !seen.has(error)) {
    if (error instanceof HistoryCapacityError) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

/** Startup readiness targets the stored history that materializes. Stored
 * changes whose dependencies never became durable stay queued in the document,
 * and apply if a peer or a journaled intent supplies the dependencies. Readers
 * that already passed admission see this note, with a count only, so stranded
 * changes are not silently invisible. */
export function incompleteHistory(doc) {
  const missing = A.getMissingDeps(doc, []).length;
  if (!missing) return undefined;
  return {
    code: "page_history_incomplete",
    missing_dependencies: missing,
    message:
      "Some stored edits depend on history this Page does not hold. They will appear when a collaborator who has that history reconnects.",
  };
}

/** One structured line, with counts only, records that the Page started on an
 * incomplete history. Like admission logs it carries no Page ID, principal or
 * change hash. */
export function logIncompleteHistory(doc) {
  const incomplete = incompleteHistory(doc);
  if (!incomplete) return undefined;
  const record = {
    service: "nteract-pages-native",
    event: "page.history_incomplete",
    missing_dependencies: incomplete.missing_dependencies,
    timestamp: new Date().toISOString(),
  };
  console.warn(JSON.stringify(record));
  return record;
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
    // Per intent key: reservationMachine state and the held record bytes.
    this.reservations = new Map();
  }
  get hasPending() {
    return this.intents.size > 0;
  }
  pending(key) {
    const entry = this.intents.get(key);
    return entry === undefined ? undefined : structuredClone(entry);
  }
  /** Reserve the records `candidate` adds to `base`, the serving document it
   * was built from. The union with stored history still bounds capacity. A
   * key the bridge already holds reserves its held records again. */
  async reserve(key, entry, candidate, base, persist) {
    const held = this.reservations.get(key);
    const computed = held ? [] : addedRecords(candidate, base);
    const { state, effects } = reservationMachine.step(held?.state ?? reservationMachine.initial, {
      type: "reserve",
      records: computed.map(recordIdentity),
    });
    const records = held?.records ?? computed;
    const [effect] = effects;
    if (effect.records.join() !== records.map(recordIdentity).join())
      throw Error("Reservation records differ from the reservation state");
    await this.backend.reserveRecords(this.tree, key, records, async () => {
      // The bridge installed these identities. Keep them, even if the intent
      // put below fails: a live retry must reserve exactly this set again.
      this.reservations.set(key, { state, records });
      // A failed put may have taken effect. A live retry must reuse these exact
      // bytes even when storage.get still returns nothing, never reauthor them.
      this.intents.set(key, structuredClone(entry));
      await persist();
    });
  }
  async replay(key, entry, handle) {
    // Validate dependencies and capacity on a disposable CRDT clone. Never
    // optimistically update the serving handle before native record admission.
    const base = handle.doc();
    const candidate = A.applyChanges(A.clone(base), entry.changes)[0];
    try {
      if (!A.hasHeads(candidate, entry.receipt.heads))
        throw Error("Recorded edit dependencies are unavailable");
      // Also covers pending intents restored after a crash. Reserved identities
      // are exact even if unrelated native changes advanced the current handle.
      await this.reserve(key, entry, candidate, base, async () => {});
      await this.apply([key], entry.changes, handle);
    } finally {
      A.free(candidate);
    }
  }
  /** Store exactly the records `keys` reserved, then apply their changes. */
  async apply(keys, changes, handle) {
    const records = new Map();
    for (const key of keys)
      for (const record of this.reservations.get(key)?.records ?? [])
        records.set(recordIdentity(record), record);
    await this.backend.storeSnapshot(this.tree, [...records.values()]);
    for (const key of keys) {
      const held = this.reservations.get(key);
      if (held) held.state = reservationMachine.step(held.state, { type: "stored" }).state;
    }
    // Backend observation may already have delivered the admitted records.
    // Applying the same encoded changes preserves identities and is idempotent.
    await handle.update((doc) => A.applyChanges(doc, changes)[0]);
  }
  async release(key) {
    // Callers have already synced the terminal receipt. Cleanup failure must
    // never turn it back into a trusted pending intent, even after receipt GC.
    // A leftover bridge reservation only retains already-stored identities.
    this.intents.delete(key);
    const held = this.reservations.get(key);
    this.reservations.delete(key);
    const { effects } = reservationMachine.step(held?.state ?? reservationMachine.initial, {
      type: "release",
    });
    if (effects.some((effect) => effect.type === "release"))
      await this.backend.releaseReservation(this.tree, key);
  }
}
