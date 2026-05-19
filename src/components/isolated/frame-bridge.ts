// JSON-RPC method and payload definitions live in `rpc-methods.ts`.
// This module intentionally only models the bootstrap/raw messages that the
// iframe may still emit before or around transport setup.

// --- Message Types: Iframe → Parent ---

/**
 * Iframe has finished loading and is ready to receive messages.
 */
export interface ReadyMessage {
  type: "ready";
}

/**
 * Response to a ping message.
 */
export interface PongMessage {
  type: "pong";
  payload: {
    receivedAt: number;
    /** Echo back the payload from the ping */
    echo?: unknown;
  };
}

/**
 * Result of evaluating code in the iframe.
 */
export interface EvalResultMessage {
  type: "eval_result";
  payload: {
    success: boolean;
    result?: string;
    error?: string;
  };
}

/**
 * Iframe content has finished rendering.
 */
export interface RenderCompleteMessage {
  type: "render_complete";
  payload?: {
    /** Height of the rendered content */
    height?: number;
  };
}

/**
 * Iframe content size has changed.
 */
export interface ResizeMessage {
  type: "resize";
  payload: {
    /** New height of the content */
    height: number;
    /** New width of the content (optional) */
    width?: number;
  };
}

/**
 * User clicked a link in the iframe.
 */
export interface LinkClickMessage {
  type: "link_click";
  payload: {
    /** The URL that was clicked */
    url: string;
    /** Whether it was a ctrl/cmd click */
    newTab: boolean;
  };
}

/**
 * User double-clicked in the iframe.
 */
export interface DoubleClickMessage {
  type: "dblclick";
}

/**
 * Widget state was updated in the iframe (needs to sync to kernel).
 */
export interface WidgetUpdateMessage {
  type: "widget_update";
  payload: {
    /** Comm ID of the widget */
    commId: string;
    /** Updated state */
    state: Record<string, unknown>;
    /** Optional buffers (base64 encoded) */
    buffers?: string[];
  };
}

/**
 * An error occurred in the iframe.
 */
export interface IframeErrorMessage {
  type: "error";
  payload: {
    message: string;
    stack?: string;
  };
}

/**
 * The React renderer bundle has been loaded and initialized.
 * This is sent after the bundle is eval'd and React is mounted.
 */
export interface RendererReadyMessage {
  type: "renderer_ready";
}

// --- Widget Comm Protocol: Iframe → Parent ---

/**
 * Iframe widget system is ready to receive comm messages.
 * Parent should send widget_snapshot with existing models after this.
 */
export interface WidgetReadyMessage {
  type: "widget_ready";
}

/**
 * Widget initiated a state update or custom message.
 * Parent should forward to kernel and update its store.
 */
export interface WidgetCommMsgMessage {
  type: "widget_comm_msg";
  payload: {
    /** Comm ID of the widget */
    commId: string;
    /** Message method: "update" or "custom" */
    method: "update" | "custom";
    /** State patch or custom content */
    data: Record<string, unknown>;
    /** Buffer paths */
    bufferPaths?: string[][];
    /** Binary buffers */
    buffers?: ArrayBuffer[];
  };
}

/**
 * Widget initiated comm close.
 * Parent should forward to kernel and clean up.
 */
export interface WidgetCommCloseMessage {
  type: "widget_comm_close";
  payload: {
    /** Comm ID of the widget to close */
    commId: string;
  };
}

// --- Global Find: Iframe → Parent ---

/**
 * Report search results from the iframe.
 * Sent after processing a search message.
 */
export interface SearchResultsMessage {
  type: "search_results";
  payload: {
    /** Number of matches found */
    count: number;
  };
}

/**
 * All message types that can be sent from iframe to parent.
 */
export type IframeToParentMessage =
  | ReadyMessage
  | PongMessage
  | EvalResultMessage
  | RenderCompleteMessage
  | ResizeMessage
  | LinkClickMessage
  | DoubleClickMessage
  | WidgetUpdateMessage
  | IframeErrorMessage
  | RendererReadyMessage
  | WidgetReadyMessage
  | WidgetCommMsgMessage
  | WidgetCommCloseMessage
  | SearchResultsMessage;

// --- Utility Types ---

/**
 * All raw message types (for generic handling).
 */
export type IframeMessage = IframeToParentMessage;

/**
 * Extract the message type string.
 */
export type MessageType = IframeMessage["type"];

/**
 * Type guard to check if a message is from the iframe.
 */
export function isIframeMessage(data: unknown): data is IframeToParentMessage {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as { type?: unknown };
  return (
    typeof msg.type === "string" &&
    [
      "ready",
      "pong",
      "eval_result",
      "render_complete",
      "resize",
      "link_click",
      "dblclick",
      "widget_update",
      "error",
      "renderer_ready",
      "widget_ready",
      "widget_comm_msg",
      "widget_comm_close",
      "search_results",
    ].includes(msg.type)
  );
}

/**
 * Type guard for specific message types.
 */
export function isMessageType<T extends IframeMessage["type"]>(
  data: unknown,
  type: T,
): data is Extract<IframeMessage, { type: T }> {
  if (typeof data !== "object" || data === null) return false;
  return (data as { type?: unknown }).type === type;
}
