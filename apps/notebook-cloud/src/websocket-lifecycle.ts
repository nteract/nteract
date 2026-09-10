import type { CloudflareWebSocket, DurableObjectState } from "./cloudflare-types.ts";
import type { CloudLogFields } from "./observability.ts";
import { errorMessage } from "./observability.ts";

export type WebSocketDisconnect =
  | { source: "websocket_close"; code?: number; reason?: string; wasClean?: boolean }
  | { source: "websocket_error"; error?: unknown }
  | { source: "room"; code?: number; reason?: string };

/** Read runtime evidence before closing the socket. Never let diagnostics block cleanup. */
export function webSocketDisconnectFields(
  state: DurableObjectState,
  socket: CloudflareWebSocket,
  disconnect: WebSocketDisconnect,
  connectedAt: string,
): CloudLogFields {
  let lastAutoResponseAt: string | null = null;
  try {
    lastAutoResponseAt = state.getWebSocketAutoResponseTimestamp?.(socket)?.toISOString() ?? null;
  } catch {
    // Some runtimes have already released the socket by the time close/error runs.
  }
  let closeError: string | undefined;
  if (disconnect.source === "websocket_error" && disconnect.error !== undefined) {
    try {
      closeError = errorMessage(disconnect.error).slice(0, 512);
    } catch {
      closeError = "unprintable WebSocket error";
    }
  }
  const startedAt = Date.parse(connectedAt);
  return {
    close_source: disconnect.source,
    close_code: "code" in disconnect ? disconnect.code : undefined,
    close_reason: "reason" in disconnect ? disconnect.reason?.slice(0, 256) : undefined,
    close_was_clean: "wasClean" in disconnect ? disconnect.wasClean : undefined,
    close_error: closeError,
    connection_duration_ms: Number.isFinite(startedAt)
      ? Math.max(0, Date.now() - startedAt)
      : undefined,
    auto_response_timestamp_supported:
      typeof state.getWebSocketAutoResponseTimestamp === "function",
    last_auto_response_at: lastAutoResponseAt,
  };
}
