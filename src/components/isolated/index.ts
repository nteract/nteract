export { CommBridgeManager, createCommBridgeManager } from "./comm-bridge-manager";
// Raw iframe-to-parent message protocol types
export type {
  EvalResultMessage,
  IframeErrorMessage,
  IframeMessage,
  IframeToParentMessage,
  LinkClickMessage,
  MessageType,
  PongMessage,
  ReadyMessage,
  RenderCompleteMessage,
  ResizeMessage,
  WidgetUpdateMessage,
} from "./frame-bridge";
export { isIframeMessage, isMessageType } from "./frame-bridge";
// HTML template generator
export { FRAME_HTML, generateFrameHtml } from "./frame-html";
// Security testing component
export { IsolationTest } from "./IsolationTest";
export type { IsolatedFrameHandle, IsolatedFrameProps } from "./isolated-frame";
export { IsolatedFrame } from "./isolated-frame";
// Framework-agnostic controller and helpers
export type {
  FrameError,
  FrameLifecycleState,
  FrameLinkClickEvent,
  FrameRenderCompleteEvent,
  FrameResizeEvent,
  FrameSource,
  FrameThemePayload,
  FrameWidgetUpdateEvent,
  IsolatedFrameControllerOptions,
  RenderPayload,
} from "./isolated-frame-controller";
export {
  ISOLATED_FRAME_SANDBOX,
  IsolatedFrameController,
  resolveFrameSource,
} from "./isolated-frame-controller";
// Provider and hook for renderer bundle
export { IsolatedRendererProvider, useIsolatedRenderer } from "./isolated-renderer-context";
