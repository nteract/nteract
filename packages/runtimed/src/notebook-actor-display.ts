import {
  notebookActorIdentityFromProjection,
  notebookActorProjectionFromLabel,
  type NotebookActorKind,
} from "./notebook-actor-projection";
import { colorForActorIdentity } from "./notebook-actor-color";

export interface ActorDisplayPeer {
  participantKey: string;
  label: string;
  imageUrl?: string | null;
}

export interface ResolveActorDisplayOptions {
  actorLabel: string;
  peers: ReadonlyArray<ActorDisplayPeer>;
  source: "cloud" | "local";
}

export interface ActorDisplay {
  displayName: string;
  principalId: string;
  kind: NotebookActorKind;
  isAgent: boolean;
  onBehalfOf: string | null;
  color: string;
  initials: string;
  imageUrl: string | null;
}

export function resolveActorDisplay({
  actorLabel,
  peers,
  source,
}: ResolveActorDisplayOptions): ActorDisplay {
  const projection = notebookActorProjectionFromLabel(actorLabel, { source });
  const identity = notebookActorIdentityFromProjection(projection);
  const principalId = projection.principal.id;
  const peer = peerForPrincipal(peers, principalId);
  const peerLabel = labelForPeer(peer);
  const principalDisplayName = peerLabel ?? projection.principal.label;
  const isAgent = identity.kind === "agent";
  const displayName = isAgent ? (identity.operatorLabel ?? identity.label) : principalDisplayName;

  return {
    displayName,
    principalId,
    kind: identity.kind,
    isAgent,
    onBehalfOf: isAgent ? (peerLabel ?? identity.principalLabel ?? null) : null,
    color: colorForActorIdentity(actorLabel),
    initials: actorInitials(displayName),
    imageUrl: peer?.imageUrl ?? null,
  };
}

function peerForPrincipal(
  peers: ReadonlyArray<ActorDisplayPeer>,
  principalId: string,
): ActorDisplayPeer | null {
  return peers.find((candidate) => candidate.participantKey === principalId) ?? null;
}

function labelForPeer(peer: ActorDisplayPeer | null): string | null {
  const label = peer?.label.trim();
  return label ? label : null;
}

export function actorInitials(name: string): string {
  const trimmed = name.trim();
  if (looksLikeEmailAddress(trimmed)) {
    return "U";
  }
  const words = trimmed
    .split(/[\s@._-]+/g)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) {
    return "U";
  }
  // A single word keeps two letters ("Alice" -> "AL"); multiple words take the
  // first letter of the first two ("Kyle Kelley" -> "KK").
  const initials =
    words.length === 1
      ? words[0].slice(0, 2)
      : words
          .slice(0, 2)
          .map((word) => word[0] ?? "")
          .join("");
  return initials.toUpperCase() || "U";
}

function looksLikeEmailAddress(label: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(label);
}
