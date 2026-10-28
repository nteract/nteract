/**
 * JSON-RPC methods and payloads for Bokeh document sessions.
 *
 * These are output-session extension methods: the host serves the iframe→host
 * requests only through the registered Bokeh output-session plugin, and sends
 * the host→iframe notifications with `IsolatedFrameHandle.notifyExtension`.
 */

// Iframe → Host (Requests)
export const NTERACT_BOKEH_SESSION_OPEN = "nteract/bokehSessionOpen" as const;
export const NTERACT_BOKEH_APPLY_PATCH = "nteract/bokehApplyPatch" as const;

/** Iframe→host requests served by the Bokeh output-session plugin. */
export const NTERACT_BOKEH_SESSION_HOST_METHODS = [
  NTERACT_BOKEH_SESSION_OPEN,
  NTERACT_BOKEH_APPLY_PATCH,
] as const;
export type NteractBokehSessionHostMethod = (typeof NTERACT_BOKEH_SESSION_HOST_METHODS)[number];

// Host → Iframe (Notifications)
export const NTERACT_BOKEH_SESSION_PATCH = "nteract/bokehSessionPatch" as const;
export const NTERACT_BOKEH_SESSION_STATE = "nteract/bokehSessionState" as const;

// ── Iframe → Host: Request Params & Results ─────────────────────────

export type NteractBokehSessionStatus = "connected" | "disconnected" | "closed" | "error";

export interface NteractBokehResolvedBuffer {
  id: string;
  data: ArrayBuffer;
}

export interface NteractBokehResolvedPatchPayload {
  patch: Record<string, unknown>;
  buffers: NteractBokehResolvedBuffer[];
}

export interface NteractBokehResolvedCheckpoint {
  revision: number;
  document: Record<string, unknown>;
  buffers: NteractBokehResolvedBuffer[];
}

export interface NteractBokehResolvedPatchEvent {
  sessionId: string;
  transactionId: string;
  baseRevision: number;
  revision: number;
  clientPatch?: NteractBokehResolvedPatchPayload;
  serverPatch?: NteractBokehResolvedPatchPayload;
  checkpoint?: NteractBokehResolvedCheckpoint;
}

export interface NteractBokehSessionOpenParams {
  sessionId: string;
  outputId: string;
}

export interface NteractBokehSessionSnapshot {
  schemaVersion: 1;
  sessionId: string;
  outputId: string;
  status: NteractBokehSessionStatus;
  headRevision: number;
  checkpoint: NteractBokehResolvedCheckpoint;
  patchTail: NteractBokehResolvedPatchEvent[];
}

export interface NteractBokehApplyPatchParams {
  sessionId: string;
  outputId: string;
  transactionId: string;
  baseRevision: number;
  patch: Record<string, unknown>;
  buffers: NteractBokehResolvedBuffer[];
}

export type NteractBokehApplyPatchResult =
  | {
      status: "accepted" | "stale";
      sessionId: string;
      transactionId: string;
      revision: number;
    }
  | {
      status: "error";
      sessionId: string;
      transactionId: string;
      revision?: number | null;
      error: string;
    };

// ── Host → Iframe: Notification Params ──────────────────────────────

export interface NteractBokehSessionPatchParams {
  outputId: string;
  event: NteractBokehResolvedPatchEvent;
}

export interface NteractBokehSessionStateParams {
  sessionId: string;
  outputId: string;
  status: NteractBokehSessionStatus;
  headRevision: number;
}
