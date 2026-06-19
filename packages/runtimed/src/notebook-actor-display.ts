import {
  notebookActorIdentityFromProjection,
  notebookActorProjectionFromLabel,
  type NotebookActorKind,
} from "./notebook-actor-projection";

export interface ActorDisplayPeer {
  participantKey: string;
  label: string;
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
}

export function resolveActorDisplay({
  actorLabel,
  peers,
  source,
}: ResolveActorDisplayOptions): ActorDisplay {
  const projection = notebookActorProjectionFromLabel(actorLabel, { source });
  const identity = notebookActorIdentityFromProjection(projection);
  const principalId = projection.principal.id;
  const peerLabel = peerLabelForPrincipal(peers, principalId);
  const principalDisplayName = peerLabel ?? projection.principal.label;
  const isAgent = identity.kind === "agent";

  return {
    displayName: isAgent ? (identity.operatorLabel ?? identity.label) : principalDisplayName,
    principalId,
    kind: identity.kind,
    isAgent,
    onBehalfOf: isAgent ? (peerLabel ?? identity.principalLabel ?? null) : null,
  };
}

function peerLabelForPrincipal(
  peers: ReadonlyArray<ActorDisplayPeer>,
  principalId: string,
): string | null {
  const peer = peers.find((candidate) => candidate.participantKey === principalId);
  const label = peer?.label.trim();
  return label ? label : null;
}
