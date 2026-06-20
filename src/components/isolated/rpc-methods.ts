/**
 * JSON-RPC 2.0 method definitions for nteract iframe communication.
 *
 * These methods extend the MCP Apps protocol with nteract-specific capabilities
 * for notebook output rendering, widget communication, and search.
 *
 * Standard MCP Apps methods (handled by the SDK):
 * - ui/notifications/host-context-changed → theme sync
 * - ui/notifications/size-changed → resize
 * - ui/resource-teardown → disposal
 * - notifications/message → iframe logs
 * - ui/open-link → link clicks
 * - ping → health check
 *
 * Nteract extension methods use the "nteract/" namespace.
 */

// ── Method Constants ────────────────────────────────────────────────

// Host → Iframe (Requests — expect a response)
export const NTERACT_EVAL = "nteract/eval" as const;
export const NTERACT_INSTALL_RENDERER = "nteract/installRenderer" as const;
export const NTERACT_SEARCH = "nteract/search" as const;
export const NTERACT_MEASURE_ELEMENT = "nteract/measureElement" as const;

// Host → Iframe (Notifications — fire-and-forget)
export const NTERACT_RENDER_OUTPUT = "nteract/renderOutput" as const;
export const NTERACT_RENDER_BATCH = "nteract/renderBatch" as const;
export const NTERACT_CLEAR_OUTPUTS = "nteract/clearOutputs" as const;
export const NTERACT_SEARCH_NAVIGATE = "nteract/searchNavigate" as const;
export const NTERACT_COMM_OPEN = "nteract/commOpen" as const;
export const NTERACT_COMM_MSG = "nteract/commMsg" as const;
export const NTERACT_COMM_CLOSE = "nteract/commClose" as const;
export const NTERACT_WIDGET_SNAPSHOT = "nteract/widgetSnapshot" as const;
export const NTERACT_BRIDGE_READY = "nteract/bridgeReady" as const;
export const NTERACT_WIDGET_STATE = "nteract/widgetState" as const;

// Host → Iframe (Notifications) — additional
export const NTERACT_THEME = "nteract/theme" as const;
export const NTERACT_PING = "nteract/ping" as const;
export const NTERACT_DIAGNOSTIC = "nteract/diagnostic" as const;

// Iframe → Host (Notifications)
export const NTERACT_READY = "nteract/ready" as const;
export const NTERACT_RENDERER_READY = "nteract/rendererReady" as const;
export const NTERACT_RENDER_COMPLETE = "nteract/renderComplete" as const;
export const NTERACT_RESIZE = "nteract/resize" as const;
export const NTERACT_LINK_CLICK = "nteract/linkClick" as const;
export const NTERACT_DOUBLE_CLICK = "nteract/doubleClick" as const;
export const NTERACT_ERROR = "nteract/error" as const;
export const NTERACT_WIDGET_READY = "nteract/widgetReady" as const;
export const NTERACT_WIDGET_COMM_MSG = "nteract/widgetCommMsg" as const;
export const NTERACT_WIDGET_COMM_CLOSE = "nteract/widgetCommClose" as const;
export const NTERACT_RAW_COMM_OPEN = "nteract/rawCommOpen" as const;
export const NTERACT_RAW_COMM_MSG = "nteract/rawCommMsg" as const;
export const NTERACT_RAW_COMM_CLOSE = "nteract/rawCommClose" as const;
export const NTERACT_WIDGET_UPDATE = "nteract/widgetUpdate" as const;
export const NTERACT_EVAL_RESULT = "nteract/evalResult" as const;
export const NTERACT_PONG = "nteract/pong" as const;
export const NTERACT_SEARCH_RESULTS = "nteract/searchResults" as const;
export const NTERACT_MOUSE_DOWN = "nteract/mouseDown" as const;
export const NTERACT_MOUSE_UP = "nteract/mouseUp" as const;
export const NTERACT_WHEEL_BOUNDARY = "nteract/wheelBoundary" as const;

