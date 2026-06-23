import type { ActorDisplayPeer } from "runtimed";
import type { CommentsProjection } from "@/components/notebook";

export interface CloudCommentAuthorProfile {
  principal: string;
  label: string;
  image_url?: string | null;
}

export interface CloudCommentAuthorProfilesResponse {
  notebook_id?: string;
  profiles?: unknown;
}

export const COMMENT_AUTHOR_PROFILE_LOOKUP_BATCH_SIZE = 100;

export function commentAuthorActorLabels(projection: CommentsProjection | null): string[] {
  if (!projection) return [];

  const labels = new Set<string>();
  for (const thread of projection.threads) {
    addActorLabel(labels, thread.created_by_actor_label);
    addActorLabel(labels, thread.resolved_by_actor_label);
    for (const message of thread.messages) {
      addActorLabel(labels, message.created_by_actor_label);
    }
  }
  return Array.from(labels).sort();
}

export function commentAuthorProfilesUrl(endpoint: string, actorLabels: readonly string[]): string {
  const baseUrl = typeof window === "undefined" ? "http://localhost/" : window.location.href;
  const url = new URL(endpoint, baseUrl);
  for (const actorLabel of actorLabels) {
    url.searchParams.append("actor_label", actorLabel);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function commentAuthorProfileUrls(
  endpoint: string,
  actorLabels: readonly string[],
): string[] {
  const urls: string[] = [];
  for (
    let index = 0;
    index < actorLabels.length;
    index += COMMENT_AUTHOR_PROFILE_LOOKUP_BATCH_SIZE
  ) {
    urls.push(
      commentAuthorProfilesUrl(
        endpoint,
        actorLabels.slice(index, index + COMMENT_AUTHOR_PROFILE_LOOKUP_BATCH_SIZE),
      ),
    );
  }
  return urls;
}

export function commentAuthorProfilePeers(
  response: CloudCommentAuthorProfilesResponse,
): ActorDisplayPeer[] {
  if (!Array.isArray(response.profiles)) return [];

  const peers: ActorDisplayPeer[] = [];
  for (const profile of response.profiles) {
    if (!isCloudCommentAuthorProfile(profile)) continue;
    peers.push({
      participantKey: profile.principal,
      label: profile.label,
      imageUrl: profile.image_url ?? null,
    });
  }
  return peers;
}

export function mergeCommentAuthorPeers(
  profilePeers: readonly ActorDisplayPeer[],
  presencePeers: readonly ActorDisplayPeer[],
): ActorDisplayPeer[] {
  const merged = new Map<string, ActorDisplayPeer>();
  for (const peer of profilePeers) {
    if (usableAuthorPeer(peer)) {
      merged.set(peer.participantKey, peer);
    }
  }

  for (const peer of presencePeers) {
    if (!usableAuthorPeer(peer)) continue;
    const existing = merged.get(peer.participantKey);
    if (!existing || !isGenericAuthorLabel(peer.label)) {
      merged.set(peer.participantKey, peer);
    }
  }

  return Array.from(merged.values());
}

function addActorLabel(labels: Set<string>, value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) labels.add(trimmed);
}

function isCloudCommentAuthorProfile(value: unknown): value is CloudCommentAuthorProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<CloudCommentAuthorProfile>;
  return (
    typeof profile.principal === "string" &&
    profile.principal.trim().length > 0 &&
    typeof profile.label === "string" &&
    profile.label.trim().length > 0 &&
    (profile.image_url === undefined ||
      profile.image_url === null ||
      typeof profile.image_url === "string")
  );
}

function usableAuthorPeer(peer: ActorDisplayPeer): boolean {
  return peer.participantKey.trim().length > 0 && peer.label.trim().length > 0;
}

function isGenericAuthorLabel(label: string): boolean {
  switch (label.trim()) {
    case "Anaconda user":
    case "OIDC user":
    case "User":
    case "Peer":
    case "Unknown viewer":
      return true;
    default:
      return false;
  }
}
