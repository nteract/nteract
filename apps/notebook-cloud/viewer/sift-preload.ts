import type { JupyterOutput } from "../../../src/components/cell/jupyter-output";
import { selectMimeType } from "../../../src/components/outputs/mime-priority";
import { resolveSiftWasmUrl } from "../../../src/isolated-renderer/sift-assets";
import { CLOUD_VIEWER_PRIORITY } from "./mime-policy";
import type { ResolvedCell } from "./render-resolution";

const SIFT_MIME_TYPES = new Set([
  "application/vnd.apache.parquet",
  "application/vnd.apache.arrow.stream",
  "application/vnd.nteract.arrow-stream-manifest+json",
]);

interface SiftWasmPreloadOptions {
  blobBasePath: string;
  rendererAssetsBasePath: string;
  pageUrl: string;
}

export function cellsUseSift(cells: readonly ResolvedCell[]): boolean {
  return cells.some((cell) => cell.outputs.some(outputUsesSift));
}

export function siftWasmPreloadUrlForCells(
  cells: readonly ResolvedCell[],
  { blobBasePath, rendererAssetsBasePath, pageUrl }: SiftWasmPreloadOptions,
): string | null {
  if (!cellsUseSift(cells)) return null;

  return resolveSiftWasmUrl({
    tableUrl: new URL(blobBasePath, pageUrl).href,
    rendererAssetsBaseUrl: new URL(rendererAssetsBasePath, pageUrl).href,
  });
}

export function preloadSiftWasmForCells(
  cells: readonly ResolvedCell[],
  options: SiftWasmPreloadOptions,
  targetDocument: Document = document,
): string | null {
  const href = siftWasmPreloadUrlForCells(cells, options);
  if (!href) return null;

  const existing = Array.from(targetDocument.head.querySelectorAll<HTMLLinkElement>("link")).some(
    (link) => link.rel === "preload" && link.href === href,
  );
  if (existing) return href;

  const link = targetDocument.createElement("link");
  link.rel = "preload";
  link.as = "fetch";
  link.type = "application/wasm";
  link.href = href;
  link.crossOrigin = "anonymous";
  link.dataset.nteractPreload = "sift-wasm";
  targetDocument.head.append(link);
  return href;
}

function outputUsesSift(output: JupyterOutput): boolean {
  if (output.output_type !== "display_data" && output.output_type !== "execute_result") {
    return false;
  }

  const mimeType = selectMimeType(output.data, CLOUD_VIEWER_PRIORITY);
  return mimeType != null && SIFT_MIME_TYPES.has(mimeType);
}
