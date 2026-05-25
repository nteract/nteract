import { useEffect, useMemo, useRef, useState } from "react";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { rendererCode, rendererCss } from "virtual:isolated-renderer";
import {
  createInlineOnlyBlobResolver,
  createMcpAppBlobResolver,
  mcpAppCellsToSharedOutputs,
} from "@/components/isolated/mcp-app-structured-content";
import {
  createNteractOutputEmbed,
  type NteractOutputEmbedHandle,
  type NteractOutputRendererBundleProvider,
} from "@/components/isolated/output-embed";
import type { CellData } from "../types";
import { errorDetails, hostLog } from "../lib/host-log";
import { mcpHostContextToNteractEmbedPatch } from "../lib/shared-host-context";
import {
  createDaemonRendererPluginLoader,
  daemonOutputFrameUrl,
} from "../lib/shared-renderer-plugin-loader";

const SHARED_RENDERER_BUNDLE: NteractOutputRendererBundleProvider = {
  rendererCode,
  rendererCss,
};

const SHARED_OUTPUT_MAX_HEIGHT = 2000;

interface SharedCellOutputsProps {
  cell: CellData;
  blobBaseUrl?: string;
  hostContext?: McpUiHostContext | null;
}

export function SharedCellOutputs({ cell, blobBaseUrl, hostContext }: SharedCellOutputsProps) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<NteractOutputEmbedHandle | null>(null);
  const [failed, setFailed] = useState(false);

  const outputs = useMemo(
    () => mcpAppCellsToSharedOutputs([cell], blobBaseUrl),
    [cell, blobBaseUrl],
  );
  const pluginLoader = useMemo(() => createDaemonRendererPluginLoader(blobBaseUrl), [blobBaseUrl]);
  const hostContextPatch = useMemo(
    () => mcpHostContextToNteractEmbedPatch(hostContext, blobBaseUrl),
    [hostContext, blobBaseUrl],
  );
  const hostContextPatchRef = useRef(hostContextPatch);
  const blobResolver = useMemo(
    () => (blobBaseUrl ? createMcpAppBlobResolver(blobBaseUrl) : createInlineOnlyBlobResolver()),
    [blobBaseUrl],
  );
  const outputDocumentUrl = useMemo(() => daemonOutputFrameUrl(blobBaseUrl), [blobBaseUrl]);

  useEffect(() => {
    setFailed(false);
  }, [cell.cell_id, blobBaseUrl]);

  useEffect(() => {
    if (failed || !targetRef.current || outputs.length === 0) return;

    const handle = createNteractOutputEmbed({
      target: targetRef.current,
      rendererBundle: SHARED_RENDERER_BUNDLE,
      rendererPluginLoader: pluginLoader,
      blobResolver,
      hostContext: hostContextPatchRef.current,
      outputDocumentUrl,
      autoHeight: false,
      maxHeight: SHARED_OUTPUT_MAX_HEIGHT,
      onDiagnostic(phase, details, level = "debug", source = "isolated-frame") {
        if (level !== "error" && level !== "warn") return;
        hostLog(level === "warn" ? "warning" : "error", "shared-output-renderer-diagnostic", {
          phase,
          source,
          details,
        });
      },
      onError(error) {
        hostLog("error", "shared-output-renderer-failed", {
          error: errorDetails(error),
        });
        handleRef.current?.dispose();
        handleRef.current = null;
        setFailed(true);
      },
    });

    handleRef.current = handle;
    return () => {
      handle.dispose();
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [blobBaseUrl, blobResolver, failed, outputDocumentUrl, outputs.length, pluginLoader]);

  useEffect(() => {
    if (failed || outputs.length === 0) return;
    handleRef.current?.renderBatch(outputs).catch((error) => {
      hostLog("error", "shared-output-render-failed", {
        error: errorDetails(error),
      });
      handleRef.current?.dispose();
      handleRef.current = null;
      setFailed(true);
    });
  }, [failed, outputs]);

  useEffect(() => {
    hostContextPatchRef.current = hostContextPatch;
    handleRef.current?.setHostContext(hostContextPatch);
  }, [hostContextPatch]);

  if (failed) return null;

  return <div ref={targetRef} className="shared-output-frame" />;
}
