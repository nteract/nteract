import { useCallback, useMemo } from "react";
import type { McpUiHostCapabilities, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { rendererCode, rendererCss } from "virtual:isolated-renderer";
import {
  createDaemonRendererPluginLoader,
  daemonOutputFrameUrl,
  daemonRendererAssetsBaseUrl,
} from "@/components/isolated/daemon-renderer-assets";
import { McpAppOutputFrame } from "@/components/isolated/mcp-app-output-frame";
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
  const hostFrameCsp = hostCapabilities?.sandbox?.csp;
  const outputDocumentUrl = useMemo(
    () => daemonOutputFrameUrl(blobBaseUrl, hostFrameCsp ?? { frameDomains: [] }),
    [blobBaseUrl, hostFrameCsp],
  );
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

  return (
    <McpAppOutputFrame
      cell={cell}
      blobBaseUrl={blobBaseUrl}
      hostContext={hostContext}
      rendererBundle={SHARED_RENDERER_BUNDLE}
      rendererPluginLoader={rendererPluginLoader}
      rendererAssetsBaseUrl={rendererAssetsBaseUrl}
      outputDocumentUrl={outputDocumentUrl}
      className="shared-output-frame"
      onDiagnostic={handleDiagnostic}
      onError={handleError}
    />
  );
}
