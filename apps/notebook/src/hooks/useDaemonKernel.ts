/**
 * Hook for daemon-owned kernel execution.
 *
 * Thin React wrapper around transport-agnostic logic from the `runtimed`
 * package. State (kernel status, queue, env sync) is derived from the
 * daemon's RuntimeStateDoc. Broadcasts are only used for event callbacks.
 */

import { useNotebookHost } from "@nteract/notebook-host";
import { useCallback, useEffect, useRef } from "react";
import {
  type DaemonQueueState,
  type DependencyGuard,
  type ExecuteCellOptions,
  type GuardedNotebookProvenance,
  type KernelStatus,
  type NotebookClient,
  type NotebookResponse,
  statusKeyToLegacyStatus,
} from "runtimed";
import { refreshBlobPort, resetBlobPort } from "../lib/blob-port";
import { logger } from "../lib/logger";
import {
  getCellExecutionId,
  getCellIdForExecutionId,
} from "@/components/notebook/state/execution-store";
import { subscribeBroadcast } from "../lib/notebook-frame-bus";
import {
  diffExecutions,
  type ExecutionState,
  resetRuntimeState,
  runtimeStateStore,
  useRuntimeProjection,
  useRuntimeState,
  useThrottledStatusKey,
} from "../lib/runtime-state";
import { markExecutionPerformance } from "../lib/execution-performance";

// ── Hook types ──────────────────────────────────────────────────────

/** Re-export for backward compatibility */
export type DaemonKernelStatus = KernelStatus;
export type { DaemonQueueState } from "runtimed";

interface UseDaemonKernelOptions {
  /** NotebookClient for sending kernel commands via transport. */
  client: NotebookClient;
  /** Called when execution count is set for a cell */
  onExecutionCount: (cellId: string, count: number) => void;
  /** Called when execution completes for a cell */
  onExecutionDone: (cellId: string) => void;
  /** Called when kernel status changes */
  onStatusChange?: (status: KernelStatus, cellId?: string) => void;
  /** Called when queue state changes */
  onQueueChange?: (state: DaemonQueueState) => void;
}

