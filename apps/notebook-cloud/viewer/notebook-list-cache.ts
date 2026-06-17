import {
  CLOUD_HOSTED_DOCUMENT_LIST_CACHE_TTL_MS,
  clearCachedHostedDocumentList,
  cloudHostedDocumentListCacheAuthKey,
  readCachedHostedDocumentList,
  writeCachedHostedDocumentList,
  type HostedDocumentListCacheStorage,
} from "./hosted-document-list-cache";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudAppSession } from "./app-session";
import { isCloudNotebookListItem, type CloudNotebookListItem } from "./notebook-dashboard";

export const CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY =
  "nteract:notebook-cloud:notebook-list-cache:v1";
export const CLOUD_NOTEBOOK_LIST_CACHE_TTL_MS = CLOUD_HOSTED_DOCUMENT_LIST_CACHE_TTL_MS;

export type CloudNotebookListCacheStorage = HostedDocumentListCacheStorage;

export function readCachedCloudNotebookList(
  storage: Pick<CloudNotebookListCacheStorage, "getItem">,
  authState: CloudPrototypeAuthState,
  appSession?: CloudAppSession | null,
  now = Date.now(),
): CloudNotebookListItem[] | null {
  return readCachedHostedDocumentList(
    storage,
    authState,
    appSession,
    cloudNotebookListCacheConfig(),
    now,
  );
}

export function writeCachedCloudNotebookList(
  storage: Pick<CloudNotebookListCacheStorage, "setItem">,
  authState: CloudPrototypeAuthState,
  appSession: CloudAppSession | null | undefined,
  notebooks: CloudNotebookListItem[],
  now = Date.now(),
): void {
  writeCachedHostedDocumentList(
    storage,
    authState,
    appSession,
    notebooks,
    cloudNotebookListCacheConfig(),
    now,
  );
}

export function clearCachedCloudNotebookList(
  storage: Pick<CloudNotebookListCacheStorage, "removeItem">,
): void {
  clearCachedHostedDocumentList(storage, CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY);
}

export function cloudNotebookListCacheAuthKey(
  authState: CloudPrototypeAuthState,
  appSession?: CloudAppSession | null,
): string | null {
  return cloudHostedDocumentListCacheAuthKey(authState, appSession);
}

function cloudNotebookListCacheConfig() {
  return {
    isItem: isCloudNotebookListItem,
    itemsKey: "notebooks",
    storageKey: CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY,
  };
}
