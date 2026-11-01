/**
 * Which edits in a local Page checkpoint are this browser's own and still
 * unconfirmed by the host.
 *
 * A checkpoint's `pending` says a receipt was outstanding when it was
 * written. That includes catch-up on other peers' changes, so it can't say
 * whether this person has unsaved work. `localEdits` answers that from facts
 * that survive a crash:
 *
 * - `actors`: every Automerge actor a session in this browser authored with.
 *   Each session gets a fresh actor, and PageSession records it before the
 *   session accepts its first edit. A change by any other actor arrived from
 *   the host, so the host already had it.
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
 */
import * as A from "@automerge/automerge";

// One actor per session that opened this Page in this browser. The oldest
// fall off first: a session that many opens ago is no longer live.
export const MAX_LOCAL_ACTORS = 512;
const HASH = /^[0-9a-f]{64}$/;
const ACTOR = /^[0-9a-f]{2,128}$/;

export const emptyLocalEdits = () => ({ actors: [], ackedHeads: [], unattributed: false });

/** A stored value as valid `localEdits`, or undefined when absent or
 * malformed. A malformed record reads as absent, so PageSession falls back to
 * the checkpoint's `pending`. */
export function readLocalEdits(value) {
  if (!value || typeof value !== "object") return undefined;
  const { actors, ackedHeads, unattributed } = value;
  if (!Array.isArray(actors) || !actors.every((actor) => ACTOR.test(actor))) return undefined;
  if (!Array.isArray(ackedHeads) || !ackedHeads.every((head) => HASH.test(head))) return undefined;
  if (typeof unattributed !== "boolean") return undefined;
  return { actors: [...actors], ackedHeads: [...ackedHeads], unattributed };
}

const union = (left, right) => [...new Set([...left, ...right])];
const capped = (actors) => actors.slice(-MAX_LOCAL_ACTORS);

/** `edits` with `actor` recorded. Returns `edits` itself when it already
 * holds the actor. */
export function withActor(edits, actor) {
  if (edits.actors.includes(actor)) return edits;
  return { ...edits, actors: capped([...edits.actors, actor]) };
}

/** The acknowledged heads this document holds. Heads from another tab's
 * replica may be missing; they cover nothing here. */
export function acknowledgedHeads(doc, edits) {
  return edits.ackedHeads.filter((head) => A.hasHeads(doc, [head]));
}

export function hasUnconfirmedLocalEdits(doc, edits) {
  if (edits.unattributed) return true;
  if (!edits.actors.length) return false;
  const actors = new Set(edits.actors);
  return A.getChangesMetaSince(doc, acknowledgedHeads(doc, edits)).some((change) =>
    actors.has(change.actor),
  );
}

/** `edits` after the host acknowledged `heads`, which are the document's
 * current heads. Everything the document holds is now confirmed; acknowledged
 * heads it doesn't hold came from another tab and stay. */
export function afterAcknowledgement(doc, edits, heads) {
  const foreign = edits.ackedHeads.filter((head) => !A.hasHeads(doc, [head]));
  return { actors: edits.actors, ackedHeads: union(heads, foreign), unattributed: false };
}

/**
 * Merge a checkpoint write's `localEdits` into the stored record's.
 *
 * Actors always union: another tab's actor must survive this tab's write, or
 * that tab's crash would read its edits as remote. When the two checkpoints
 * diverged and their histories were merged, either side's acknowledgements
 * and unattributed edits may be in the result, so those union too. Otherwise
 * the incoming checkpoint holds the stored history, and its writer's
 * acknowledgements replace the stored ones; losing another tab's
 * acknowledgement only reads as unconfirmed until the next receipt.
 */
export function mergeLocalEdits(stored, incoming, { diverged = false } = {}) {
  const previous = readLocalEdits(stored);
  const next = readLocalEdits(incoming);
  if (!previous || !next) return next ?? previous;
  return {
    actors: capped(union(previous.actors, next.actors)),
    ackedHeads: diverged ? union(next.ackedHeads, previous.ackedHeads) : next.ackedHeads,
    unattributed: diverged ? previous.unattributed || next.unattributed : next.unattributed,
  };
}
