import { useNotebookHost } from "@nteract/notebook-host";
import { useCallback, useEffect } from "react";
import { sendPresenceFrame } from "runtimed";
import { logger } from "../lib/logger";
import {
  encode_cursor_presence,
  encode_focus_presence,
  encode_selection_presence,
} from "../wasm/runtimed-wasm/runtimed_wasm.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

function encodeCborText(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length < 24) {
    return new Uint8Array([0x60 + bytes.length, ...bytes]);
  }
  if (bytes.length <= 0xff) {
    return new Uint8Array([0x78, bytes.length, ...bytes]);
  }
  if (bytes.length <= 0xffff) {
    return new Uint8Array([0x79, bytes.length >> 8, bytes.length & 0xff, ...bytes]);
  }
  throw new Error("presence heartbeat peer_id is too long");
}

function encodeHeartbeatPresence(peerId: string): Uint8Array {
  const typeKey = encodeCborText("type");
  const typeValue = encodeCborText("heartbeat");
  const peerIdKey = encodeCborText("peer_id");
  const peerIdValue = encodeCborText(peerId);
  const payload = new Uint8Array(
    1 + typeKey.length + typeValue.length + peerIdKey.length + peerIdValue.length,
  );
  let offset = 0;
  payload[offset++] = 0xa2;
  payload.set(typeKey, offset);
  offset += typeKey.length;
  payload.set(typeValue, offset);
  offset += typeValue.length;
  payload.set(peerIdKey, offset);
  offset += peerIdKey.length;
  payload.set(peerIdValue, offset);
  return payload;
}

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

  useEffect(() => {
    if (!peerId) return;

    const sendHeartbeat = () => {
      if (!transport.connected) return;
      let payload: Uint8Array;
      try {
        payload = encodeHeartbeatPresence(peerId);
      } catch (e) {
        logger.warn("[presence] encode heartbeat failed:", e);
        return;
      }
      sendPresenceFrame(transport, payload).catch((e: unknown) =>
        logger.debug("[presence] send heartbeat failed:", e),
      );
    };

    sendHeartbeat();
    const interval = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [peerId, transport]);

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

  return {
    /** Set the local cursor position (fire-and-forget). */
    setCursor,
    /** Set the local selection range (fire-and-forget). */
    setSelection,
    /** Set cell-level focus presence (no cursor position). */
    setFocus,
  };
}
