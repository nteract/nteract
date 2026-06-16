import {
  CLOUD_HOSTED_DOCUMENT_LIST_CACHE_TTL_MS,
  clearCachedHostedDocumentList,
  cloudHostedDocumentListCacheAuthKey,
  readCachedHostedDocumentList,
  writeCachedHostedDocumentList,
  type HostedDocumentListCacheStorage,
} from "./hosted-document-list-cache";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import { isCloudNotebookListItem, type CloudNotebookListItem } from "./notebook-dashboard";

export const CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY =
  "nteract:notebook-cloud:notebook-list-cache:v1";
export const CLOUD_NOTEBOOK_LIST_CACHE_TTL_MS = CLOUD_HOSTED_DOCUMENT_LIST_CACHE_TTL_MS;

export type CloudNotebookListCacheStorage = HostedDocumentListCacheStorage;

export function readCachedCloudNotebookList(
  storage: Pick<CloudNotebookListCacheStorage, "getItem">,
  authState: CloudPrototypeAuthState,
  now = Date.now(),
): CloudNotebookListItem[] | null {
  return readCachedHostedDocumentList(storage, authState, cloudNotebookListCacheConfig(), now);
}

export function writeCachedCloudNotebookList(
  storage: Pick<CloudNotebookListCacheStorage, "setItem">,
  authState: CloudPrototypeAuthState,
  notebooks: CloudNotebookListItem[],
  now = Date.now(),
): void {
  writeCachedHostedDocumentList(storage, authState, notebooks, cloudNotebookListCacheConfig(), now);
}

export function clearCachedCloudNotebookList(
  storage: Pick<CloudNotebookListCacheStorage, "removeItem">,
): void {
  clearCachedHostedDocumentList(storage, CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY);
}

export function cloudNotebookListCacheAuthKey(authState: CloudPrototypeAuthState): string | null {
  return cloudHostedDocumentListCacheAuthKey(authState);
}

function cloudNotebookListCacheConfig() {
  return {
    isItem: isCloudNotebookListItem,
    itemsKey: "notebooks",
    storageKey: CLOUD_NOTEBOOK_LIST_CACHE_STORAGE_KEY,
  };
}
