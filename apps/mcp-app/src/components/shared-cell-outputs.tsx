import { useCallback, useEffect, useMemo, useState } from "react";
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
import { rendererPluginNameForMime } from "@/components/isolated/renderer-plugin-info";
import { selectMimeType } from "@/components/outputs/mime-priority";
import { createMcpOutputTransport, type OutputResourceReader } from "../lib/output-resources";
import type { CellData } from "../types";
import { errorDetails, hostLog } from "../lib/host-log";

const SHARED_RENDERER_BUNDLE = { rendererCode, rendererCss };

export interface SharedCellOutputsProps {
  cell: CellData;
  blobBaseUrl?: string;
  hostContext?: McpUiHostContext | null;
  hostCapabilities?: McpUiHostCapabilities | null;
  resourceReader?: OutputResourceReader | null;
}

export function SharedCellOutputs({
  cell,
  blobBaseUrl,
  hostContext,
  hostCapabilities,
  resourceReader,
}: SharedCellOutputsProps) {
  const transport = useMemo(
    () =>
      resourceReader && cell.output_resource_base
        ? createMcpOutputTransport(resourceReader, cell.output_resource_base)
        : null,
    [resourceReader, cell.output_resource_base],
  );
  const rendererPluginLoader = useMemo(
    () => transport?.rendererPluginLoader ?? createDaemonRendererPluginLoader(blobBaseUrl),
    [blobBaseUrl, transport],
  );
  const rendererAssetsBaseUrl = daemonRendererAssetsBaseUrl(blobBaseUrl);
  const hostCsp = hostCapabilities?.sandbox?.csp;
  const outputDocumentUrl = transport ? null : daemonOutputFrameUrl(blobBaseUrl, hostCsp);
  const daemonOutputFrameBlocked = daemonOutputFrameBlockedByHostCsp(blobBaseUrl, hostCsp);
  const needsSift = cell.outputs.some(
    (output) => rendererPluginNameForMime(selectMimeType(output.data ?? {}) ?? "") === "sift",
  );
  const [assets, setAssets] = useState<{
    transport: typeof transport;
    urls?: Record<string, string>;
    error?: string;
  } | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    setRenderError(null);
  }, [cell]);
  useEffect(() => {
    if (!transport || !needsSift) return;
    let active = true;
    transport.rendererAssetUrls().then(
      (urls) => {
        if (active) setAssets({ transport, urls });
      },
      (error) => {
        if (active)
          setAssets({ transport, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [transport, needsSift]);

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
    setRenderError(error.message);
    hostLog("error", "shared-output-renderer-failed", { error: errorDetails(error) });
  }, []);

  useEffect(() => {
    if (transport || !blobBaseUrl || outputDocumentUrl !== null || !daemonOutputFrameBlocked)
      return;
    hostLog("warning", "shared-output-daemon-frame-blocked", {
      outputFrameOrigin: daemonOutputFrameOrigin(blobBaseUrl),
      frameDomains: hostCsp?.frameDomains ?? [],
      fallback: "srcdoc-raster-image-data-uri",
      maxInlineImageBytes: MCP_APP_INLINE_RASTER_IMAGE_MAX_BYTES,
    });
  }, [transport, blobBaseUrl, daemonOutputFrameBlocked, hostCsp, outputDocumentUrl]);

  const assetError = assets?.transport === transport ? assets?.error : undefined;
  if (renderError || assetError)
    return <div role="alert">Unable to render output: {renderError ?? assetError}</div>;
  if (transport && needsSift && (assets?.transport !== transport || !assets.urls))
    return <div role="status">Loading table…</div>;

  return (
    <McpAppOutputFrame
      cell={cell}
      blobBaseUrl={blobBaseUrl}
      hostContext={hostContext}
      rendererBundle={SHARED_RENDERER_BUNDLE}
      rendererPluginLoader={rendererPluginLoader}
      rendererAssetsBaseUrl={rendererAssetsBaseUrl}
      rendererAssetUrls={assets?.transport === transport ? assets?.urls : undefined}
      blobResolver={transport?.blobResolver}
      outputDocumentUrl={outputDocumentUrl}
      inlineRasterBlobImages={daemonOutputFrameBlocked}
      className="shared-output-frame"
      onDiagnostic={handleDiagnostic}
      onError={handleError}
    />
  );
}
