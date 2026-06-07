export interface BlobRef {
  blob: string;
  size?: number;
  media_type?: string;
}

export interface BlobResolver {
  /**
   * Local daemon blob port when the resolver is backed by the daemon HTTP
   * server. Cloud/native resolvers should omit this and rely on `url()` and
   * `fetch()` instead.
   */
  readonly port?: number;

  /** Return a browser-consumable URL for renderers that stream/fetch directly. */
  url(ref: BlobRef): string;

  /**
   * Return a browser-consumable display URL after any host-owned auth/proxy
   * work. Cloud hosts use this to turn protected binary blobs into same-page
   * object URLs without putting bearer credentials into `<img src>` URLs.
   */
  displayUrl?(ref: BlobRef): Promise<string>;

  /**
   * Whether binary MIME refs can be resolved through `url()` without awaiting
   * `displayUrl()`. Local daemon HTTP URLs can; protected cloud URLs cannot.
   */
  readonly resolvesBinaryUrlsSynchronously?: boolean;

  /** Fetch blob bytes/text through the host, including any auth/proxy policy. */
  fetch(ref: BlobRef): Promise<Response>;
}

export type BlobResolverInput = BlobResolver | number;

export interface BlobResolverOptions {
  url(ref: BlobRef): string;
  displayUrl?: (ref: BlobRef) => Promise<string>;
  resolvesBinaryUrlsSynchronously?: boolean;
  fetchImpl?: typeof fetch;
  requestInit?: RequestInit | ((ref: BlobRef) => RequestInit);
}

function requestInitFor(
  requestInit: BlobResolverOptions["requestInit"],
  ref: BlobRef,
): RequestInit | undefined {
  return typeof requestInit === "function" ? requestInit(ref) : requestInit;
}

/**
 * Create a host-agnostic blob resolver.
 *
 * This is the cloud/native path: callers own URL construction and fetch
 * policy, and no daemon `port` is exposed to downstream consumers.
 */
export function createBlobResolver(options: BlobResolverOptions): BlobResolver {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    url: options.url,
    fetch(ref) {
      return fetchImpl(options.url(ref), requestInitFor(options.requestInit, ref));
    },
    ...(options.displayUrl ? { displayUrl: options.displayUrl } : {}),
    resolvesBinaryUrlsSynchronously: options.resolvesBinaryUrlsSynchronously ?? true,
  };
}

/** Create a resolver for the local daemon HTTP blob server. */
export function createHttpBlobResolver(
  port: number,
  fetchImpl: typeof fetch = fetch,
): BlobResolver {
  const url = (ref: BlobRef) => `http://127.0.0.1:${port}/blob/${ref.blob}`;
  return {
    port,
    url,
    fetch(ref) {
      return fetchImpl(url(ref));
    },
    resolvesBinaryUrlsSynchronously: true,
  };
}

export function normalizeBlobResolver(input: BlobResolverInput): BlobResolver {
  return typeof input === "number" ? createHttpBlobResolver(input) : input;
}
