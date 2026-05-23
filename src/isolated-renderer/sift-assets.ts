declare const __SIFT_WASM_CACHE_KEY__: string | undefined;

const SIFT_WASM_CACHE_KEY =
  typeof __SIFT_WASM_CACHE_KEY__ === "string" ? __SIFT_WASM_CACHE_KEY__ : "dev";

export interface ResolveSiftWasmUrlOptions {
  tableUrl: string;
  rendererAssetsBaseUrl?: string;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function resolveSiftWasmUrl({
  tableUrl,
  rendererAssetsBaseUrl,
}: ResolveSiftWasmUrlOptions): string {
  const parsedTableUrl = new URL(tableUrl);
  const assetsBase = rendererAssetsBaseUrl?.trim();
  const wasmUrl = assetsBase
    ? new URL("sift_wasm.wasm", withTrailingSlash(new URL(assetsBase, parsedTableUrl.origin).href))
    : new URL("/plugins/sift_wasm.wasm", parsedTableUrl.origin);

  wasmUrl.searchParams.set("v", SIFT_WASM_CACHE_KEY);
  return wasmUrl.toString();
}
