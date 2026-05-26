import { useEffect, useMemo, useRef, useState } from "react";
import {
  createInlineOnlyBlobResolver,
  createMcpAppBlobResolver,
  mcpAppCellsToSharedOutputs,
  type McpAppCellData,
} from "./mcp-app-structured-content";
import { mcpAppHostContextToNteractEmbedPatch, type McpAppHostContextLike } from "./host-context";
import {
  createNteractOutputEmbed,
  type NteractOutputEmbedDiagnosticHandler,
  type NteractOutputEmbedHandle,
  type NteractOutputRendererBundleProvider,
  type NteractOutputRendererPluginLoader,
} from "./output-embed";

export type { McpAppCellData } from "./mcp-app-structured-content";

export interface McpAppOutputFrameProps {
  cell?: McpAppCellData;
  cells?: readonly McpAppCellData[];
  blobBaseUrl?: string;
  hostContext?: McpAppHostContextLike | null;
  rendererBundle: NteractOutputRendererBundleProvider;
  rendererPluginLoader?: NteractOutputRendererPluginLoader;
  rendererAssetsBaseUrl?: string;
  autoHeight?: boolean;
  maxHeight?: number;
  className?: string;
  onDiagnostic?: NteractOutputEmbedDiagnosticHandler;
  onError?: (error: { message: string; stack?: string }) => void;
}

function cellsForProps(
  props: Pick<McpAppOutputFrameProps, "cell" | "cells">,
): readonly McpAppCellData[] {
  return props.cells ?? (props.cell ? [props.cell] : []);
}

export function McpAppOutputFrame({
  cell,
  cells,
  blobBaseUrl,
  hostContext,
  rendererBundle,
  rendererPluginLoader,
  rendererAssetsBaseUrl,
  autoHeight,
  maxHeight,
  className,
  onDiagnostic,
  onError,
}: McpAppOutputFrameProps) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<NteractOutputEmbedHandle | null>(null);
  const [failed, setFailed] = useState(false);
  const outputCells = useMemo(() => cellsForProps({ cell, cells }), [cell, cells]);
  const outputs = useMemo(
    () => mcpAppCellsToSharedOutputs(outputCells, blobBaseUrl),
    [outputCells, blobBaseUrl],
  );
  const blobResolver = useMemo(
    () => (blobBaseUrl ? createMcpAppBlobResolver(blobBaseUrl) : createInlineOnlyBlobResolver()),
    [blobBaseUrl],
  );
  const hostContextPatch = useMemo(
    () =>
      mcpAppHostContextToNteractEmbedPatch(hostContext, {
        rendererAssetsBaseUrl,
      }),
    [hostContext, rendererAssetsBaseUrl],
  );
  const hostContextPatchRef = useRef(hostContextPatch);
  const onDiagnosticRef = useRef(onDiagnostic);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onDiagnosticRef.current = onDiagnostic;
    onErrorRef.current = onError;
  }, [onDiagnostic, onError]);

  useEffect(() => {
    setFailed(false);
  }, [outputCells, blobBaseUrl, rendererBundle, rendererPluginLoader]);

  useEffect(() => {
    if (failed || !targetRef.current || outputs.length === 0) return;

    const handle = createNteractOutputEmbed({
      target: targetRef.current,
      rendererBundle,
      rendererPluginLoader,
      blobResolver,
      hostContext: hostContextPatchRef.current,
      ...(autoHeight === undefined ? {} : { autoHeight }),
      ...(maxHeight === undefined ? {} : { maxHeight }),
      onDiagnostic(...args) {
        onDiagnosticRef.current?.(...args);
      },
      onError(error) {
        handleRef.current?.dispose();
        handleRef.current = null;
        setFailed(true);
        onErrorRef.current?.(error);
      },
    });

    handleRef.current = handle;
    return () => {
      handle.dispose();
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [
    autoHeight,
    blobResolver,
    failed,
    maxHeight,
    outputs.length,
    rendererBundle,
    rendererPluginLoader,
  ]);

  useEffect(() => {
    if (failed || outputs.length === 0) return;
    handleRef.current?.renderBatch(outputs).catch((error) => {
      const details =
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : { message: String(error) };
      handleRef.current?.dispose();
      handleRef.current = null;
      setFailed(true);
      onErrorRef.current?.(details);
    });
  }, [failed, outputs]);

  useEffect(() => {
    hostContextPatchRef.current = hostContextPatch;
    handleRef.current?.setHostContext(hostContextPatch);
  }, [hostContextPatch]);

  if (failed) return null;

  return <div ref={targetRef} className={className} />;
}
