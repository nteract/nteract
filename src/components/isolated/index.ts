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
  mergeNteractEmbedHostContext,
} from "./host-context";
export type {
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
} from "./output-embed";
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
// Provider and hook for renderer bundle
export { IsolatedRendererProvider, useIsolatedRenderer } from "./isolated-renderer-context";
