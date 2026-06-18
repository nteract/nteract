/**
 * Color authority for actor identities, shared across cursors, attribution
 * underlines, and comment highlights so the same author reads as the same color
 * everywhere.
 *
 * The deterministic identity hash lives in the shared editor package
 * (`colorForActorIdentity`), keyed on principal + operator kind:name rather than
 * the ephemeral instance id or the old peer_id. Presence now stores that same
 * identity color, so the live-presence lookup and the deterministic fallback
 * converge; the lookup just lets a connected author resolve before any cursor
 * has been seen.
 */

import { colorForActorIdentity, identityColorKey } from "@/components/editor/remote-cursors";
import { findPeerColorByActorLabel } from "./cursor-registry";

export { identityColorKey };

/** Color for a single actor: live presence color, else the identity hash. */
export function colorForActorLabel(actorLabel: string): string {
  return findPeerColorByActorLabel(actorLabel) ?? colorForActorIdentity(actorLabel);
}

/**
 * Color for an attribution carrying one or more actors. Prefers any connected
 * actor's live color, else the deterministic identity color of the first actor.
 */
export function colorForActors(actors: string[]): string {
  for (const actor of actors) {
    const live = findPeerColorByActorLabel(actor);
    if (live) return live;
  }
  return colorForActorIdentity(actors[0] ?? "");
}
