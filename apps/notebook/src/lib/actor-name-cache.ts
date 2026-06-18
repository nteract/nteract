/**
 * Remembers the friendly display name last seen for an actor identity.
 *
 * "Claude Code" (and any client display name) lives only in live presence as
 * the peer_label; the durable comment record stores just the actor label, whose
 * operator slug humanizes to "Nteract Mcp". So once an author disconnects, the
 * panel would fall back to that slug.
 *
 * This caches the name keyed on the durable identity (principal + operator
 * kind:name, ignoring the per-session instance id) and persists it to
 * localStorage, so a previously-seen author keeps their real name across
 * disconnects and reloads. The on-record version (storing the name on the
 * comment itself) is the fuller fix for authors this client has never seen.
 */

import { identityColorKey } from "@/components/editor/remote-cursors";

const STORAGE_KEY = "nteract.comments.actorNames";
const cache = new Map<string, string>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") cache.set(key, value);
    }
  } catch {
    // Corrupt/unavailable storage is non-fatal; start with an empty cache.
  }
}

function persist(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Storage may be unavailable (private mode, quota); cache stays in-memory.
  }
}

/** Record the live display name seen for an actor, keyed on durable identity. */
export function rememberActorName(actorLabel: string, displayName: string): void {
  if (!actorLabel || !displayName) return;
  load();
  const key = identityColorKey(actorLabel);
  if (cache.get(key) === displayName) return;
  cache.set(key, displayName);
  persist();
}

/** The last display name seen for an actor identity, if any. */
export function cachedActorName(actorLabel: string): string | undefined {
  load();
  return cache.get(identityColorKey(actorLabel));
}

/** Clear the cache (tests). */
export function clearActorNameCacheForTests(): void {
  cache.clear();
  loaded = false;
}
