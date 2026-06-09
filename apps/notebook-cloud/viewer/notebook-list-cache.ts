import type { CloudPrototypeAuthState } from "./collaborator-auth";
import {
  isCloudNotebookListItem,
  type CloudNotebookListItem,
} from "@/components/notebook/workspace/notebook-dashboard";

export const CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY =
  "nteract:notebook-cloud:notebook-list-cache:v1";
export const CLOUD_NOTEBOOK_LIST_CACHE_TTL_MS = 10 * 60 * 1000;

export interface CloudNotebookListCacheStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface CachedCloudNotebookList {
  authKey: string;
  notebooks: CloudNotebookListItem[];
  savedAt: number;
}

export function readCachedCloudNotebookList(
  storage: Pick<CloudNotebookListCacheStorage, "getItem">,
  authState: CloudPrototypeAuthState,
  now = Date.now(),
): CloudNotebookListItem[] | null {
  const authKey = cloudNotebookListCacheAuthKey(authState);
  if (!authKey) {
    return null;
  }

  const raw = storage.getItem(CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  let parsed: Partial<CachedCloudNotebookList>;
  try {
    parsed = JSON.parse(raw) as Partial<CachedCloudNotebookList>;
  } catch {
    return null;
  }

  if (
    parsed.authKey !== authKey ||
    !Number.isFinite(parsed.savedAt) ||
    now - Number(parsed.savedAt) > CLOUD_NOTEBOOK_LIST_CACHE_TTL_MS ||
    !Array.isArray(parsed.notebooks) ||
    !parsed.notebooks.every(isCloudNotebookListItem)
  ) {
    return null;
  }

  return parsed.notebooks;
}

export function writeCachedCloudNotebookList(
  storage: Pick<CloudNotebookListCacheStorage, "setItem">,
  authState: CloudPrototypeAuthState,
  notebooks: CloudNotebookListItem[],
  now = Date.now(),
): void {
  const authKey = cloudNotebookListCacheAuthKey(authState);
  if (!authKey) {
    return;
  }

  storage.setItem(
    CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY,
    JSON.stringify({
      authKey,
      notebooks,
      savedAt: now,
    } satisfies CachedCloudNotebookList),
  );
}

export function clearCachedCloudNotebookList(
  storage: Pick<CloudNotebookListCacheStorage, "removeItem">,
): void {
  storage.removeItem(CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY);
}

export function cloudNotebookListCacheAuthKey(authState: CloudPrototypeAuthState): string | null {
  if (authState.mode === "oidc" && authState.oidcClaims?.sub) {
    return `oidc:${authState.oidcClaims.sub}`;
  }
  if (authState.mode === "dev" && authState.user) {
    return `dev:${authState.user}`;
  }
  return null;
}
