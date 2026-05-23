import { createBlobResolver, type BlobRef, type BlobResolver } from "runtimed";

export function notebookCloudBlobBasePath(notebookId: string): string {
  return `/api/n/${encodeURIComponent(notebookId)}/blobs/`;
}

export function createNotebookCloudBlobResolver(input: {
  baseUrl: string | URL;
  blobBasePath: string;
  fetchImpl?: typeof fetch;
}): BlobResolver {
  const blobBaseUrl = new URL(withTrailingSlash(input.blobBasePath), input.baseUrl);
  return createBlobResolver({
    fetchImpl: input.fetchImpl,
    url(ref: BlobRef) {
      return new URL(encodeURIComponent(ref.blob), blobBaseUrl).href;
    },
  });
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
