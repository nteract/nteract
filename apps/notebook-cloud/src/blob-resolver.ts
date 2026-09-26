import { createBlobResolver, type BlobRef, type BlobResolver } from "runtimed";

const BLOB_FETCH_RETRY_DELAYS_MS = [150, 500];

// Resolved outputs own their display strings. This is only a reuse cache, so
// evicting an entry must not invalidate an image already on screen. Count two
// bytes per code unit conservatively, including the data URL prefix.
export const BLOB_DISPLAY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const BLOB_DISPLAY_CACHE_MAX_ENTRIES = 128;

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
  let displayUrlBytes = 0;
  const displayUrlRequests = new Map<string, Promise<string>>();
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
          async displayUrl(ref: BlobRef, mediaType?: string) {
            const cacheKey = displayUrlCacheKey(ref, mediaType);
            const cached = displayUrls.get(cacheKey);
            if (cached) {
              displayUrls.delete(cacheKey);
              displayUrls.set(cacheKey, cached);
              return cached;
            }
            const inFlight = displayUrlRequests.get(cacheKey);
            if (inFlight) return inFlight;

            const request = resolveAuthenticatedDisplayUrl({
              fetchImpl,
              mediaType,
              ref,
              url: url(ref),
            })
              .then((displayUrl) => {
                const bytes = displayUrl.length * 2;
                // A single large output can still render, but must not keep
                // an extra resolver-owned reference after it leaves the view.
                if (bytes > BLOB_DISPLAY_CACHE_MAX_BYTES) return displayUrl;
                while (
                  displayUrls.size >= BLOB_DISPLAY_CACHE_MAX_ENTRIES ||
                  displayUrlBytes + bytes > BLOB_DISPLAY_CACHE_MAX_BYTES
                ) {
                  const oldest = displayUrls.entries().next().value;
                  if (!oldest) break;
                  displayUrls.delete(oldest[0]);
                  displayUrlBytes -= oldest[1].length * 2;
                }
                displayUrls.set(cacheKey, displayUrl);
                displayUrlBytes += bytes;
                return displayUrl;
              })
              .finally(() => {
                if (displayUrlRequests.get(cacheKey) === request) {
                  displayUrlRequests.delete(cacheKey);
                }
              });
            displayUrlRequests.set(cacheKey, request);
            return request;
          },
          resolvesBinaryUrlsSynchronously: false,
        }
      : {}),
  });
}

async function resolveAuthenticatedDisplayUrl({
  fetchImpl,
  mediaType,
  ref,
  url,
}: {
  fetchImpl: typeof fetch;
  mediaType?: string;
  ref: BlobRef;
  url: string;
}): Promise<string> {
  const response = await fetchBlobWithRetries(fetchImpl, url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch blob ${ref.blob}: ${response.status}`);
  }
  const responseBlob = await response.blob();
  const resolvedMediaType = mediaType ?? ref.media_type ?? responseBlob.type;
  const typedBlob =
    responseBlob.type === resolvedMediaType || !resolvedMediaType
      ? responseBlob
      : new Blob([responseBlob], { type: resolvedMediaType });
  // These URLs also enter sandboxed output frames with an opaque origin.
  // Parent-owned object URLs cannot cross that storage boundary, and a raw
  // protected URL cannot carry the fetch adapter's authorization headers.
  // Keep the frame-safe representation local to rendering, never in a doc.
  return blobToDataUrl(typedBlob);
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

async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== "function") {
    // Server/test environments do not always provide FileReader. Avoid an
    // object URL fallback: its lifetime cannot be owned by a string consumer.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return `data:${blob.type || "application/octet-stream"};base64,${btoa(chunks.join(""))}`;
  }
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