export function useDaemonKernel({
  client,
  onExecutionCount,
  onExecutionDone,
  onStatusChange,
  onQueueChange,
}: UseDaemonKernelOptions) {
  const host = useNotebookHost();
  // ── State from RuntimeStateDoc (daemon-authoritative) ─────────────
  // Each projection is deduplicated in the shared store, so a daemon tick
  // that doesn't change the slice doesn't re-render this hook's host.
  const runtimeState = useRuntimeState();
  const kernelInfo = useRuntimeProjection(runtimeStateStore.kernelInfo$);
  const queueState = useRuntimeProjection(runtimeStateStore.queueState$);
  const envSyncState = useRuntimeProjection(runtimeStateStore.envSyncState$);

  // Status key with the busy flash suppressed — the shared
  // `throttleBusyStatus` pipeline holds RUNNING_BUSY back 60ms so quick
  // execute/idle cycles never flash "busy". Non-Running keys (starting
  // sub-phases, error, shutdown) pass through untouched.
  const statusKey = useThrottledStatusKey();
  const kernelStatus: KernelStatus = statusKeyToLegacyStatus(statusKey);

  // ── Callbacks in refs (avoid effect re-runs) ──────────────────────
  const callbacksRef = useRef({
    onExecutionCount,
    onExecutionDone,
    onStatusChange,
    onQueueChange,
  });
  callbacksRef.current = {
    onExecutionCount,
    onExecutionDone,
    onStatusChange,
    onQueueChange,
  };

  // ── Fire callbacks when derived state changes ─────────────────────
  const prevThrottledStatusRef = useRef(kernelStatus);
  useEffect(() => {
    const prev = prevThrottledStatusRef.current;
    prevThrottledStatusRef.current = kernelStatus;
    if (kernelStatus !== prev) {
      callbacksRef.current.onStatusChange?.(kernelStatus);
    }
  }, [kernelStatus]);

  const prevQueueRef = useRef(queueState);
  useEffect(() => {
    const prev = prevQueueRef.current;
    prevQueueRef.current = queueState;
    const executingChanged = prev.executing?.execution_id !== queueState.executing?.execution_id;
    let queuedChanged = prev.queued.length !== queueState.queued.length;
    if (!queuedChanged) {
      for (let i = 0; i < prev.queued.length; i++) {
        if (prev.queued[i]?.execution_id !== queueState.queued[i]?.execution_id) {
          queuedChanged = true;
          break;
        }
      }
    }
    if (executingChanged || queuedChanged) {
      const prevQueuedIds = new Set(prev.queued.map((entry) => entry.execution_id));
      for (const entry of queueState.queued) {
        if (!prevQueuedIds.has(entry.execution_id)) {
          markExecutionPerformance("runtime.queue.queued", {
            executionId: entry.execution_id,
            cellId: getCellIdForExecutionId(entry.execution_id) ?? undefined,
          });
        }
      }
      if (executingChanged && queueState.executing) {
        markExecutionPerformance("runtime.queue.executing", {
          executionId: queueState.executing.execution_id,
          cellId: getCellIdForExecutionId(queueState.executing.execution_id) ?? undefined,
        });
      }
      callbacksRef.current.onQueueChange?.(queueState);
    }
  }, [queueState]);

  // ── Execution lifecycle transitions (from CRDT) ───────────────────
  const prevExecutionsRef = useRef<Record<string, ExecutionState>>({});
  useEffect(() => {
    const prev = prevExecutionsRef.current;
    const curr = runtimeState.executions;
    prevExecutionsRef.current = curr;

    if (Object.keys(prev).length === 0 && Object.keys(curr).length > 0) {
      return;
    }

    const transitions = diffExecutions(prev, curr);
    for (const t of transitions) {
      const cellId = getCellIdForExecutionId(t.execution_id);
      if (!cellId) continue;
      if (t.kind === "started") {
        markExecutionPerformance("runtime.execution.started", {
          cellId,
          executionId: t.execution_id,
          executionCount: t.execution_count,
        });
        // Only forward when the kernel has actually reported the count
        // (arrives via execute_input, after the queued→running transition).
        // Materialization reads execution_count from RuntimeState directly,
        // so skipping null here avoids a brief flash of "0".
        if (t.execution_count != null && getCellExecutionId(cellId) === t.execution_id) {
          callbacksRef.current.onExecutionCount(cellId, t.execution_count);
        }
      } else {
        markExecutionPerformance(`runtime.execution.${t.kind}`, {
          cellId,
          executionId: t.execution_id,
          executionCount: t.execution_count,
        });
        callbacksRef.current.onExecutionDone(cellId);
      }
    }
  }, [runtimeState.executions]);

  // ── Broadcast listener (events only — no state) ──────────────────
  useEffect(() => {
    let cancelled = false;
    refreshBlobPort();

    // Custom comm messages (buttons, model.send()) are handled by the
    // SyncEngine.commBroadcasts$ subscriber in App.tsx. Env progress lives
    // in RuntimeStateDoc, not the broadcast channel. Anything else that
    // arrives here is unexpected.
    const unsubscribeBroadcast = subscribeBroadcast((payload) => {
      if (cancelled) return;

      if (
        typeof payload === "object" &&
        payload !== null &&
        "event" in payload &&
        typeof (payload as { event: unknown }).event === "string"
      ) {
        const event = (payload as { event: string }).event;
        if (event === "comm") return;
        logger.debug(`[daemon-kernel] Unknown broadcast event: ${event}`);
      }
    });

    const unlistenDisconnect = host.daemonEvents.onDisconnected(async () => {
      if (cancelled) return;
      logger.warn("[daemon-kernel] Daemon disconnected, resetting state");
      resetRuntimeState();
      resetBlobPort();
    });

    // Reconnect is owned by the host layer. When it succeeds, the host emits
    // daemon:ready and this hook refreshes the blob port for the new daemon.
    const unlistenReady = host.daemonEvents.onReadyLive(() => {
      if (cancelled) return;
      logger.debug("[daemon-kernel] Daemon ready");
      refreshBlobPort();
    });

    return () => {
      cancelled = true;
      unsubscribeBroadcast();
      unlistenDisconnect();
      unlistenReady();
    };
  }, [host]);

  // Comm state projection is now handled by SyncEngine.commChanges$
  // (subscribed in App.tsx). No Jupyter message synthesis needed.

  // ── Actions (via NotebookClient) ──────────────────────────────────

  const launchKernel = useCallback(
    (kernelType: string, envSource: string, notebookPath?: string) =>
      client.launchKernel(kernelType, envSource, notebookPath) as Promise<NotebookResponse>,
    [client],
  );

  const executeCell = useCallback(
    (cellId: string, options?: ExecuteCellOptions) =>
      client.executeCell(cellId, options) as Promise<NotebookResponse>,
    [client],
  );

  const executeCellGuarded = useCallback(
    (cellId: string, provenance: GuardedNotebookProvenance, options?: ExecuteCellOptions) =>
      client.executeCellGuarded(cellId, provenance, options) as Promise<NotebookResponse>,
    [client],
  );

  const interruptKernel = useCallback(
    () => client.interruptKernel() as Promise<NotebookResponse>,
    [client],
  );

  const shutdownKernel = useCallback(
    () => client.shutdownKernel() as Promise<NotebookResponse>,
    [client],
  );

  const syncEnvironment = useCallback(
    (guard?: DependencyGuard) => client.syncEnvironment(guard) as Promise<NotebookResponse>,
    [client],
  );

  const approveProjectEnvironment = useCallback(
    (projectFilePath?: string) =>
      client.approveProjectEnvironment(projectFilePath) as Promise<NotebookResponse>,
    [client],
  );

  const runAllCells = useCallback(
    () => client.runAllCells() as Promise<NotebookResponse>,
    [client],
  );

  const runAllCellsGuarded = useCallback(
    (provenance: GuardedNotebookProvenance) =>
      client.runAllCellsGuarded(provenance) as Promise<NotebookResponse>,
    [client],
  );

  const sendCommMessage = useCallback(
    (message: {
      header: Record<string, unknown>;
      parent_header?: Record<string, unknown> | null;
      metadata?: Record<string, unknown>;
      content: Record<string, unknown>;
      buffers?: ArrayBuffer[];
      channel?: string;
    }) => client.sendComm(message),
    [client],
  );

  return {
    kernelStatus,
    statusKey,
    lifecycle: runtimeState.kernel.lifecycle,
    errorReason: runtimeState.kernel.error_reason,
    errorDetails: runtimeState.kernel.error_details,
    queueState,
    kernelInfo,
    envSyncState,
    launchKernel,
    executeCell,
    executeCellGuarded,
    interruptKernel,
    shutdownKernel,
    syncEnvironment,
    approveProjectEnvironment,
    runAllCells,
    runAllCellsGuarded,
    sendCommMessage,
    isCellExecuting: (cellId: string) =>
      queueState.executing?.execution_id === getCellExecutionId(cellId),
    isCellQueued: (cellId: string) => {
      const executionId = getCellExecutionId(cellId);
      return (
        executionId !== null &&
        (queueState.executing?.execution_id === executionId ||
          queueState.queued.some((entry) => entry.execution_id === executionId))
      );
    },
  };
}
