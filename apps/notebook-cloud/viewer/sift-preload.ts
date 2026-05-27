import type { JupyterOutput } from "../../../src/components/cell/jupyter-output";
import { rendererPluginNameForMime } from "../../../src/components/isolated/renderer-plugin-info";
import { selectMimeType } from "../../../src/components/outputs/mime-priority";
import { resolveSiftWasmUrl } from "../../../src/isolated-renderer/sift-assets";
import { CLOUD_VIEWER_PRIORITY } from "./mime-policy";
import type { ResolvedCell } from "./render-resolution";

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
    (link) => link.rel === "prefetch" && link.href === href,
  );
  if (existing) return href;

  const link = targetDocument.createElement("link");
  // The Sift renderer fetches WASM from inside a sandboxed opaque-origin output
  // document, so a parent-page preload is never consumed by the same context
  // and Chrome warns. Prefetch still warms the immutable sidecar without
  // loosening the output-frame sandbox or producing an unused-preload warning.
  link.rel = "prefetch";
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
  return mimeType != null && rendererPluginNameForMime(mimeType) === "sift";
}
