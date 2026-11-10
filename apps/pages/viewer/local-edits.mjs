/**
 * Which edits in a local Page checkpoint are this browser's own and still
 * unconfirmed by the host.
 *
 * A checkpoint's `pending` says a receipt was outstanding when it was
 * written. That includes catch-up on other peers' changes, so it can't say
 * whether this person has unsaved work. `localEdits` answers that from facts
 * that survive a crash:
 *
 * - `actors`: `{ actor, replica }` for every Automerge actor a session in this
 *   browser authored with, and the native replica it wrote into. Each session
 *   gets a fresh actor, and PageSession records it before the session accepts
 *   its first edit. A change by any other actor arrived from the host, so the
 *   host already had it.
 * - `ackedHeads`: heads the host acknowledged in a receipt. Every change in
 *   their history is durable on the host.
 * - `unattributed`: the checkpoint predates `actors` and was written with a
 *   receipt outstanding, so its own edits can't be told apart. An
 *   acknowledgement of the whole replica clears it.
 *
 * A replica has unconfirmed local edits exactly when it holds a change by one
 * of `actors` outside the history of `ackedHeads`, or `unattributed` is set.
 * Native storage persists an edit before the debounced checkpoint does, so
 * this is read from the restored document, never from the checkpoint alone.
 *
 * An actor entry is dropped only when none of its changes can still be
 * unacknowledged anywhere, which only its own replica can know: a native
 * replica holds every change its sessions authored, and one session owns it
 * at a time. So a session drops its replica's earlier actors once a receipt
 * covers its whole document, and its own entries when it closes with no
 * unconfirmed edit. Entries of other replicas are never dropped, by count or
 * otherwise: that replica may be a live tab, or a crashed one the browser
 * restores with its native database. Entries that remain belong to replicas
 * that ended with unconfirmed edits.
 */
import * as A from "@automerge/automerge";

const HASH = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]{2,128}$/;

export const emptyLocalEdits = () => ({ actors: [], ackedHeads: [], unattributed: false });

const isEntry = (entry) =>
  !!entry &&
  typeof entry === "object" &&
  Object.keys(entry).length === 2 &&
  HEX.test(entry.actor) &&
  HEX.test(entry.replica);

/** A stored value as valid `localEdits`, or undefined when absent or
 * malformed. A malformed record reads as absent, so PageSession falls back to
 * the checkpoint's `pending`. */
export function readLocalEdits(value) {
  if (!value || typeof value !== "object") return undefined;
  const { actors, ackedHeads, unattributed } = value;
  if (!Array.isArray(actors) || !actors.every(isEntry)) return undefined;
  if (!Array.isArray(ackedHeads) || !ackedHeads.every((head) => HASH.test(head))) return undefined;
  if (typeof unattributed !== "boolean") return undefined;
  return {
    actors: actors.map(({ actor, replica }) => ({ actor, replica })),
    ackedHeads: [...ackedHeads],
    unattributed,
  };
}

const union = (left, right) => [...new Set([...left, ...right])];
/** Entries in order, one per actor; the first occurrence wins. */
function entries(...lists) {
  const seen = new Set();
  const result = [];
  for (const list of lists)
    for (const entry of list)
      if (!seen.has(entry.actor)) {
        seen.add(entry.actor);
        result.push(entry);
      }
  return result;
}

/** `edits` with `actor`, which writes into `replica`, recorded. Returns
 * `edits` itself when it already holds the actor. */
export function withActor(edits, actor, replica) {
  if (edits.actors.some((entry) => entry.actor === actor)) return edits;
  return { ...edits, actors: [...edits.actors, { actor, replica }] };
}

/** The acknowledged heads this document holds. Heads from another tab's
 * replica may be missing; they cover nothing here. */
export function acknowledgedHeads(doc, edits) {
  return edits.ackedHeads.filter((head) => A.hasHeads(doc, [head]));
}

export function hasUnconfirmedLocalEdits(doc, edits) {
  if (edits.unattributed) return true;
  if (!edits.actors.length) return false;
  const actors = new Set(edits.actors.map((entry) => entry.actor));
  return A.getChangesMetaSince(doc, acknowledgedHeads(doc, edits)).some((change) =>
    actors.has(change.actor),
  );
}

/**
 * `edits` after the host acknowledged `heads`, the current heads of the
 * document `replica` holds, while `actor` is its live session.
 *
 * Everything that replica's sessions authored is in the document, so its
 * earlier actors are confirmed and their entries go; the live actor stays
 * because it can still edit. Acknowledged heads the document doesn't hold
 * came from another tab and stay.
 */
export function afterAcknowledgement(doc, edits, heads, { replica, actor }) {
  const foreign = edits.ackedHeads.filter((head) => !A.hasHeads(doc, [head]));
  return {
    actors: edits.actors.filter((entry) => entry.replica !== replica || entry.actor === actor),
    ackedHeads: union(heads, foreign),
    unattributed: false,
  };
}

/** `edits` once `replica`'s session closes with no unconfirmed edit: none of
 * its actors can author or hold anything unacknowledged again. */
export function retireReplica(edits, replica) {
  return { ...edits, actors: edits.actors.filter((entry) => entry.replica !== replica) };
}

/**
 * Merge a checkpoint write's `localEdits` into the stored record's.
 * `replica` is the writer's native replica, when the writer is a session.
 *
 * The writer decides the entries of its own replica, which only it can prune.
 * Every other replica's entries union, so another tab's actor survives this
 * write. When the two checkpoints diverged and their histories were merged,
 * either side's acknowledgements and unattributed edits may be in the result,
 * so those union too. Otherwise the incoming checkpoint holds the stored
 * history, and its writer's acknowledgements replace the stored ones; losing
 * another tab's acknowledgement only reads as unconfirmed until the next
 * receipt.
 */
export function mergeLocalEdits(stored, incoming, { diverged = false, replica } = {}) {
  const previous = readLocalEdits(stored);
  const next = readLocalEdits(incoming);
  if (!previous || !next) return next ?? previous;
  const kept = previous.actors.filter(
    (entry) => replica === undefined || entry.replica !== replica,
  );
  return {
    actors: entries(kept, next.actors),
    ackedHeads: diverged ? union(next.ackedHeads, previous.ackedHeads) : next.ackedHeads,
    unattributed: diverged ? previous.unattributed || next.unattributed : next.unattributed,
  };
}
