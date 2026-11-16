import { observeScopedChannelReviewCapability } from "./channel-review-capability";
/**
 * React context + hook for injecting the host platform.
 *
 * Wrap your root with `<NotebookHostProvider host={createTauriHost()}>` and
 * read the host anywhere in the tree with `useNotebookHost()`.
 *
 * Non-React callers (module-level helpers, sync stores) should accept a
 * host as a parameter rather than reaching for the context. That keeps
 * the dependency direction explicit.
 */

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { NotebookHost } from "./types";

const NotebookHostContext = createContext<NotebookHost | null>(null);

export interface NotebookHostProviderProps {
  host: NotebookHost;
  children: ReactNode;
}

export function NotebookHostProvider({ host, children }: NotebookHostProviderProps) {
  return <NotebookHostContext.Provider value={host}>{children}</NotebookHostContext.Provider>;
}

export function useNotebookHost(): NotebookHost {
  const host = useContext(NotebookHostContext);
  if (!host) {
    throw new Error("useNotebookHost() must be called inside <NotebookHostProvider>");
  }
  return host;
}

/** Opt-in is for a reviewed UI implementation, not a daemon permission grant. */
export function useScopedChannelReviewCapability(explicitUiOptIn = false): boolean {
  const host = useNotebookHost();
  const [snapshot, setSnapshot] = useState<{ host: NotebookHost; enabled: boolean } | null>(null);
  useEffect(
    () =>
      observeScopedChannelReviewCapability(host.daemonEvents, explicitUiOptIn, (enabled) =>
        setSnapshot({ host, enabled }),
      ),
    [host, explicitUiOptIn],
  );
  return explicitUiOptIn && snapshot?.host === host && snapshot.enabled;
}
