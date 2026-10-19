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
export const NTERACT_BOKEH_SESSION_STATE = "nteract/bokehSessionState" as const;
export const NTERACT_BOKEH_SESSION_DOC = "nteract/bokehSessionDoc" as const;
export const NTERACT_BOKEH_SESSION_EVENTS = "nteract/bokehSessionEvents" as const;

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
export const NTERACT_WIDGET_UPDATE = "nteract/widgetUpdate" as const;
export const NTERACT_EVAL_RESULT = "nteract/evalResult" as const;
export const NTERACT_PONG = "nteract/pong" as const;
export const NTERACT_SEARCH_RESULTS = "nteract/searchResults" as const;
export const NTERACT_MOUSE_DOWN = "nteract/mouseDown" as const;
export const NTERACT_MOUSE_UP = "nteract/mouseUp" as const;
export const NTERACT_WHEEL_BOUNDARY = "nteract/wheelBoundary" as const;

// Iframe → Host (Requests) — Bokeh document sessions. The host only serves
// sessions bound to an output of the requesting frame.
export const NTERACT_BOKEH_SESSION_OPEN = "nteract/bokehSessionOpen" as const;
export const NTERACT_BOKEH_SET_PROPS = "nteract/bokehSetProps" as const;
export const NTERACT_BOKEH_APPLY_PATCH = "nteract/bokehApplyPatch" as const;
export const NTERACT_BOKEH_SESSION_DATA = "nteract/bokehSessionData" as const;
export const NTERACT_BOKEH_SESSION_METHODS = [
  NTERACT_BOKEH_SESSION_OPEN,
  NTERACT_BOKEH_SET_PROPS,
  NTERACT_BOKEH_APPLY_PATCH,
  NTERACT_BOKEH_SESSION_DATA,
] as const;
export type NteractBokehSessionMethod = (typeof NTERACT_BOKEH_SESSION_METHODS)[number];

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

export type NteractBokehSessionStatus = "connected" | "disconnected" | "closed" | "error";

export interface NteractBokehResolvedBuffer {
  id: string;
  data: ArrayBuffer;
}

export interface NteractBokehSessionOpenParams {
  sessionId: string;
  outputId: string;
}

export interface NteractBokehSessionOpenResult {
  sessionId: string;
  outputId: string;
  status: NteractBokehSessionStatus;
  epoch: number | null;
  /**
   * Whether the host follows the session document for this frame. When
   * false the frame renders the payload's `document` read-only.
   */
  live: boolean;
}

/** Property values of the session document, decoded from their JSON text. */
export interface NteractBokehModelState {
  type: string;
  refProps: string[];
  props: Record<string, unknown>;
}

export interface NteractBokehDocMeta {
  rootIds: string[];
  title: string | null;
  bokehVersion: string;
  /** DocJson keys besides roots, title and version (`defs`, `config`). */
  docExtras: Record<string, unknown> | null;
}

/** Version of one `columns/{source}/{col}` entry; the frame loads data on demand. */
export interface NteractBokehColumnVersion {
  version: number;
  size: number;
}

/**
 * One step of the session document as the frame applies it. A `full` update
 * carries the whole state (first sync, new epoch, resync); a `delta` carries
 * what one sync step changed on the frame's current epoch.
 */
export interface NteractBokehDocUpdate {
  sessionId: string;
  epoch: number;
  kind: "full" | "delta";
  /**
   * Full only: the frame already shows this state (it applied the previous
   * document up to the replacement point), so it can switch epochs without
   * touching BokehJS.
   */
  canSwitch: boolean;
  /** Always set on `full`; on `delta` only when the meta changed. */
  meta: NteractBokehDocMeta | null;
  /** `full`: every model. `delta`: added models. */
  models: Record<string, NteractBokehModelState>;
  /** `delta`: changed properties of models that existed before. */
  props: Record<string, Record<string, unknown>>;
  removed: string[];
  /** `full`: every column. `delta`: changed columns, `null` when removed. */
  columns: Record<string, Record<string, NteractBokehColumnVersion | null>>;
}

export interface NteractBokehSetPropsParams {
  sessionId: string;
  outputId: string;
  /** `{model_id: {prop: bokeh_encoded_json}}`; non-reference properties only. */
  props: Record<string, Record<string, string>>;
}

export interface NteractBokehSetPropsResult {
  status: "written" | "unchanged" | "read_only" | "rejected";
  error?: string;
}

/** One-off events only: `MessageSent`, `ColumnsStreamed`, `ColumnsPatched`. */
export interface NteractBokehApplyPatchParams {
  sessionId: string;
  outputId: string;
  transactionId: string;
  patch: Record<string, unknown>;
  buffers: NteractBokehResolvedBuffer[];
}

export type NteractBokehApplyPatchResult =
  | { status: "accepted"; sessionId: string; transactionId: string }
  | { status: "error"; sessionId: string; transactionId: string; error: string };

/** A column's Bokeh encoding (buffers inlined as base64) at a data version. */
export interface NteractBokehColumnData {
  version: number;
  data: unknown;
}

export type NteractBokehDataEvent =
  | {
      kind: "ColumnsStreamed";
      source_id: string;
      base_version: number;
      new_version: number;
      data: unknown;
      rollover?: number | null;
    }
  | {
      kind: "ColumnsPatched";
      source_id: string;
      base_version: number;
      new_version: number;
      patches: unknown;
    }
  | {
      kind: "ColumnDataChanged";
      source_id: string;
      base_version: number;
      new_version: number;
      columns: Record<string, NteractBokehColumnData>;
      columns_removed: string[];
    };

export interface NteractBokehMessage {
  msg_type: string;
  msg_data?: unknown;
}

/** A `bokeh_session_events` broadcast with buffers and column blobs loaded. */
export interface NteractBokehResolvedEvents {
  sessionId: string;
  epoch: number;
  transactionId: string;
  dataEvents: NteractBokehDataEvent[];
  messages: NteractBokehMessage[];
  buffers: NteractBokehResolvedBuffer[];
}

export interface NteractBokehSessionDataParams {
  sessionId: string;
  outputId: string;
  /** Columns to load per source; `null` loads every column of the source. */
  sources: Record<string, string[] | null>;
  /** Also fetch the data events retained since each source's last fold. */
  tail: boolean;
}

export interface NteractBokehSessionDataResult {
  epoch: number;
  columns: Record<string, Record<string, NteractBokehColumnData>>;
  events: NteractBokehResolvedEvents[];
  /** Sources whose tail was too long; their fold arrives as a document change. */
  foldRequested: string[];
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
  method: "update" | "custom";
  data: Record<string, unknown>;
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

export interface NteractBokehSessionStateParams {
  sessionId: string;
  outputId: string;
  status: NteractBokehSessionStatus;
  epoch: number | null;
}

export interface NteractBokehSessionDocParams {
  outputId: string;
  update: NteractBokehDocUpdate;
}

export interface NteractBokehSessionEventsParams {
  outputId: string;
  events: NteractBokehResolvedEvents;
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
