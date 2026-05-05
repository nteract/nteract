import { useNotebookHost } from "@nteract/notebook-host";
import { useCallback, useEffect } from "react";
import { sendPresenceFrame } from "runtimed";
import { logger } from "../lib/logger";
import {
  encode_cursor_presence,
  encode_focus_presence,
  encode_heartbeat_presence,
  encode_selection_presence,
} from "../wasm/runtimed-wasm/runtimed_wasm.js";

/**
 * Heartbeat interval in milliseconds. Matches the Rust-side
 * `notebook_doc::presence::DEFAULT_HEARTBEAT_MS` so room presence TTL
 * pruning (3× heartbeat) and the daemon's 300s idle-peer timeout both
 * stay comfortably ahead of an idle but live notebook window.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

// ── Hook ─────────────────────────────────────────────────────────────

/**
 * Send-only presence hook. Provides methods to broadcast local cursor
 * and selection positions to remote peers via the daemon.
 *
 * Read-side presence (remote cursors, selections, peer tracking) is
 * handled by cursor-registry.ts — a module-level frame bus subscriber
 * that dispatches directly to CodeMirror without React involvement.
 *
 * @param peerId The local peer's ID. When `null`, the hook is inactive.
 * @param peerLabel Human-readable label for this peer (e.g. OS username).
 * @param actorLabel Automerge actor label for CRDT attribution identity.
 */
export function usePresence(
  peerId: string | null,
  peerLabel: string = "",
  actorLabel: string = "",
) {
  const host = useNotebookHost();
  const transport = host.transport;

  const setCursor = useCallback(
    (cellId: string, line: number, column: number) => {
      if (!peerId) return;
      let payload: Uint8Array;
      try {
        payload = encode_cursor_presence(peerId, peerLabel, actorLabel, cellId, line, column);
      } catch (e) {
        logger.warn("[presence] encode cursor failed:", e);
        return;
      }
      sendPresenceFrame(transport, payload).catch((e: unknown) =>
        logger.warn("[presence] send cursor failed:", e),
      );
    },
    [peerId, peerLabel, actorLabel, transport],
  );

  const setSelection = useCallback(
    (cellId: string, anchorLine: number, anchorCol: number, headLine: number, headCol: number) => {
      if (!peerId) return;
      let payload: Uint8Array;
      try {
        payload = encode_selection_presence(
          peerId,
          peerLabel,
          actorLabel,
          cellId,
          anchorLine,
          anchorCol,
          headLine,
          headCol,
        );
      } catch (e) {
        logger.warn("[presence] encode selection failed:", e);
        return;
      }
      sendPresenceFrame(transport, payload).catch((e: unknown) =>
        logger.warn("[presence] send selection failed:", e),
      );
    },
    [peerId, peerLabel, actorLabel, transport],
  );

  const setFocus = useCallback(
    (cellId: string) => {
      if (!peerId) return;
      let payload: Uint8Array;
      try {
        payload = encode_focus_presence(peerId, peerLabel, actorLabel, cellId);
      } catch (e) {
        logger.warn("[presence] encode focus failed:", e);
        return;
      }
      sendPresenceFrame(transport, payload).catch((e: unknown) =>
        logger.warn("[presence] send focus failed:", e),
      );
    },
    [peerId, peerLabel, actorLabel, transport],
  );

  // Periodic heartbeats keep the daemon's idle-peer timeout from disconnecting
  // a quiet but live window. Cursor/selection/focus frames already reset the
  // timer on user activity; this covers the no-activity case.
  useEffect(() => {
    if (!peerId) return;
    const send = () => {
      let payload: Uint8Array;
      try {
        payload = encode_heartbeat_presence(peerId);
      } catch (e) {
        logger.warn("[presence] encode heartbeat failed:", e);
        return;
      }
      sendPresenceFrame(transport, payload).catch((e: unknown) =>
        logger.warn("[presence] send heartbeat failed:", e),
      );
    };
    send();
    const id = setInterval(send, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [peerId, transport]);

  return {
    /** Set the local cursor position (fire-and-forget). */
    setCursor,
    /** Set the local selection range (fire-and-forget). */
    setSelection,
    /** Set cell-level focus presence (no cursor position). */
    setFocus,
  };
}
