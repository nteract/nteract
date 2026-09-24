import { type NotebookHost, useNotebookHost } from "@nteract/notebook-host";
import { useEffect, useState } from "react";
import { logger } from "../lib/logger";

/** Local display label only; the notebook connection owns actor identity. */
export function useHostUsername(): string {
  const host = useNotebookHost();
  const [resolved, setResolved] = useState<{ host: NotebookHost; username: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const username = await host.system.getUsername();
        if (!cancelled) setResolved({ host, username: username.trim() });
      } catch (error) {
        if (!cancelled) logger.warn("Failed to get username:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host]);

  // A replacement host must not display a previous host's user while loading.
  return resolved?.host === host ? resolved.username : "";
}