// MCP Apps-compatible methods used by embedders. Notebook rendering commands
// remain in the nteract/* namespace.
export const MCP_UI_HOST_CONTEXT_CHANGED = "ui/notifications/host-context-changed" as const;
export const MCP_UI_SIZE_CHANGED = "ui/notifications/size-changed" as const;
export const MCP_UI_RESOURCE_TEARDOWN = "ui/resource-teardown" as const;
export const MCP_NOTIFICATIONS_MESSAGE = "notifications/message" as const;

// ── Host → Iframe: Request Params & Results ─────────────────────────

export interface NteractEvalParams {
  code: string;
}

export interface NteractEvalResult {
  success: boolean;
  result?: string;
  error?: string;
}

export interface NteractInstallRendererParams {
  /** CJS module code exporting an install(ctx) function */
  code: string;
  /** Optional CSS to inject (e.g., KaTeX styles) */
  css?: string;
}

export interface NteractSearchParams {
  query: string;
  caseSensitive?: boolean;
}

export interface NteractSearchResult {
  count: number;
}

export interface NteractMeasureElementParams {
  anchorId: string;
}

export interface NteractMeasureElementResult {
  found: boolean;
  top?: number;
  height?: number;
}

// ── Host → Iframe: Notification Params ──────────────────────────────

export interface NteractRenderOutputParams {
  mimeType: string;
  data: unknown;
  metadata?: Record<string, unknown>;
  cellId?: string;
  outputIndex?: number;
  append?: boolean;
  replace?: boolean;
}

export interface NteractRenderBatchParams {
  outputs: NteractRenderOutputParams[];
}

export interface NteractSearchNavigateParams {
  matchIndex: number;
}

export interface NteractCommOpenParams {
  commId: string;
  targetName: string;
  state: Record<string, unknown>;
  bufferPaths?: string[][];
  buffers?: ArrayBuffer[];
}

export interface NteractCommMsgParams {
  commId: string;
  method: "update" | "custom" | "raw";
  data: unknown;
  metadata?: Record<string, unknown>;
  bufferPaths?: string[][];
  buffers?: ArrayBuffer[];
}

export interface NteractCommCloseParams {
  commId: string;
}

export interface NteractWidgetSnapshotParams {
  models: Array<{
    commId: string;
    targetName: string;
    state: Record<string, unknown>;
    buffers?: ArrayBuffer[];
  }>;
}

export interface NteractWidgetStateParams {
  commId: string;
  state: Record<string, unknown>;
  buffers?: string[];
}

// ── Iframe → Host: Notification Params ──────────────────────────────

export interface NteractRenderCompleteParams {
  height?: number;
}

export interface NteractWidgetCommMsgParams {
  commId: string;
  method: "update" | "custom";
  data: Record<string, unknown>;
  bufferPaths?: string[][];
  buffers?: ArrayBuffer[];
}

export interface NteractWidgetCommCloseParams {
  commId: string;
}

export interface NteractRawCommOpenParams {
  commId: string;
  targetName: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  buffers?: ArrayBuffer[];
}

export interface NteractRawCommMsgParams {
  commId: string;
  data: unknown;
  metadata?: Record<string, unknown>;
  buffers?: ArrayBuffer[];
}

export interface NteractRawCommCloseParams {
  commId: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  buffers?: ArrayBuffer[];
}

export interface NteractWidgetUpdateParams {
  commId: string;
  state: Record<string, unknown>;
  buffers?: string[];
}

export interface NteractWheelBoundaryParams {
  deltaY?: number;
  deltaMode?: number;
}

export interface NteractDiagnosticParams {
  source?: "isolated-frame" | "isolated-renderer" | "iframe-libraries";
  phase: string;
  level?: "debug" | "info" | "warn" | "error";
  details?: Record<string, unknown>;
}

export interface McpUiSizeChangedParams {
  width?: number;
  height?: number;
}

export interface McpUiResourceTeardownParams {
  reason?: string;
}

export interface McpNotificationMessageParams {
  level?: "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";
  logger?: string;
  data?: unknown;
}
