import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  CloudExecutionCommands,
  type CloudExecutionCommand,
  type CloudExecutionOutcome,
} from "./cloud-execution-commands";

export interface CloudRuntimeCommandClient {
  executeCell(cellId: string): Promise<unknown>;
  runAllCells(): Promise<unknown>;
  interruptKernel(): Promise<unknown>;
}

export interface CloudRuntimeCommandTarget {
  liveRuntime: { engine: { flushAndWait(): Promise<boolean> } };
  client: CloudRuntimeCommandClient;
}

export interface CloudStartWorkstationOptions {
  message?: string;
  replaceExisting?: boolean;
}

export interface UseCloudRuntimeCommandsInput {
  /** Build a room client bound to the current live connection, or null. */
  createClient: (action: string) => CloudRuntimeCommandTarget | null;
  /**
   * The live room runtime now (`liveRuntimeRef.current`). A command whose
   * runtime was disposed or replaced by the time a wait settles is dropped.
   */
  getCurrentRuntime: () => unknown;
  onStartSelectedWorkstation?: (options?: CloudStartWorkstationOptions) => Promise<boolean>;
  canRequestCellExecution: boolean;
  /**
   * Notebook room identity; a change (or unmount) cancels pending browser
   * continuations. A transport reconnect on the same live runtime keeps them:
   * the room is unchanged and re-authorizes the request when it arrives.
   */
  roomKey: string;
}

const LOG_PREFIX = "[notebook-cloud]";

function reportOutcome(action: string, outcome: CloudExecutionOutcome) {
  if (outcome === "sync_failed") {
    console.warn(`${LOG_PREFIX} ${action} request skipped; notebook sync failed`);
  } else if (outcome === "start_failed") {
    console.warn(`${LOG_PREFIX} ${action} request skipped; compute did not start`);
  } else if (outcome === "cancelled") {
    console.info(`${LOG_PREFIX} ${action} request cancelled before it reached the room`);
  }
}

/**
 * Toolbar and cell execution commands for the hosted viewer.
 *
 * Execution intent still goes to the room by synced `cell_id` after a document
 * flush, and the room still owns the queue. What this hook adds is ownership of
 * the browser-side wait before that request: Interrupt, Restart, a replaced
 * live runtime, a room change, and unmount cancel commands that have not reached
 * the room yet. Start deliberately does not cancel a Run waiting on compute.
 */
export function useCloudRuntimeCommands({
  createClient,
  getCurrentRuntime,
  onStartSelectedWorkstation,
  canRequestCellExecution,
  roomKey,
}: UseCloudRuntimeCommandsInput) {
  const commands = useMemo(() => new CloudExecutionCommands(), []);
  const startPromiseRef = useRef<Promise<boolean> | null>(null);
  const cancelPending = useCallback(() => {
    commands.cancelPending();
    // A later explicit Run issues its own start rather than joining one made
    // for cancelled intent. A repeat attach for the same workstation is
    // deduped by the server.
    startPromiseRef.current = null;
  }, [commands]);
  useEffect(() => cancelPending, [cancelPending, roomKey]);

  const submit = useCallback(
    (
      action: string,
      target: CloudRuntimeCommandTarget,
      steps: Pick<CloudExecutionCommand, "start" | "execute">,
    ) => {
      const liveRuntime = target.liveRuntime;
      void commands
        .submit({
          isCurrent: () => getCurrentRuntime() === liveRuntime,
          flush: () => liveRuntime.engine.flushAndWait(),
          ...steps,
        })
        .then((outcome) => reportOutcome(action, outcome))
        .catch((error: unknown) => {
          console.warn(`${LOG_PREFIX} ${action} request failed`, error);
        });
    },
    [commands, getCurrentRuntime],
  );

  const executeCell = useCallback(
    (cellId: string) => {
      const target = createClient("execute cell");
      if (!target) return;
      submit("execute cell", target, { execute: () => target.client.executeCell(cellId) });
    },
    [createClient, submit],
  );
  const startForExecution = useCallback(async () => {
    if (!onStartSelectedWorkstation) return false;
    if (!startPromiseRef.current) {
      const pending = onStartSelectedWorkstation({
        message: "Starting compute. Run is queued for the selected workstation.",
      }).finally(() => {
        // Only clear the slot this start still owns; a cancel may have
        // replaced it with a newer start.
        if (startPromiseRef.current === pending) startPromiseRef.current = null;
      });
      startPromiseRef.current = pending;
    }
    return startPromiseRef.current;
  }, [onStartSelectedWorkstation]);
  const requestExecuteCell = useCallback(
    (cellId: string) => {
      if (!canRequestCellExecution || !onStartSelectedWorkstation) return;
      const target = createClient("start compute and execute cell");
      if (!target) return;
      submit("start compute and execute", target, {
        start: startForExecution,
        execute: () => target.client.executeCell(cellId),
      });
    },
    [canRequestCellExecution, createClient, onStartSelectedWorkstation, startForExecution, submit],
  );
  const runAllCells = useCallback(() => {
    const target = createClient("run all cells");
    if (!target) return;
    submit("run all cells", target, { execute: () => target.client.runAllCells() });
  }, [createClient, submit]);
  const startRuntime = useCallback(() => {
    void onStartSelectedWorkstation?.().catch((error: unknown) => {
      console.warn(`${LOG_PREFIX} start kernel request failed`, error);
    });
  }, [onStartSelectedWorkstation]);
  const interruptRuntime = useCallback(() => {
    // Invalidate browser continuations synchronously, before Interrupt's own
    // request, so a sync or attach that settles later cannot send execution.
    cancelPending();
    const target = createClient("interrupt kernel");
    if (!target) return;
    void target.client.interruptKernel().catch((error: unknown) => {
      console.warn(`${LOG_PREFIX} interrupt kernel request failed`, error);
    });
  }, [cancelPending, createClient]);
  const restartRuntime = useCallback(() => {
    cancelPending();
    void onStartSelectedWorkstation?.({
      message: "Restarting compute. Waiting for the workstation to replace the runtime peer.",
      replaceExisting: true,
    }).catch((error: unknown) => {
      console.warn(`${LOG_PREFIX} restart kernel request failed`, error);
    });
  }, [cancelPending, onStartSelectedWorkstation]);
  const restartAndRunAll = useCallback(() => {
    // Interrupt while the flush is pending drops the whole command, restart
    // included; Interrupt while the attach is pending keeps the already-issued
    // restart and drops only run all. Either way no cells run later.
    cancelPending();
    const target = createClient("restart kernel and run all cells");
    if (!target) return;
    submit("restart kernel and run all cells", target, {
      start: async () =>
        (await onStartSelectedWorkstation?.({
          message: "Restarting compute. Run all is queued for the replacement runtime.",
          replaceExisting: true,
        })) ?? false,
      execute: () => target.client.runAllCells(),
    });
  }, [cancelPending, createClient, onStartSelectedWorkstation, submit]);

  return {
    executeCell,
    requestExecuteCell,
    runAllCells,
    startRuntime,
    interruptRuntime,
    restartRuntime,
    restartAndRunAll,
  };
}
