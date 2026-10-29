/**
 * JSON-RPC methods and payloads for Bokeh document sessions.
 *
 * These are output-session extension methods: the host serves the iframe→host
 * requests only through the registered Bokeh output-session plugin, and only
 * for sessions bound to an output of the requesting frame. Host→iframe
 * notifications go through `IsolatedFrameHandle.notifyExtension`.
 */

// Iframe → Host (Requests)
export const NTERACT_BOKEH_SESSION_OPEN = "nteract/bokehSessionOpen" as const;
export const NTERACT_BOKEH_SET_PROPS = "nteract/bokehSetProps" as const;
export const NTERACT_BOKEH_APPLY_PATCH = "nteract/bokehApplyPatch" as const;
export const NTERACT_BOKEH_SESSION_DATA = "nteract/bokehSessionData" as const;

/** Iframe→host requests served by the Bokeh output-session plugin. */
export const NTERACT_BOKEH_SESSION_HOST_METHODS = [
  NTERACT_BOKEH_SESSION_OPEN,
  NTERACT_BOKEH_SET_PROPS,
  NTERACT_BOKEH_APPLY_PATCH,
  NTERACT_BOKEH_SESSION_DATA,
] as const;
export type NteractBokehSessionHostMethod = (typeof NTERACT_BOKEH_SESSION_HOST_METHODS)[number];

// Host → Iframe (Notifications)
export const NTERACT_BOKEH_SESSION_STATE = "nteract/bokehSessionState" as const;
export const NTERACT_BOKEH_SESSION_DOC = "nteract/bokehSessionDoc" as const;
export const NTERACT_BOKEH_SESSION_EVENTS = "nteract/bokehSessionEvents" as const;

// ── Iframe → Host: Request Params & Results ─────────────────────────

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
   * false the frame renders the payload's saved state read-only.
   */
  live: boolean;
  /** Whether this connection may write the session (viewers may not). */
  writable: boolean;
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

export type NteractBokehPropOrigin = "kernel" | "local" | "peer";

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
  /** `delta`: who won each changed property (absent from older hosts). */
  propOrigins?: Record<string, Record<string, NteractBokehPropOrigin>>;
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
      echo_of?: number;
    }
  | {
      kind: "ColumnsPatched";
      source_id: string;
      base_version: number;
      new_version: number;
      patches: unknown;
      echo_of?: number;
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

export interface NteractBokehSessionStateParams {
  sessionId: string;
  outputId: string;
  status: NteractBokehSessionStatus;
  epoch: number | null;
  /**
   * Whether the host follows the session document for this frame. False
   * while connected means a new host bridge that the frame must open again.
   */
  live: boolean;
  writable: boolean;
  /** With status `error`: why the host stopped following the document. */
  error?: string;
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
