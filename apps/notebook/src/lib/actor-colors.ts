/**
 * Single color authority for actor identities, shared across cursors,
 * attribution underlines, and comment highlights so the same author reads as
 * the same color everywhere.
 *
 * Color is keyed on the durable identity (principal + operator kind:name), not
 * the ephemeral per-connection instance id and not the old `peer_id` hash that
 * predates the IdP identity model. That keeps an author's color stable across
 * reconnects and consistent whether they are currently present or not.
 *
 * Stateless by design. A stateful palette allocator would only be needed to
 * guarantee distinct colors among many concurrent actors (hash-collision
 * avoidance); pure hashing is enough for "whose mark is whose."
 */

import { peerColor } from "@/components/editor/remote-cursors";
import { findPeerColorByActorLabel } from "./cursor-registry";

/**
 * Reduce an actor label to its durable identity key.
 *
 * `local:kylekelley/agent:nteract-mcp:6483cc…` → `local:kylekelley/agent:nteract-mcp`
 * `local:kylekelley/desktop:b2c5d701`          → `local:kylekelley/desktop`
 *
 * The trailing segment of an operator is a per-connection/per-device instance
 * id; dropping it groups every session of the same operator under one color.
 */
export function identityColorKey(actorLabel: string): string {
  const slash = actorLabel.indexOf("/");
  if (slash === -1) return actorLabel;
  const principal = actorLabel.slice(0, slash);
  const operator = actorLabel.slice(slash + 1);
  const segments = operator.split(":");
  const kind = segments[0];
  const operatorKey =
    kind === "agent" || kind === "runtime" || kind === "system"
      ? segments.slice(0, 2).join(":") // kind:name, drop instance id
      : kind; // e.g. desktop:<device> → desktop
  return `${principal}/${operatorKey}`;
}

/**
 * Color for a single actor. Prefers the connected peer's live color so a
 * present author's marks match their cursor, falling back to the deterministic
 * identity hash so disconnected authors still get a stable, consistent color.
 */
export function colorForActorLabel(actorLabel: string): string {
  return findPeerColorByActorLabel(actorLabel) ?? peerColor(identityColorKey(actorLabel));
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
  return peerColor(identityColorKey(actors[0] ?? ""));
}
