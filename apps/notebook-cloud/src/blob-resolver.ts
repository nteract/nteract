import { createBlobResolver, type BlobRef, type BlobResolver } from "runtimed";

export function notebookCloudBlobBasePath(notebookId: string): string {
  return `/api/n/${encodeURIComponent(notebookId)}/blobs/`;
}

export function createNotebookCloudBlobResolver(input: {
  baseUrl: string | URL;
  blobBasePath: string;
  fetchImpl?: typeof fetch;
  authenticatedBinaryObjectUrls?: boolean;
}): BlobResolver {
  const blobBaseUrl = new URL(withTrailingSlash(input.blobBasePath), input.baseUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  const objectUrls = new Map<string, string>();
  const url = (ref: BlobRef) => new URL(encodeURIComponent(ref.blob), blobBaseUrl).href;
  return createBlobResolver({
    fetchImpl,
    url,
    ...(input.authenticatedBinaryObjectUrls
      ? {
          requestInit: { cache: "no-store" },
          async displayUrl(ref: BlobRef) {
            const cacheKey = objectUrlCacheKey(ref);
            const cached = objectUrls.get(cacheKey);
            if (cached) return cached;

            const response = await fetchImpl(url(ref), { cache: "no-store" });
            if (!response.ok) {
              throw new Error(`Failed to fetch blob ${ref.blob}: ${response.status}`);
            }
            const responseBlob = await response.blob();
            const typedBlob =
              responseBlob.type || !ref.media_type
                ? responseBlob
                : new Blob([responseBlob], { type: ref.media_type });
            const objectUrl =
              typeof URL.createObjectURL === "function" ? URL.createObjectURL(typedBlob) : url(ref);
            objectUrls.set(cacheKey, objectUrl);
            return objectUrl;
          },
          resolvesBinaryUrlsSynchronously: false,
        }
      : {}),
  });
}

export function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function objectUrlCacheKey(ref: BlobRef): string {
  return `${ref.blob}\0${ref.media_type ?? ""}\0${ref.size ?? ""}`;
}
