import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";
import type { NotebookInteractionTarget } from "runtimed";
import {
  PresenceValueProvider,
  type PresenceContextValue,
} from "@/components/notebook/presence-context";
import { usePresence } from "../hooks/usePresence";

export {
  PresenceValueProvider,
  usePresenceContext,
  usePresenceContextRequired,
  type PresenceContextValue,
} from "@/components/notebook/presence-context";

interface PresenceProviderProps {
  peerId: string;
  peerLabel?: string;
  actorLabel?: string;
  children: ReactNode;
}

export function PresenceProvider({
  peerId,
  peerLabel = "",
  actorLabel = "",
  children,
}: PresenceProviderProps) {
  const presence = usePresence(peerId, peerLabel, actorLabel);

  const setCursor = useCallback(
    (cellId: string, line: number, column: number) => {
      presence.setCursor(cellId, line, column);
    },
    [presence],
  );

  const setSelection = useCallback(
    (cellId: string, anchorLine: number, anchorCol: number, headLine: number, headCol: number) => {
      presence.setSelection(cellId, anchorLine, anchorCol, headLine, headCol);
    },
    [presence],
  );

  const setFocus = useCallback(
    (cellId: string) => {
      presence.setFocus(cellId);
    },
    [presence],
  );

  const setInteraction = useCallback(
    (target: NotebookInteractionTarget) => {
      presence.setInteraction(target);
    },
    [presence],
  );

  const value = useMemo<PresenceContextValue>(
    () => ({
      setCursor,
      setSelection,
      setFocus,
      setInteraction,
      peerId,
    }),
    [setCursor, setSelection, setFocus, setInteraction, peerId],
  );

  return <PresenceValueProvider value={value}>{children}</PresenceValueProvider>;
}
