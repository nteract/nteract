import { useCallback, useEffect, useMemo } from "react";
import type { McpUiHostCapabilities, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { rendererCode, rendererCss } from "virtual:isolated-renderer";
import {
  createDaemonRendererPluginLoader,
  daemonOutputFrameBlockedByHostCsp,
  daemonOutputFrameOrigin,
  daemonOutputFrameUrl,
  daemonRendererAssetsBaseUrl,
} from "@/components/isolated/daemon-renderer-assets";
import { McpAppOutputFrame } from "@/components/isolated/mcp-app-output-frame";
import { MCP_APP_INLINE_RASTER_IMAGE_MAX_BYTES } from "@/components/isolated/mcp-app-structured-content";
import type { NteractOutputRendererBundleProvider } from "@/components/isolated/output-embed";
import type { CellData } from "../types";
import { errorDetails, hostLog } from "../lib/host-log";

const SHARED_RENDERER_BUNDLE: NteractOutputRendererBundleProvider = {
  rendererCode,
  rendererCss,
};

interface SharedCellOutputsProps {
  cell: CellData;
  blobBaseUrl?: string;
  hostContext?: McpUiHostContext | null;
  hostCapabilities?: McpUiHostCapabilities | null;
}

export function SharedCellOutputs({
  cell,
  blobBaseUrl,
  hostContext,
  hostCapabilities,
}: SharedCellOutputsProps) {
  const rendererPluginLoader = useMemo(
    () => createDaemonRendererPluginLoader(blobBaseUrl),
    [blobBaseUrl],
  );
  const rendererAssetsBaseUrl = useMemo(
    () => daemonRendererAssetsBaseUrl(blobBaseUrl),
    [blobBaseUrl],
  );
  const hostCsp = hostCapabilities?.sandbox?.csp;
  const outputDocumentUrl = useMemo(
    () => daemonOutputFrameUrl(blobBaseUrl, hostCsp),
    [blobBaseUrl, hostCsp],
  );
  const daemonOutputFrameBlocked = useMemo(
    () => daemonOutputFrameBlockedByHostCsp(blobBaseUrl, hostCsp),
    [blobBaseUrl, hostCsp],
  );
  const inlineRasterBlobImages = Boolean(blobBaseUrl && outputDocumentUrl === null);
  const handleDiagnostic = useCallback(
    (
      phase: string,
      details?: Record<string, unknown>,
      level: "debug" | "info" | "warn" | "error" = "debug",
      source: "isolated-frame" | "isolated-renderer" | "iframe-libraries" = "isolated-frame",
    ) => {
      if (level !== "error" && level !== "warn") return;
      hostLog(level === "warn" ? "warning" : "error", "shared-output-renderer-diagnostic", {
        phase,
        source,
        details,
      });
    },
    [],
  );
  const handleError = useCallback((error: { message: string; stack?: string }) => {
    hostLog("error", "shared-output-renderer-failed", {
      error: errorDetails(error),
    });
  }, []);

  useEffect(() => {
    if (!blobBaseUrl || outputDocumentUrl !== null || !daemonOutputFrameBlocked) return;

    hostLog("warning", "shared-output-daemon-frame-blocked", {
      outputFrameOrigin: daemonOutputFrameOrigin(blobBaseUrl),
      frameDomains: hostCsp?.frameDomains ?? [],
      fallback: "srcdoc-raster-image-data-uri",
      maxInlineImageBytes: MCP_APP_INLINE_RASTER_IMAGE_MAX_BYTES,
    });
  }, [blobBaseUrl, daemonOutputFrameBlocked, hostCsp, outputDocumentUrl]);

  return (
    <McpAppOutputFrame
      cell={cell}
      blobBaseUrl={blobBaseUrl}
      hostContext={hostContext}
      rendererBundle={SHARED_RENDERER_BUNDLE}
      rendererPluginLoader={rendererPluginLoader}
      rendererAssetsBaseUrl={rendererAssetsBaseUrl}
      outputDocumentUrl={outputDocumentUrl}
      inlineRasterBlobImages={inlineRasterBlobImages}
      className="shared-output-frame"
      onDiagnostic={handleDiagnostic}
      onError={handleError}
    />
  );
}
