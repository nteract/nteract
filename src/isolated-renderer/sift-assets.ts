declare const __SIFT_WASM_CACHE_KEY__: string | undefined;

const SIFT_WASM_CACHE_KEY =
  typeof __SIFT_WASM_CACHE_KEY__ === "string" ? __SIFT_WASM_CACHE_KEY__ : "dev";

const SIFT_WASM_STABLE_NAME = "sift_wasm.wasm";

// The asset name arrives via host context, which crosses the sandbox
// boundary — only accept the stable name or a content-hashed variant of it.
const SIFT_WASM_ASSET_NAME_RE = /^sift_wasm(?:\.[a-f0-9]{12,64})?\.wasm$/;
const CONTENT_HASHED_SIFT_WASM_RE = /^sift_wasm\.[a-f0-9]{12,64}\.wasm$/;

export interface ResolveSiftWasmUrlOptions {
  tableUrl: string;
  rendererAssetsBaseUrl?: string;
  /**
   * Sift WASM filename from the host's deploy manifest. A content-hashed
   * name (`sift_wasm.<sha16>.wasm`) rides immutable caching and drops the
   * `?v=` query; the stable name (default) keeps the build-keyed query as
   * its cache buster.
   */
  siftWasmAssetName?: string;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function resolveSiftWasmUrl({
  tableUrl,
  rendererAssetsBaseUrl,
  siftWasmAssetName,
}: ResolveSiftWasmUrlOptions): string {
  const parsedTableUrl = new URL(tableUrl);
  const assetsBase = rendererAssetsBaseUrl?.trim();
  const requestedName = siftWasmAssetName?.trim();
  const assetName =
    requestedName && SIFT_WASM_ASSET_NAME_RE.test(requestedName)
      ? requestedName
      : SIFT_WASM_STABLE_NAME;
  const wasmUrl = assetsBase
    ? new URL(assetName, withTrailingSlash(new URL(assetsBase, parsedTableUrl.origin).href))
    : new URL(`/plugins/${assetName}`, parsedTableUrl.origin);

  if (!CONTENT_HASHED_SIFT_WASM_RE.test(assetName)) {
    wasmUrl.searchParams.set("v", SIFT_WASM_CACHE_KEY);
  }
  return wasmUrl.toString();
}

export interface ResolvedSiftWasmUrls {
  url: string;
  /**
   * Stable-name copy (`sift_wasm.wasm?v=...`) to retry once when the
   * primary URL fails to load. Only set when the primary name is
   * content-hashed: the stable copies are deployed alongside the hashed
   * ones precisely so a stale tab whose hashed name vanished across a
   * deploy window can still render its first sift output.
   */
  fallbackUrl: string | null;
}

export function resolveSiftWasmUrls(options: ResolveSiftWasmUrlOptions): ResolvedSiftWasmUrls {
  const url = resolveSiftWasmUrl(options);
  const requestedName = options.siftWasmAssetName?.trim();
  const usesHashedName = Boolean(requestedName && CONTENT_HASHED_SIFT_WASM_RE.test(requestedName));
  return {
    url,
    fallbackUrl: usesHashedName
      ? resolveSiftWasmUrl({ ...options, siftWasmAssetName: undefined })
      : null,
  };
}
