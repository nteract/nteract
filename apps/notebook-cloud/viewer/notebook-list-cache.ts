import type { CloudAppSession } from "./app-session";
import { devPrincipalLabel, type CloudPrototypeAuthState } from "./collaborator-auth";
import { cloudInstantPaintPrincipalMatcher } from "./cloud-principal";
import type { CloudNotebookListSnapshot } from "./cloud-viewer-types";
import {
  isCloudNotebookListItem,
  isOptionalCloudNotebookListTotalCount,
  normalizeCloudNotebookListTotalCount,
  type CloudNotebookListItem,
} from "./notebook-dashboard";

export const CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY =
  "nteract:notebook-cloud:notebook-list-cache:v2";

export interface CloudNotebookListCacheStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface CachedCloudNotebookList {
  notebooks: CloudNotebookListItem[];
  principal: string;
  savedAt: number;
  totalCount: number;
}

interface CachedCloudNotebookListRoot {
  entries: CachedCloudNotebookList[];
  v: 2;
}

export function readCachedCloudNotebookList(
  storage: Pick<CloudNotebookListCacheStorage, "getItem" | "removeItem">,
  authState: CloudPrototypeAuthState,
  appSession: CloudAppSession | null | undefined,
): CloudNotebookListSnapshot | null {
  const matchesPrincipal = cloudInstantPaintPrincipalMatcher(authState, {
    hasAppSession: Boolean(appSession),
  });
  if (!matchesPrincipal) {
    return null;
  }

  const root = readCloudNotebookListCacheRoot(storage);
  if (!root) {
    return null;
  }

  const entry = root.entries.find((candidate) => matchesPrincipal(candidate.principal));
  return entry ? { notebooks: entry.notebooks, totalCount: entry.totalCount } : null;
}

export function writeCachedCloudNotebookList(
  storage: Pick<CloudNotebookListCacheStorage, "getItem" | "removeItem" | "setItem">,
  authState: CloudPrototypeAuthState,
  appSession: CloudAppSession | null | undefined,
  notebooks: CloudNotebookListItem[],
  input: { now?: number; principal?: string | null; totalCount?: number | null } = {},
): void {
  if (!notebooks.every(isCloudNotebookListItem)) {
    return;
  }

  const matchesPrincipal = cloudInstantPaintPrincipalMatcher(authState, {
    hasAppSession: Boolean(appSession),
  });
  const principal = cloudNotebookListCachePrincipal(authState, {
    hasAppSession: Boolean(appSession),
    matchesPrincipal,
    principal: input.principal,
  });
  if (!principal || !matchesPrincipal?.(principal)) {
    return;
  }

  const root = readCloudNotebookListCacheRoot(storage) ?? { v: 2, entries: [] };
  const entry = {
    notebooks,
    principal,
    savedAt: input.now ?? Date.now(),
    totalCount: normalizeCloudNotebookListTotalCount(notebooks, input.totalCount),
  } satisfies CachedCloudNotebookList;
  const entries = [
    entry,
    ...root.entries.filter((candidate) => candidate.principal !== principal),
  ].slice(0, 8);
  storage.setItem(
    CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY,
    JSON.stringify({
      entries,
      v: 2,
    } satisfies CachedCloudNotebookListRoot),
  );
}

export function clearCachedCloudNotebookList(
  storage: Pick<CloudNotebookListCacheStorage, "removeItem">,
): void {
  storage.removeItem(CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY);
}

function readCloudNotebookListCacheRoot(
  storage: Pick<CloudNotebookListCacheStorage, "getItem" | "removeItem">,
): CachedCloudNotebookListRoot | null {
  const raw = storage.getItem(CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    storage.removeItem(CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY);
    return null;
  }
  if (!isCachedCloudNotebookListRoot(parsed)) {
    return null;
  }
  return parsed;
}

function isCachedCloudNotebookListRoot(value: unknown): value is CachedCloudNotebookListRoot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CachedCloudNotebookListRoot>;
  return candidate.v === 2 && Array.isArray(candidate.entries) && candidate.entries.every(isEntry);
}

function isEntry(value: unknown): value is CachedCloudNotebookList {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CachedCloudNotebookList>;
  return (
    typeof candidate.principal === "string" &&
    Number.isFinite(candidate.savedAt) &&
    Array.isArray(candidate.notebooks) &&
    candidate.notebooks.every(isCloudNotebookListItem) &&
    isOptionalCloudNotebookListTotalCount(candidate.totalCount, candidate.notebooks.length) &&
    candidate.totalCount !== undefined
  );
}

function cloudNotebookListCachePrincipal(
  authState: CloudPrototypeAuthState,
  options: {
    hasAppSession: boolean;
    matchesPrincipal: ((principal: string) => boolean) | null;
    principal?: string | null;
  },
): string | null {
  const explicit = options.principal?.trim();
  if (explicit) {
    return explicit;
  }
  if (authState.mode === "dev" && authState.token) {
    return devPrincipalLabel(authState.user ?? "browser-editor");
  }

  const sub = authState.oidcClaims?.sub?.trim();
  if (
    !sub ||
    (authState.mode !== "oidc" && !(authState.mode === "oidc_expired" && options.hasAppSession))
  ) {
    return null;
  }
  const encodedSub = encodeURIComponent(sub);
  // SSR bootstrap intentionally does not expose the raw worker principal.
  // For that path, store a matcher-shaped principal and let the shared
  // instant-paint matcher remain the validity authority.
  const syntheticPrincipal = `user:oidc-cache:${encodedSub}`;
  return options.matchesPrincipal?.(syntheticPrincipal) ? syntheticPrincipal : null;
}
