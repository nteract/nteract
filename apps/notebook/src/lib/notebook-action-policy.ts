import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type DependencyGuard,
  type EnvSyncState as RuntimeEnvSyncState,
  type GuardedNotebookProvenance,
  KERNEL_STATUS,
  type KernelStatus,
  type NotebookResponse,
} from "runtimed";
import { getNotebookCellsSnapshot as getDefaultNotebookCellsSnapshot } from "@/components/notebook/state/cell-store";
import { logger } from "./logger";
import { type PendingTrustAction } from "./trust-actions";

interface TrustGateInfo {
  status: string;
}

interface NotebookActionCellSnapshot {
  id: string;
  cell_type: string;
}

interface NotebookActionPolicyOptions {
  canExecute: boolean;
  sessionReady: boolean;
  kernelStatus: KernelStatus;
  envSource: string | null;
  envSyncState: RuntimeEnvSyncState | null;
  getObservedHeads: () => string[];
  getNotebookCellsSnapshot?: () => readonly NotebookActionCellSnapshot[];
  resetEnvProgress: () => void;
  flushSync: () => Promise<boolean>;
  checkTrust: () => Promise<TrustGateInfo | null>;
  approveTrust: (options?: { observedHeads?: string[] }) => Promise<boolean>;
  launchKernel: (kernelType: string, envSource: string) => Promise<NotebookResponse>;
  executeCell: (cellId: string) => Promise<NotebookResponse>;
  executeCellGuarded: (
    cellId: string,
    provenance: GuardedNotebookProvenance,
  ) => Promise<NotebookResponse>;
  shutdownKernel: () => Promise<NotebookResponse>;
  syncEnvironment: (guard?: DependencyGuard) => Promise<NotebookResponse>;
  approveProjectEnvironment: (projectFilePath?: string) => Promise<NotebookResponse>;
  runAllCells: () => Promise<NotebookResponse>;
  runAllCellsGuarded: (provenance: GuardedNotebookProvenance) => Promise<NotebookResponse>;
  getProjectEnvironmentFilePath: () => string | undefined;
  resetDismissedEnvBuildDetails: () => void;
  showEnvBuildDialog: () => void;
}

interface PendingTrustActionDialogCopy {
  approveLabel?: string;
  approveOnlyLabel: string;
  description?: string;
}

export function isTrustedForRuntimeAction(info: TrustGateInfo | null): boolean {
  return info?.status === "trusted" || info?.status === "no_dependencies";
}

export function shouldAttemptHotSyncDependencies(
  envSource: string | null,
  envSyncState: RuntimeEnvSyncState | null,
): boolean {
  const isUvInline = envSource === "uv:inline";
  const isCondaInline = envSource === "conda:inline";
  const hasOnlyAdditions =
    Boolean(envSyncState?.diff?.added?.length) && !envSyncState?.diff?.removed?.length;

  return (isUvInline || isCondaInline) && hasOnlyAdditions;
}

export function isLaunchErrorHandledByRuntimeBanner(error: string): boolean {
  return (
    error.includes("ipykernel not found in pixi.toml") ||
    error.includes("ipykernel not found in prepared ") ||
    error.includes("environment.yml declares conda env")
  );
}

export function getPendingTrustActionDialogCopy(
  action: PendingTrustAction | null,
): PendingTrustActionDialogCopy {
  return {
    approveLabel:
      action?.kind === "execute_cell"
        ? "Trust and Run Cell"
        : action?.kind === "run_all"
          ? "Trust and Run All"
          : action?.kind === "sync_deps"
            ? "Trust and Sync"
            : undefined,
    approveOnlyLabel: action?.kind === "sync_deps" ? "Trust Notebook" : "Trust & Start",
    description: action
      ? "This notebook wants to install packages. Approve them before running code."
      : undefined,
  };
}

function createNotebookProvenance(heads: readonly string[]): GuardedNotebookProvenance | null {
  if (heads.length === 0) return null;
  return { observed_heads: [...heads] };
}

