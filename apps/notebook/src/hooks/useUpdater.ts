import { useNotebookHost } from "@nteract/notebook-host";
import type { HostUpdateStatus } from "@nteract/notebook-host";
import { useCallback, useSyncExternalStore } from "react";
import { logger } from "../lib/logger";

export type UpdateStatus = HostUpdateStatus;

export function useUpdater() {
  const host = useNotebookHost();
  const state = useSyncExternalStore(
    host.updater.subscribe,
    host.updater.getSnapshot,
    host.updater.getSnapshot,
  );

  const checkForUpdate = useCallback(async () => {
    try {
      await host.updater.check();
    } catch (e) {
      logger.warn("[updater] check failed:", e);
    }
  }, [host]);

  const restartToUpdate = useCallback(async () => {
    try {
      logger.info("[updater] opening upgrade screen");
      await host.updater.beginUpgrade();
    } catch (e) {
      logger.error("[updater] failed to open upgrade screen:", e);
    }
  }, [host]);

  return {
    ...state,
    checkForUpdate,
    restartToUpdate,
  };
}
