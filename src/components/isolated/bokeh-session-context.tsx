import { createContext, useContext, type ReactNode } from "react";
import type {
  ApplyBokehSessionPatchOptions,
  BlobRef,
  BokehSessionPatchBroadcast,
  BokehSessionPatchReply,
  BokehSessionState,
} from "runtimed";

export interface BokehSessionTransport {
  fetchBlob(ref: BlobRef): Promise<Response>;
  applyPatch(options: ApplyBokehSessionPatchOptions): Promise<BokehSessionPatchReply>;
  subscribePatches(listener: (broadcast: BokehSessionPatchBroadcast) => void): () => void;
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
