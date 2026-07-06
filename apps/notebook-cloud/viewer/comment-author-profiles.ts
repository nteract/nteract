/**
 * Comment-author batch helpers for the cloud user store.
 *
 * Comments still supply actor-label sets, and the store uses the notebook-scoped
 * author-profiles endpoint to backfill display names and avatars in batches.
 */

import type { CommentsProjection } from "@/components/notebook";

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

function addActorLabel(labels: Set<string>, value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) labels.add(trimmed);
}