function createSyncTrustAction(heads: readonly string[]): PendingTrustAction | null {
  const provenance = createNotebookProvenance(heads);
  if (!provenance) return null;
  return {
    kind: "sync_deps",
    provenance: {
      observed_heads: provenance.observed_heads,
    },
  };
}

function createRunAllTrustAction(heads: readonly string[]): PendingTrustAction | null {
  const provenance = createNotebookProvenance(heads);
  if (!provenance) return null;
  return {
    kind: "run_all",
    provenance,
  };
}

function createExecuteTrustAction({
  cellId,
  heads,
  cells,
}: {
  cellId: string;
  heads: readonly string[];
  cells: readonly NotebookActionCellSnapshot[];
}): PendingTrustAction | null {
  const cell = cells.find((candidate) => candidate.id === cellId);
  if (!cell || cell.cell_type !== "code") return null;
  const provenance = createNotebookProvenance(heads);
  if (!provenance) return null;
  return {
    kind: "execute_cell",
    cellId: cell.id,
    provenance,
  };
}

export function useNotebookActionPolicy({
  canExecute,
  sessionReady,
  kernelStatus,
  envSource,
  envSyncState,
  getObservedHeads,
  getNotebookCellsSnapshot = getDefaultNotebookCellsSnapshot,
  resetEnvProgress,
  flushSync,
  checkTrust,
  approveTrust,
  launchKernel,
  executeCell,
  executeCellGuarded,
  shutdownKernel,
  syncEnvironment,
  approveProjectEnvironment,
  runAllCells,
  runAllCellsGuarded,
  getProjectEnvironmentFilePath,
  resetDismissedEnvBuildDetails,
  showEnvBuildDialog,
}: NotebookActionPolicyOptions) {
  const [trustDialogOpen, setTrustDialogOpen] = useState(false);
  const [pendingTrustAction, setPendingTrustAction] = useState<PendingTrustAction | null>(null);
  const pendingTrustActionRef = useRef<PendingTrustAction | null>(null);
  const [trustActionNotice, setTrustActionNotice] = useState<string | null>(null);
  const [trustApprovalHandoffPending, setTrustApprovalHandoffPending] = useState(false);
  const [envBuildCreating, setEnvBuildCreating] = useState(false);
  const [justSynced, setJustSynced] = useState(false);
  const pendingKernelStartRef = useRef(false);
  const runAllInFlightRef = useRef(false);
  const executingCellsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!justSynced) return;
    const timer = setTimeout(() => setJustSynced(false), 3000);
    return () => clearTimeout(timer);
  }, [justSynced]);

  useEffect(() => {
    if (!trustApprovalHandoffPending) return;
    if (kernelStatus !== KERNEL_STATUS.AWAITING_TRUST && kernelStatus !== KERNEL_STATUS.NOT_STARTED) {
      setTrustApprovalHandoffPending(false);
      return;
    }

    const timeout = setTimeout(() => setTrustApprovalHandoffPending(false), 10_000);
    return () => clearTimeout(timeout);
  }, [kernelStatus, trustApprovalHandoffPending]);

  const setBlockedTrustAction = useCallback((action: PendingTrustAction | null) => {
    pendingTrustActionRef.current = action;
    setPendingTrustAction(action);
  }, []);

  const captureExecuteTrustAction = useCallback(
    (cellId: string): PendingTrustAction | null =>
      createExecuteTrustAction({
        cellId,
        heads: getObservedHeads(),
        cells: getNotebookCellsSnapshot(),
      }),
    [getNotebookCellsSnapshot, getObservedHeads],
  );

  const captureRunAllTrustAction = useCallback(
    (): PendingTrustAction | null => createRunAllTrustAction(getObservedHeads()),
    [getObservedHeads],
  );

  const captureSyncTrustAction = useCallback(
    (): PendingTrustAction | null => createSyncTrustAction(getObservedHeads()),
    [getObservedHeads],
  );

  const tryStartKernel = useCallback(
    async (blockedAction: PendingTrustAction | null = null): Promise<boolean> => {
      if (!canExecute) {
        logger.debug("[notebook-action-policy] tryStartKernel: execute unavailable, skipping");
        return false;
      }
      if (!sessionReady) {
        logger.debug("[notebook-action-policy] tryStartKernel: session not ready, skipping");
        return false;
      }

      const info = await checkTrust();
      if (!info) return false;

      if (isTrustedForRuntimeAction(info)) {
        setBlockedTrustAction(null);
        const response = await launchKernel("auto", "auto");
        if (response.result === "error") {
          logger.error("[notebook-action-policy] tryStartKernel: daemon error", response.error);
          return false;
        }
        if (response.result === "guard_rejected") {
          setTrustActionNotice(response.reason);
          return false;
        }
        resetEnvProgress();
        return true;
      }

      pendingKernelStartRef.current = true;
      setBlockedTrustAction(blockedAction);
      setTrustDialogOpen(true);
      return false;
    },
    [canExecute, checkTrust, launchKernel, resetEnvProgress, sessionReady, setBlockedTrustAction],
  );

  const performTrustedSyncDeps = useCallback(
    async (guard?: DependencyGuard): Promise<boolean> => {
      if (shouldAttemptHotSyncDependencies(envSource, envSyncState)) {
        logger.debug("[notebook-action-policy] Trying hot-sync for additions");
        const response = await syncEnvironment(guard);

        if (response.result === "sync_environment_complete") {
          logger.debug("[notebook-action-policy] Hot-sync succeeded:", response.synced_packages);
          resetEnvProgress();
          setJustSynced(true);
          return true;
        }

        if (response.result === "guard_rejected") {
          setTrustActionNotice(response.reason);
          resetEnvProgress();
          return false;
        }

        if (response.result === "sync_environment_failed" && !response.needs_restart) {
          logger.error("[notebook-action-policy] Hot-sync failed:", {
            error: response.error,
            envSource,
            packages: envSyncState?.diff?.added,
          });
          return false;
        }

        logger.debug("[notebook-action-policy] Hot-sync requires restart, falling back");
      }

      await shutdownKernel();
      const started = await tryStartKernel();
      if (started) {
        resetEnvProgress();
        setJustSynced(true);
      }
      return started;
    },
    [
      envSource,
      envSyncState,
      resetEnvProgress,
      shutdownKernel,
      syncEnvironment,
      tryStartKernel,
    ],
  );

  const handleSyncDeps = useCallback(async (): Promise<boolean> => {
    if (!sessionReady) {
      logger.debug("[notebook-action-policy] handleSyncDeps: session not ready, skipping");
      return false;
    }

    resetEnvProgress();

    if (!(await flushSync())) {
      logger.warn("[notebook-action-policy] handleSyncDeps: source sync failed, skipping");
      return false;
    }
    const blockedAction = captureSyncTrustAction();

    const info = await checkTrust();
    if (!info) return false;

    if (!isTrustedForRuntimeAction(info)) {
      pendingKernelStartRef.current = true;
      setBlockedTrustAction(blockedAction);
      setTrustDialogOpen(true);
      return false;
    }

    return performTrustedSyncDeps();
  }, [
    captureSyncTrustAction,
    checkTrust,
    flushSync,
    performTrustedSyncDeps,
    resetEnvProgress,
    sessionReady,
    setBlockedTrustAction,
  ]);

  const restartAndRunAll = useCallback(async () => {
    if (!sessionReady) {
      logger.debug("[notebook-action-policy] restartAndRunAll: session not ready, skipping");
      return;
    }
    if (runAllInFlightRef.current) {
      logger.debug("[notebook-action-policy] restartAndRunAll: already in flight, skipping");
      return;
    }
    runAllInFlightRef.current = true;
    try {
      if (!(await flushSync())) {
        logger.warn("[notebook-action-policy] restartAndRunAll: source sync failed, skipping");
        return;
      }

      await shutdownKernel();

      const kernelStarted = await tryStartKernel(captureRunAllTrustAction());
      if (!kernelStarted) {
        logger.debug("[notebook-action-policy] restartAndRunAll: kernel not started, skipping");
        return;
      }

      const response = await runAllCells();
      if (response.result === "error") {
        logger.error("[notebook-action-policy] restartAndRunAll: daemon error", response.error);
      } else if (response.result === "no_kernel") {
        logger.warn("[notebook-action-policy] restartAndRunAll: no kernel available");
      }
    } finally {
      runAllInFlightRef.current = false;
    }
  }, [captureRunAllTrustAction, flushSync, runAllCells, sessionReady, shutdownKernel, tryStartKernel]);

  const runTrustApprovedAction = useCallback(
    async (action: PendingTrustAction | null) => {
      if (!action) return;

      if (action.kind === "execute_cell") {
        const response = await executeCellGuarded(action.cellId, action.provenance);
        if (response.result === "guard_rejected") {
          setTrustApprovalHandoffPending(false);
          setTrustActionNotice(response.reason);
        } else if (response.result === "error") {
          logger.error(
            "[notebook-action-policy] guarded execute after trust approval failed:",
            response.error,
          );
          setTrustApprovalHandoffPending(false);
          setTrustActionNotice(response.error);
        } else if (response.result === "no_kernel") {
          setTrustApprovalHandoffPending(false);
          setTrustActionNotice("Kernel was not ready. Run the cell again when startup finishes.");
        }
        return;
      }

      if (action.kind === "sync_deps") {
        await performTrustedSyncDeps(action.provenance);
        return;
      }

      const response = await runAllCellsGuarded(action.provenance);
      if (response.result === "guard_rejected") {
        setTrustApprovalHandoffPending(false);
        setTrustActionNotice(response.reason);
      } else if (response.result === "error") {
        logger.error(
          "[notebook-action-policy] guarded Run All after trust approval failed:",
          response.error,
        );
        setTrustApprovalHandoffPending(false);
        setTrustActionNotice(response.error);
      } else if (response.result === "no_kernel") {
        setTrustApprovalHandoffPending(false);
        setTrustActionNotice("Kernel was not ready. Run all cells again when startup finishes.");
      }
    },
    [executeCellGuarded, performTrustedSyncDeps, runAllCellsGuarded],
  );

  const handleTrustApprovedLaunch = useCallback(
    async (action: PendingTrustAction | null) => {
      if (!sessionReady) {
        logger.debug(
          "[notebook-action-policy] handleTrustApprovedLaunch: session not ready, skipping",
        );
        return;
      }
      try {
        const response = await launchKernel("auto", "auto");
        if (response.result === "error") {
          logger.error(
            "[notebook-action-policy] kernel launch after trust approval failed:",
            response.error,
          );
          setTrustApprovalHandoffPending(false);
          if (!isLaunchErrorHandledByRuntimeBanner(response.error)) {
            setTrustActionNotice(response.error);
          }
          return;
        }
        if (response.result === "guard_rejected") {
          setTrustApprovalHandoffPending(false);
          setTrustActionNotice(response.reason);
          return;
        }
        await runTrustApprovedAction(action);
      } catch (e) {
        logger.error("[notebook-action-policy] kernel launch after trust approval failed:", e);
        setTrustApprovalHandoffPending(false);
        setTrustActionNotice(e instanceof Error ? e.message : String(e));
      }
    },
    [launchKernel, runTrustApprovedAction, sessionReady],
  );

  const handleTrustApprove = useCallback(async () => {
    const action = pendingTrustActionRef.current;
    const success = await approveTrust(
      action ? { observedHeads: action.provenance.observed_heads } : undefined,
    );
    if (success && pendingKernelStartRef.current) {
      pendingKernelStartRef.current = false;
      setTrustApprovalHandoffPending(true);
      setBlockedTrustAction(null);
      if (action?.kind === "sync_deps") {
        void runTrustApprovedAction(action);
      } else {
        void handleTrustApprovedLaunch(action);
      }
    }
    return success;
  }, [approveTrust, handleTrustApprovedLaunch, runTrustApprovedAction, setBlockedTrustAction]);

  const handleTrustApproveOnly = useCallback(async () => {
    const action = pendingTrustActionRef.current;
    const success = await approveTrust(
      action ? { observedHeads: action.provenance.observed_heads } : undefined,
    );
    if (success && pendingKernelStartRef.current) {
      pendingKernelStartRef.current = false;
      setTrustApprovalHandoffPending(true);
      setBlockedTrustAction(null);
      if (action?.kind !== "sync_deps") {
        void handleTrustApprovedLaunch(null);
      }
    }
    return success;
  }, [approveTrust, handleTrustApprovedLaunch, setBlockedTrustAction]);

  const handleTrustDecline = useCallback(() => {
    pendingKernelStartRef.current = false;
    setTrustApprovalHandoffPending(false);
    setBlockedTrustAction(null);
  }, [setBlockedTrustAction]);

  const handleTrustDialogOpenChange = useCallback(
    (open: boolean) => {
      setTrustDialogOpen(open);
      if (!open) {
        pendingKernelStartRef.current = false;
        setBlockedTrustAction(null);
      }
    },
    [setBlockedTrustAction],
  );

  const openTrustDialogForKernelStart = useCallback(() => {
    pendingKernelStartRef.current = true;
    setBlockedTrustAction(null);
    setTrustDialogOpen(true);
  }, [setBlockedTrustAction]);

  const handleEnvBuildCreate = useCallback(async () => {
    resetDismissedEnvBuildDetails();
    setEnvBuildCreating(true);
    try {
      const approval = await approveProjectEnvironment(getProjectEnvironmentFilePath());
      if (approval.result === "error") {
        logger.error("[notebook-action-policy] approveProjectEnvironment failed", approval.error);
        showEnvBuildDialog();
        return;
      }
      const started = await tryStartKernel();
      if (!started) {
        showEnvBuildDialog();
      }
    } finally {
      setEnvBuildCreating(false);
    }
  }, [
    approveProjectEnvironment,
    getProjectEnvironmentFilePath,
    resetDismissedEnvBuildDetails,
    showEnvBuildDialog,
    tryStartKernel,
  ]);

  const handleStartKernelWithPyproject = useCallback(async () => {
    if (!canExecute) {
      logger.debug(
        "[notebook-action-policy] handleStartKernelWithPyproject: execute unavailable, skipping",
      );
      return;
    }
    if (!sessionReady) {
      logger.debug(
        "[notebook-action-policy] handleStartKernelWithPyproject: session not ready, skipping",
      );
      return;
    }
    const response = await launchKernel("python", "uv:pyproject");
    if (response.result === "error") {
      logger.error(
        "[notebook-action-policy] handleStartKernelWithPyproject: daemon error",
        response.error,
      );
    } else if (response.result === "guard_rejected") {
      setTrustActionNotice(response.reason);
    }
  }, [canExecute, launchKernel, sessionReady]);

  const handleExecuteCell = useCallback(
    async (cellId: string) => {
      if (!canExecute) {
        logger.debug("[notebook-action-policy] handleExecuteCell: execute unavailable, skipping");
        return;
      }
      if (!sessionReady) {
        logger.debug("[notebook-action-policy] handleExecuteCell: session not ready, skipping");
        return;
      }

      const cell = getNotebookCellsSnapshot().find((candidate) => candidate.id === cellId);
      if (!cell || cell.cell_type !== "code") return;

      if (executingCellsRef.current.has(cellId)) {
        logger.debug("[notebook-action-policy] handleExecuteCell: already in flight for", cellId);
        return;
      }
      executingCellsRef.current.add(cellId);

      try {
        if (
          kernelStatus === KERNEL_STATUS.NOT_STARTED ||
          kernelStatus === KERNEL_STATUS.AWAITING_TRUST
        ) {
          const started = await tryStartKernel(captureExecuteTrustAction(cellId));
          if (!started && pendingKernelStartRef.current) return;
        }
        const response = await executeCell(cellId);
        if (response.result === "error") {
          logger.error("[notebook-action-policy] handleExecuteCell: daemon error", response.error);
        } else if (response.result === "no_kernel") {
          logger.warn("[notebook-action-policy] handleExecuteCell: no kernel, attempting restart");
          const restarted = await tryStartKernel();
          if (restarted) {
            const retry = await executeCell(cellId);
            if (retry.result === "error") {
              logger.error(
                "[notebook-action-policy] handleExecuteCell: daemon error after restart",
                retry.error,
              );
            } else if (retry.result === "no_kernel") {
              logger.error(
                "[notebook-action-policy] handleExecuteCell: still no kernel after restart",
              );
            }
          }
        }
      } finally {
        setTimeout(() => {
          executingCellsRef.current.delete(cellId);
        }, 150);
      }
    },
    [
      canExecute,
      captureExecuteTrustAction,
      executeCell,
      getNotebookCellsSnapshot,
      kernelStatus,
      sessionReady,
      tryStartKernel,
    ],
  );

  const handleStartKernel = useCallback(
    async (_name: string) => {
      await tryStartKernel();
    },
    [tryStartKernel],
  );

  const handleRestartKernel = useCallback(async () => {
    if (!canExecute) {
      logger.debug("[notebook-action-policy] handleRestartKernel: execute unavailable, skipping");
      return;
    }
    if (!sessionReady) {
      logger.debug("[notebook-action-policy] handleRestartKernel: session not ready, skipping");
      return;
    }
    await shutdownKernel();
    await tryStartKernel();
  }, [canExecute, sessionReady, shutdownKernel, tryStartKernel]);

  const handleRunAllCells = useCallback(async () => {
    if (!canExecute) {
      logger.debug("[notebook-action-policy] handleRunAllCells: execute unavailable, skipping");
      return;
    }
    if (!sessionReady) {
      logger.debug("[notebook-action-policy] handleRunAllCells: session not ready, skipping");
      return;
    }

    if (runAllInFlightRef.current) {
      logger.debug("[notebook-action-policy] handleRunAllCells: already in flight, skipping");
      return;
    }
    runAllInFlightRef.current = true;
    try {
      if (
        kernelStatus === KERNEL_STATUS.NOT_STARTED ||
        kernelStatus === KERNEL_STATUS.AWAITING_TRUST ||
        kernelStatus === KERNEL_STATUS.AWAITING_ENV_BUILD
      ) {
        if (kernelStatus === KERNEL_STATUS.AWAITING_ENV_BUILD) {
          showEnvBuildDialog();
          return;
        }
        const started = await tryStartKernel(captureRunAllTrustAction());
        if (!started) {
          logger.debug("[notebook-action-policy] handleRunAllCells: kernel not started, skipping");
          return;
        }
      }

      const response = await runAllCells();
      if (response.result === "error") {
        logger.error("[notebook-action-policy] handleRunAllCells: daemon error", response.error);
      } else if (response.result === "no_kernel") {
        logger.warn("[notebook-action-policy] handleRunAllCells: no kernel available");
      }
    } finally {
      runAllInFlightRef.current = false;
    }
  }, [
    canExecute,
    captureRunAllTrustAction,
    kernelStatus,
    runAllCells,
    sessionReady,
    showEnvBuildDialog,
    tryStartKernel,
  ]);

  const handleRestartAndRunAll = useCallback(async () => {
    if (!canExecute) {
      logger.debug(
        "[notebook-action-policy] handleRestartAndRunAll: execute unavailable, skipping",
      );
      return;
    }
    await restartAndRunAll();
  }, [canExecute, restartAndRunAll]);

  const trustDialogCopy = useMemo(
    () => getPendingTrustActionDialogCopy(pendingTrustAction),
    [pendingTrustAction],
  );

  return {
    envBuildCreating,
    handleEnvBuildCreate,
    handleExecuteCell,
    handleRestartAndRunAll,
    handleRestartKernel,
    handleRunAllCells,
    handleStartKernel,
    handleStartKernelWithPyproject,
    handleSyncDeps,
    handleTrustApprove,
    handleTrustApproveOnly,
    handleTrustDecline,
    handleTrustDialogOpenChange,
    hasPendingTrustAction: pendingTrustAction !== null,
    justSynced,
    openTrustDialogForKernelStart,
    pendingTrustAction,
    setTrustActionNotice,
    trustActionNotice,
    trustApprovalHandoffPending,
    trustApproveLabel: trustDialogCopy.approveLabel,
    trustApproveOnlyLabel: trustDialogCopy.approveOnlyLabel,
    trustDialogDescription: trustDialogCopy.description,
    trustDialogOpen,
    tryStartKernel,
  };
}
