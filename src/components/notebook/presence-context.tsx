import { createContext, type ReactNode, useContext } from "react";
import type { NotebookInteractionTarget } from "runtimed";

export interface PresenceContextValue {
  /** Send cursor position for a cell */
  setCursor: (cellId: string, line: number, column: number) => void;
  /** Send selection range for a cell */
  setSelection: (
    cellId: string,
    anchorLine: number,
    anchorCol: number,
    headLine: number,
    headCol: number,
  ) => void;
  /** Send cell-level focus (no cursor position) */
  setFocus: (cellId: string) => void;
  /** Send active notebook interaction target */
  setInteraction: (target: NotebookInteractionTarget) => void;
  /** The local peer's ID */
  peerId: string | null;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

export function PresenceValueProvider({
  value,
  children,
}: {
  value: PresenceContextValue | null;
  children: ReactNode;
}) {
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

/**
 * Hook to access presence context.
 * Returns null if used outside a PresenceProvider.
 */
export function usePresenceContext(): PresenceContextValue | null {
  return useContext(PresenceContext);
}

/**
 * Hook that throws if presence context is not available.
 * Use this when you need presence and it's an error if it's missing.
 */
export function usePresenceContextRequired(): PresenceContextValue {
  const ctx = useContext(PresenceContext);
  if (!ctx) {
    throw new Error("usePresenceContextRequired must be used within a PresenceProvider");
  }
  return ctx;
}
