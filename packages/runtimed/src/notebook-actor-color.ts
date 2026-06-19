export const CURSOR_COLORS = [
  "#2563eb", // blue
  "#e11d48", // rose
  "#d97706", // amber
  "#059669", // emerald
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
] as const;

/** Deterministic color from peer ID. */
export function peerColor(peerId: string): string {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash * 31 + peerId.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

/**
 * Reduce an actor label to its durable identity key: principal plus operator
 * kind/name, without the per-connection or per-device instance id.
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
      ? segments.slice(0, 2).join(":")
      : kind;
  return `${principal}/${operatorKey}`;
}

/** Deterministic color for an actor's durable identity. */
export function colorForActorIdentity(actorLabel: string): string {
  return peerColor(identityColorKey(actorLabel));
}
