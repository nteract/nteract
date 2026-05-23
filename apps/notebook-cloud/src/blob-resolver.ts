import { createBlobResolver, type BlobRef, type BlobResolver } from "runtimed";

export function createNotebookCloudBlobResolver(input: {
  baseUrl: string | URL;
  notebookId: string;
  blobBasePath?: string;
  fetchImpl?: typeof fetch;
}): BlobResolver {
  const baseUrl = new URL(input.baseUrl);
  const blobBasePath = input.blobBasePath ?? notebookCloudBlobBasePath(input.notebookId);
  return createBlobResolver({
    fetchImpl: input.fetchImpl,
    url(ref: BlobRef) {
      return new URL(`${ensureTrailingSlash(blobBasePath)}${encodeURIComponent(ref.blob)}`, baseUrl)
        .href;
    },
  });
}

export function notebookCloudBlobBasePath(notebookId: string): string {
  return `/api/n/${encodeURIComponent(notebookId)}/blobs/`;
}

function ensureTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}
