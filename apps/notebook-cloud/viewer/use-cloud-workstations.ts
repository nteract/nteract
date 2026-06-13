import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkstationAttachmentState } from "runtimed";

import {
  projectNotebookWorkstationLaunchReadiness,
  projectNotebookWorkstationSelection,
  type NotebookCommandToolbarWorkstationAction,
  type NotebookShellCapabilities,
} from "@/components/notebook";

import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudViewerConfig } from "./cloud-viewer-session";
import {
  CLOUD_WORKSTATION_PAIRING_POLL_INTERVAL_MS,
  cloudWorkstationConnectCommand,
  cloudWorkstationRefreshIntervalMs,
  fetchCloudWorkstationPairingStatus,
  fetchCloudWorkstations,
  mintCloudWorkstationPairingCode,
  requestCloudWorkstationAttachment,
  setCloudDefaultWorkstation,
  type CloudWorkstationPairingStatus,
  type CloudWorkstationsState,
} from "./workstations-client";

export interface CloudWorkstationPairing {
  id: string;
  code: string;
  connectCommand: string;
  expiresAt: string;
  status: CloudWorkstationPairingStatus;
  workstationId: string | null;
  workstationName: string | null;
  error: string | null;
}

interface CloudWorkstationMutationState {
  kind: "idle" | "default" | "attach";
  message: string | null;
  workstationId: string | null;
}

interface AttachWorkstationOptions {
  message?: string;
  replaceExisting?: boolean;
  revealPanel?: boolean;
}

interface UseCloudWorkstationManagerInput {
  config: Pick<
    CloudViewerConfig,
    "workstationsEndpoint" | "workstationDefaultEndpoint" | "workstationAttachEndpoint"
  >;
  authState: CloudPrototypeAuthState;
  capabilities: NotebookShellCapabilities;
  canLoadCloudWorkstations: boolean;
  workstationAttachment: WorkstationAttachmentState | null;
  panelIsOpen: boolean;
  onOpenWorkstationsRail: () => void;
}

