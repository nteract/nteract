import {
  CLOUD_HOSTED_DOCUMENT_LIST_CACHE_TTL_MS,
  clearCachedHostedDocumentList,
  readCachedHostedDocumentList,
  writeCachedHostedDocumentList,
  type HostedDocumentListCacheStorage,
} from "./hosted-document-list-cache";
import type { CloudPrototypeAuthState } from "./collaborator-auth";
import {
  isCloudMarkdownDocumentListItem,
  type CloudMarkdownDocumentListItem,
} from "./markdown-document-dashboard";

export const CLOUD_MARKDOWN_DOCUMENT_LIST_CACHE_STORAGE_KEY =
  "nteract:notebook-cloud:markdown-document-list-cache:v1";
export const CLOUD_MARKDOWN_DOCUMENT_LIST_CACHE_TTL_MS = CLOUD_HOSTED_DOCUMENT_LIST_CACHE_TTL_MS;

export type CloudMarkdownDocumentListCacheStorage = HostedDocumentListCacheStorage;

export function readCachedCloudMarkdownDocumentList(
  storage: Pick<CloudMarkdownDocumentListCacheStorage, "getItem">,
  authState: CloudPrototypeAuthState,
  now = Date.now(),
): CloudMarkdownDocumentListItem[] | null {
  return readCachedHostedDocumentList(
    storage,
    authState,
    cloudMarkdownDocumentListCacheConfig(),
    now,
  );
}

export function writeCachedCloudMarkdownDocumentList(
  storage: Pick<CloudMarkdownDocumentListCacheStorage, "setItem">,
  authState: CloudPrototypeAuthState,
  documents: CloudMarkdownDocumentListItem[],
  now = Date.now(),
): void {
  writeCachedHostedDocumentList(
    storage,
    authState,
    documents,
    cloudMarkdownDocumentListCacheConfig(),
    now,
  );
}

export function clearCachedCloudMarkdownDocumentList(
  storage: Pick<CloudMarkdownDocumentListCacheStorage, "removeItem">,
): void {
  clearCachedHostedDocumentList(storage, CLOUD_MARKDOWN_DOCUMENT_LIST_CACHE_STORAGE_KEY);
}

function cloudMarkdownDocumentListCacheConfig() {
  return {
    isItem: isCloudMarkdownDocumentListItem,
    itemsKey: "documents",
    storageKey: CLOUD_MARKDOWN_DOCUMENT_LIST_CACHE_STORAGE_KEY,
  };
}
