import { createContext, useContext, type ReactNode } from "react";
import type {
  ApplyBokehSessionPatchOptions,
  BlobRef,
  BokehSessionDataTail,
  BokehSessionEvents,
  BokehSessionPatchReply,
  BokehSessionState,
} from "runtimed";
import type { BokehSessionDocStore } from "./bokeh-session-doc-store";

export interface BokehSessionTransport {
  /** Host replicas of the session documents, shared by every output frame. */
  docs: BokehSessionDocStore;
  fetchBlob(ref: BlobRef): Promise<Response>;
  /** One-off events (`MessageSent`, `ColumnsStreamed`, `ColumnsPatched`). */
  applyPatch(options: ApplyBokehSessionPatchOptions): Promise<BokehSessionPatchReply>;
  getData(sessionId: string, sourceIds?: string[]): Promise<BokehSessionDataTail>;
  subscribeEvents(listener: (events: BokehSessionEvents) => void): () => void;
}

export interface BokehSessionRuntime {
  sessions: Record<string, BokehSessionState>;
  transport: BokehSessionTransport | null;
}

const BokehSessionRuntimeContext = createContext<BokehSessionRuntime | null>(null);

export function BokehSessionRuntimeProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: BokehSessionRuntime;
}) {
  return (
    <BokehSessionRuntimeContext.Provider value={value}>
      {children}
    </BokehSessionRuntimeContext.Provider>
  );
}

export function useBokehSessionRuntime(): BokehSessionRuntime | null {
  return useContext(BokehSessionRuntimeContext);
}