export function useCloudWorkstationManager({
  config,
  authState,
  capabilities,
  canLoadCloudWorkstations,
  workstationAttachment,
  panelIsOpen,
  onOpenWorkstationsRail,
}: UseCloudWorkstationManagerInput) {
  const [workstationsState, setWorkstationsState] = useState<CloudWorkstationsState>({
    defaultWorkstationId: null,
    workstations: [],
  });
  const [workstationsError, setWorkstationsError] = useState<string | null>(null);
  const [workstationMutation, setWorkstationMutation] = useState<CloudWorkstationMutationState>({
    kind: "idle",
    message: null,
    workstationId: null,
  });

  const canChooseHostedWorkstation =
    capabilities.access.source === "cloud" &&
    capabilities.auth.canUseAuthenticatedIdentity &&
    capabilities.access.level === "owner";
  const canLoadHostedWorkstations = canLoadCloudWorkstations && canChooseHostedWorkstation;

  const refreshCloudWorkstations = useCallback(
    async (signal?: AbortSignal) => {
      if (!canLoadHostedWorkstations || !config.workstationsEndpoint) {
        if (!capabilities.auth.canUseAuthenticatedIdentity) {
          setWorkstationsState({ defaultWorkstationId: null, workstations: [] });
        }
        setWorkstationsError(null);
        return;
      }
      try {
        const next = await fetchCloudWorkstations(config.workstationsEndpoint, authState, signal);
        if (signal?.aborted) return;
        setWorkstationsState(next);
        setWorkstationsError(null);
      } catch (error) {
        if (signal?.aborted) return;
        setWorkstationsError(error instanceof Error ? error.message : String(error));
      }
    },
    [
      authState,
      canLoadHostedWorkstations,
      capabilities.auth.canUseAuthenticatedIdentity,
      config.workstationsEndpoint,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshCloudWorkstations(controller.signal);
    return () => controller.abort();
  }, [refreshCloudWorkstations]);

  const handleSetDefaultWorkstation = useCallback(
    async (workstationId: string) => {
      if (!config.workstationDefaultEndpoint) {
        return;
      }
      setWorkstationMutation({
        kind: "default",
        message: null,
        workstationId,
      });
      try {
        const defaultWorkstationId = await setCloudDefaultWorkstation(
          config.workstationDefaultEndpoint,
          authState,
          workstationId,
        );
        setWorkstationsState((previous) => ({
          ...previous,
          defaultWorkstationId: defaultWorkstationId ?? workstationId,
        }));
        setWorkstationsError(null);
        await refreshCloudWorkstations();
      } catch (error) {
        setWorkstationsError(error instanceof Error ? error.message : String(error));
      } finally {
        setWorkstationMutation({ kind: "idle", message: null, workstationId: null });
      }
    },
    [authState, config.workstationDefaultEndpoint, refreshCloudWorkstations],
  );

  const handleAttachWorkstation = useCallback(
    async (workstationId: string, options: AttachWorkstationOptions = {}) => {
      if (!config.workstationAttachEndpoint) {
        return;
      }
      setWorkstationMutation({
        kind: "attach",
        message:
          options.message ?? "Starting compute. Waiting for the workstation to join this notebook.",
        workstationId,
      });
      if (options.revealPanel) {
        onOpenWorkstationsRail();
      }
      try {
        await requestCloudWorkstationAttachment(
          config.workstationAttachEndpoint,
          authState,
          workstationId,
          { replaceExisting: options.replaceExisting === true },
        );
        setWorkstationsError(null);
        await refreshCloudWorkstations();
      } catch (error) {
        setWorkstationsError(error instanceof Error ? error.message : String(error));
        setWorkstationMutation({ kind: "idle", message: null, workstationId: null });
        await refreshCloudWorkstations();
      }
    },
    [authState, config.workstationAttachEndpoint, onOpenWorkstationsRail, refreshCloudWorkstations],
  );

  const [pairing, setPairing] = useState<CloudWorkstationPairing | null>(null);

  const handleStartPairing = useCallback(async () => {
    if (!config.workstationsEndpoint) {
      return;
    }
    try {
      const minted = await mintCloudWorkstationPairingCode(config.workstationsEndpoint, authState);
      setPairing({
        id: minted.id,
        code: minted.code,
        connectCommand: cloudWorkstationConnectCommand(window.location.origin, minted.code),
        expiresAt: minted.expiresAt,
        status: "pending",
        workstationId: null,
        workstationName: null,
        error: null,
      });
    } catch (error) {
      setPairing({
        id: "",
        code: "",
        connectCommand: "",
        expiresAt: new Date(0).toISOString(),
        status: "expired",
        workstationId: null,
        workstationName: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [authState, config.workstationsEndpoint]);

  const handleCancelPairing = useCallback(() => {
    setPairing(null);
  }, []);

  const pairingPollActive =
    pairing !== null &&
    pairing.id !== "" &&
    (pairing.status === "pending" || pairing.status === "redeemed");

  useEffect(() => {
    if (!pairingPollActive || !config.workstationsEndpoint) {
      return;
    }
    const endpoint = config.workstationsEndpoint;
    let disposed = false;
    let timer: number | null = null;
    let activeController: AbortController | null = null;
    const poll = () => {
      timer = window.setTimeout(() => {
        const controller = new AbortController();
        activeController = controller;
        const pairingId = pairing.id;
        void fetchCloudWorkstationPairingStatus(endpoint, authState, pairingId, controller.signal)
          .then((next) => {
            if (disposed || controller.signal.aborted) return;
            setPairing((previous) =>
              previous && previous.id === pairingId
                ? {
                    ...previous,
                    status: next.status,
                    workstationId: next.workstationId,
                    error: null,
                  }
                : previous,
            );
            if (next.status === "registered") {
              void refreshCloudWorkstations();
            }
          })
          .catch(() => {
            // Transient poll failures are invisible; the next tick retries.
          })
          .finally(() => {
            if (activeController === controller) {
              activeController = null;
            }
            if (!disposed) {
              poll();
            }
          });
      }, CLOUD_WORKSTATION_PAIRING_POLL_INTERVAL_MS);
    };
    poll();
    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      activeController?.abort();
    };
  }, [authState, config.workstationsEndpoint, pairing?.id, pairingPollActive]);

  // The expiry transition is client-driven so the card flips to "expired"
  // even if no poll lands exactly at the boundary.
  useEffect(() => {
    if (!pairing || pairing.status !== "pending") {
      return;
    }
    const remaining = Date.parse(pairing.expiresAt) - Date.now();
    if (!Number.isFinite(remaining)) {
      return;
    }
    if (remaining <= 0) {
      setPairing((previous) =>
        previous && previous.id === pairing.id ? { ...previous, status: "expired" } : previous,
      );
      return;
    }
    const timer = window.setTimeout(() => {
      setPairing((previous) =>
        previous && previous.id === pairing.id && previous.status === "pending"
          ? { ...previous, status: "expired" }
          : previous,
      );
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [pairing]);

  const pairingWithName = useMemo<CloudWorkstationPairing | null>(() => {
    if (!pairing) {
      return null;
    }
    if (!pairing.workstationId) {
      return pairing;
    }
    const registered = workstationsState.workstations.find(
      (workstation) => workstation.id === pairing.workstationId,
    );
    return registered ? { ...pairing, workstationName: registered.displayName } : pairing;
  }, [pairing, workstationsState.workstations]);

  const workstationRefreshIntervalMs = cloudWorkstationRefreshIntervalMs({
    canChooseHostedWorkstation: canLoadHostedWorkstations,
    hasRegisteredWorkstations: workstationsState.workstations.length > 0,
    mutationKind: workstationMutation.kind,
    panelIsOpen,
  });

  useEffect(() => {
    if (workstationRefreshIntervalMs === null) {
      return;
    }
    let disposed = false;
    let timer: number | null = null;
    let activeController: AbortController | null = null;
    const scheduleRefresh = () => {
      timer = window.setTimeout(() => {
        const controller = new AbortController();
        activeController = controller;
        void refreshCloudWorkstations(controller.signal).finally(() => {
          if (activeController === controller) {
            activeController = null;
          }
          if (!disposed) {
            scheduleRefresh();
          }
        });
      }, workstationRefreshIntervalMs);
    };
    scheduleRefresh();
    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      activeController?.abort();
    };
  }, [refreshCloudWorkstations, workstationRefreshIntervalMs]);

  const workstationSelection = useMemo(
    () =>
      projectNotebookWorkstationSelection({
        activeAttachment: workstationAttachment,
        canRegisterWorkstation: canChooseHostedWorkstation,
        canSelectWorkstation: canChooseHostedWorkstation,
        canSetDefaultWorkstation: canChooseHostedWorkstation,
        defaultWorkstationId: workstationsState.defaultWorkstationId,
        registeredWorkstations: workstationsState.workstations,
      }),
    [canChooseHostedWorkstation, workstationAttachment, workstationsState],
  );

  const workstationLaunchReadiness = useMemo(
    () =>
      projectNotebookWorkstationLaunchReadiness({
        capabilities,
        selection: workstationSelection,
      }),
    [capabilities, workstationSelection],
  );

  const workstationAction = useMemo<NotebookCommandToolbarWorkstationAction | null>(() => {
    const { primaryAction, workstationId } = workstationLaunchReadiness;
    if (workstationMutation.kind === "attach" && workstationMutation.workstationId) {
      const pendingTarget =
        workstationLaunchReadiness.workstationId === workstationMutation.workstationId
          ? workstationLaunchReadiness.targetLabel
          : null;
      return {
        disabled: true,
        label: "Starting",
        pending: true,
        title: pendingTarget
          ? `Starting compute on ${pendingTarget}`
          : "Starting compute on the selected workstation",
        onClick: () => {},
      };
    }
    return primaryAction.kind !== "none" && primaryAction.label && primaryAction.title
      ? {
          label: primaryAction.label,
          title: primaryAction.title,
          onClick:
            primaryAction.kind === "attach_workstation" && workstationId
              ? () => handleAttachWorkstation(workstationId)
              : onOpenWorkstationsRail,
        }
      : null;
  }, [
    handleAttachWorkstation,
    onOpenWorkstationsRail,
    workstationLaunchReadiness,
    workstationMutation.kind,
    workstationMutation.workstationId,
  ]);

  const workstationPanelStatusMessage =
    workstationMutation.message ??
    (!canLoadCloudWorkstations && canChooseHostedWorkstation
      ? "Preparing workstation access..."
      : null) ??
    workstationsError ??
    (workstationLaunchReadiness.state === "workstation_unavailable"
      ? workstationLaunchReadiness.detail
      : null);

  useEffect(() => {
    if (workstationMutation.kind !== "attach" || !workstationAttachment?.workstation_id) {
      return;
    }
    if (
      !workstationMutation.workstationId ||
      workstationMutation.workstationId === workstationAttachment.workstation_id
    ) {
      setWorkstationMutation({ kind: "idle", message: null, workstationId: null });
    }
  }, [workstationAttachment?.workstation_id, workstationMutation]);

  const startSelectedWorkstation = useCallback(
    async (options: Omit<AttachWorkstationOptions, "revealPanel"> = {}) => {
      const workstationId = workstationLaunchReadiness.workstationId;
      if (!workstationId) {
        onOpenWorkstationsRail();
        return;
      }
      await handleAttachWorkstation(workstationId, options);
    },
    [handleAttachWorkstation, onOpenWorkstationsRail, workstationLaunchReadiness.workstationId],
  );

  return useMemo(
    () => ({
      busyWorkstationId: workstationMutation.workstationId,
      onStartSelectedWorkstation: canChooseHostedWorkstation ? startSelectedWorkstation : undefined,
      onAttachWorkstation: canChooseHostedWorkstation
        ? (workstationId: string) => handleAttachWorkstation(workstationId, { revealPanel: true })
        : undefined,
      onSetDefaultWorkstation: canChooseHostedWorkstation ? handleSetDefaultWorkstation : undefined,
      onStartPairing: canChooseHostedWorkstation ? handleStartPairing : undefined,
      onCancelPairing: canChooseHostedWorkstation ? handleCancelPairing : undefined,
      workstationAction,
      workstationPairing: canChooseHostedWorkstation ? pairingWithName : null,
      workstationPanelStatusMessage,
      workstationSelection,
    }),
    [
      canChooseHostedWorkstation,
      handleAttachWorkstation,
      handleCancelPairing,
      handleSetDefaultWorkstation,
      handleStartPairing,
      startSelectedWorkstation,
      pairingWithName,
      workstationAction,
      workstationMutation.workstationId,
      workstationPanelStatusMessage,
      workstationSelection,
    ],
  );
}
