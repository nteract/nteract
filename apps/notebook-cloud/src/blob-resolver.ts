import { createBlobResolver, type BlobRef, type BlobResolver } from "runtimed";

export function createNotebookCloudBlobResolver(input: {
  baseUrl: string | URL;
  notebookId: string;
  fetchImpl?: typeof fetch;
}): BlobResolver {
  const baseUrl = new URL(input.baseUrl);
  return createBlobResolver({
    fetchImpl: input.fetchImpl,
    url(ref: BlobRef) {
      return new URL(
        `/api/n/${encodeURIComponent(input.notebookId)}/blobs/${encodeURIComponent(ref.blob)}`,
        baseUrl,
      ).href;
    },
  });
}
