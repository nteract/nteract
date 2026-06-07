import { createBlobResolver, type BlobRef, type BlobResolver } from "runtimed";

const BLOB_FETCH_RETRY_DELAYS_MS = [150, 500];

export function notebookCloudBlobBasePath(notebookId: string): string {
  return `/api/n/${encodeURIComponent(notebookId)}/blobs/`;
}

export function createNotebookCloudBlobResolver(input: {
  baseUrl: string | URL;
  blobBasePath: string;
  fetchImpl?: typeof fetch;
  authenticatedBinaryDisplayUrls?: boolean;
  /** @deprecated Use authenticatedBinaryDisplayUrls. */
  authenticatedBinaryObjectUrls?: boolean;
}): BlobResolver {
  const blobBaseUrl = new URL(withTrailingSlash(input.blobBasePath), input.baseUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  const displayUrls = new Map<string, string>();
  const url = (ref: BlobRef) => new URL(encodeURIComponent(ref.blob), blobBaseUrl).href;
  const fetchWithBlobRetries: typeof fetch = (request, init) =>
    fetchBlobWithRetries(fetchImpl, request, init);
  const authenticatedBinaryDisplayUrls =
    input.authenticatedBinaryDisplayUrls ?? input.authenticatedBinaryObjectUrls ?? false;
  return createBlobResolver({
    fetchImpl: fetchWithBlobRetries,
    url,
    ...(authenticatedBinaryDisplayUrls
      ? {
          requestInit: { cache: "no-store" },
          async displayUrl(ref: BlobRef, mediaType?: string) {
            const cacheKey = displayUrlCacheKey(ref, mediaType);
            const cached = displayUrls.get(cacheKey);
            if (cached) return cached;

            const response = await fetchBlobWithRetries(fetchImpl, url(ref), { cache: "no-store" });
            if (!response.ok) {
              throw new Error(`Failed to fetch blob ${ref.blob}: ${response.status}`);
            }
            const responseBlob = await response.blob();
            const resolvedMediaType = mediaType ?? ref.media_type ?? responseBlob.type;
            const typedBlob =
              responseBlob.type || !resolvedMediaType
                ? responseBlob
                : new Blob([responseBlob], { type: resolvedMediaType });
            const displayUrl =
              typeof FileReader === "function"
                ? await blobToDataUrl(typedBlob)
                : typeof URL.createObjectURL === "function"
                  ? URL.createObjectURL(typedBlob)
                  : url(ref);
            displayUrls.set(cacheKey, displayUrl);
            return displayUrl;
          },
          resolvesBinaryUrlsSynchronously: false,
        }
      : {}),
  });
}

export function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function fetchBlobWithRetries(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= BLOB_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetchImpl(input, init);
      if (!shouldRetryBlobResponse(response) || attempt === BLOB_FETCH_RETRY_DELAYS_MS.length) {
        return response;
      }
      await cancelResponseBody(response);
    } catch (error) {
      lastError = error;
      if (attempt === BLOB_FETCH_RETRY_DELAYS_MS.length) {
        throw error;
      }
    }

    await sleep(BLOB_FETCH_RETRY_DELAYS_MS[attempt]);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function shouldRetryBlobResponse(response: Response): boolean {
  return (
    response.status === 404 ||
    response.status === 409 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  );
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort; a failed cancel should not mask the retryable response.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function displayUrlCacheKey(ref: BlobRef, mediaType?: string): string {
  return `${ref.blob}\0${mediaType ?? ref.media_type ?? ""}\0${ref.size ?? ""}`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("FileReader returned a non-string data URL result"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob as data URL"));
    reader.readAsDataURL(blob);
  });
}
