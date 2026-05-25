export { CommBridgeManager, createCommBridgeManager } from "./comm-bridge-manager";
// Message protocol types
export type {
  ClearMessage,
  EvalMessage,
  EvalResultMessage,
  HostContextMessage,
  IframeErrorMessage,
  // Utilities
  IframeMessage,
  // Iframe → Parent
  IframeToParentMessage,
  LinkClickMessage,
  MessageType,
  // Parent → Iframe
  ParentToIframeMessage,
  PingMessage,
  PongMessage,
  ReadyMessage,
  RenderCompleteMessage,
  RenderMessage,
  RenderPayload,
  ResizeMessage,
  ThemeMessage,
  TracebackNavigateMessage,
  WidgetStateMessage,
  WidgetUpdateMessage,
} from "./frame-bridge";
export { isIframeMessage, isMessageType } from "./frame-bridge";
export {
  createIsolatedFrameDocument,
  ISOLATED_FRAME_ALLOW_ATTR,
  ISOLATED_FRAME_SANDBOX_ATTRS,
  isTauriFrameRuntime,
  NTERACT_FRAME_URL,
} from "./frame-config";
export type { IsolatedFrameDocument } from "./frame-config";
// HTML template generator
export { FRAME_HTML, generateFrameHtml } from "./frame-html";
export {
  createNteractEmbedHostContext,
  createNteractThemeVariables,
  mcpAppHostContextToNteractEmbedPatch,
  mergeNteractEmbedHostContext,
} from "./host-context";
export type {
  McpAppHostContextLike,
  McpAppHostContextToNteractEmbedOptions,
  NteractEmbedContainerDimensions,
  NteractEmbedDeviceCapabilities,
  NteractEmbedDisplayMode,
  NteractEmbedHostContext,
  NteractEmbedHostContextPatch,
  NteractEmbedPlatform,
  NteractEmbedSafeAreaInsets,
  NteractEmbedTheme,
} from "./host-context";
// Security testing component
export { IsolationTest } from "./IsolationTest";
export type { IsolatedFrameHandle, IsolatedFrameProps } from "./isolated-frame";
export { IsolatedFrame } from "./isolated-frame";
export { IsolatedFrameRuntime, TYPE_TO_METHOD } from "./isolated-frame-runtime";
export type {
  IsolatedFrameRendererBundle,
  IsolatedFrameRuntimeCallbacks,
  IsolatedFrameRuntimeDiagnosticLevel,
  IsolatedFrameRuntimeOptions,
} from "./isolated-frame-runtime";
export { createNteractOutputEmbed } from "./output-embed";
export type {
  NteractOutputEmbedDiagnosticHandler,
  NteractOutputEmbedHandle,
  NteractOutputEmbedOptions,
  NteractOutputRendererBundleProvider,
  NteractOutputRendererPlugin,
  NteractOutputRendererPluginLoader,
} from "./output-embed";
export { McpAppOutputFrame } from "./mcp-app-output-frame";
export type { McpAppOutputFrameProps } from "./mcp-app-output-frame";
export {
  createBlobResolver,
  createHttpBlobResolver,
  isOutputManifest,
  normalizeBlobResolver,
  resolveManifest,
  resolveManifestSync,
} from "./output-manifest";
export type {
  BlobResolverInput,
  ContentRef,
  OutputBlobRef,
  OutputBlobResolver,
  OutputManifest,
  ResolvedJupyterOutput,
} from "./output-manifest";
export { resolveEmbeddableOutputs } from "./embeddable-output";
export type { NteractEmbeddableOutput, ResolveEmbeddableOutputsOptions } from "./embeddable-output";
export {
  createInlineOnlyBlobResolver,
  createMcpAppBlobResolver,
  mcpAppCellPreviewText,
  mcpAppCellsToSharedOutputs,
  mcpAppStructuredContentToSharedOutputInputs,
} from "./mcp-app-structured-content";
export type {
  McpAppCellData,
  McpAppCellOutput,
  McpAppStructuredContent,
  McpSharedOutputInputs,
} from "./mcp-app-structured-content";
export {
  needsRendererPlugin,
  rendererPluginInfoForMime,
  rendererPluginNameForMime,
} from "./renderer-plugin-info";
export type { RendererPluginInfo, RendererPluginName } from "./renderer-plugin-info";
export type { IdentifiedJupyterOutput } from "./output-payloads";
// Provider and hook for renderer bundle
export { IsolatedRendererProvider, useIsolatedRenderer } from "./isolated-renderer-context";
