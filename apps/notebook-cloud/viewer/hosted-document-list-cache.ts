import type { CloudPrototypeAuthState } from "./collaborator-auth";

export const CLOUD_HOSTED_DOCUMENT_LIST_CACHE_TTL_MS = 10 * 60 * 1000;

export interface HostedDocumentListCacheStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface HostedDocumentListCacheConfig<T> {
  isItem: (value: unknown) => value is T;
  itemsKey: string;
  storageKey: string;
}

interface CachedHostedDocumentList {
  authKey: string;
  savedAt: number;
  [key: string]: unknown;
}

export function readCachedHostedDocumentList<T>(
  storage: Pick<HostedDocumentListCacheStorage, "getItem">,
  authState: CloudPrototypeAuthState,
  config: HostedDocumentListCacheConfig<T>,
  now = Date.now(),
): T[] | null {
  const authKey = cloudHostedDocumentListCacheAuthKey(authState);
  if (!authKey) {
    return null;
  }

  const raw = storage.getItem(config.storageKey);
  if (!raw) {
    return null;
  }

  let parsed: Partial<CachedHostedDocumentList>;
  try {
    parsed = JSON.parse(raw) as Partial<CachedHostedDocumentList>;
  } catch {
    return null;
  }

  const items = parsed[config.itemsKey];
  if (
    parsed.authKey !== authKey ||
    !Number.isFinite(parsed.savedAt) ||
    now - Number(parsed.savedAt) > CLOUD_HOSTED_DOCUMENT_LIST_CACHE_TTL_MS ||
    !Array.isArray(items) ||
    !items.every(config.isItem)
  ) {
    return null;
  }

  return items;
}

export function writeCachedHostedDocumentList<T>(
  storage: Pick<HostedDocumentListCacheStorage, "setItem">,
  authState: CloudPrototypeAuthState,
  items: T[],
  config: HostedDocumentListCacheConfig<T>,
  now = Date.now(),
): void {
  const authKey = cloudHostedDocumentListCacheAuthKey(authState);
  if (!authKey) {
    return;
  }

  storage.setItem(
    config.storageKey,
    JSON.stringify({
      authKey,
      [config.itemsKey]: items,
      savedAt: now,
    }),
  );
}

export function clearCachedHostedDocumentList(
  storage: Pick<HostedDocumentListCacheStorage, "removeItem">,
  storageKey: string,
): void {
  storage.removeItem(storageKey);
}

export function cloudHostedDocumentListCacheAuthKey(
  authState: CloudPrototypeAuthState,
): string | null {
  if (authState.mode === "oidc" && authState.oidcClaims?.sub) {
    return `oidc:${authState.oidcClaims.sub}`;
  }
  if (authState.mode === "dev" && authState.user) {
    return `dev:${authState.user}`;
  }
  return null;
}
