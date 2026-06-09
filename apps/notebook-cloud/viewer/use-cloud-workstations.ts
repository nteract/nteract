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
  cloudWorkstationRefreshIntervalMs,
  fetchCloudWorkstations,
  requestCloudWorkstationAttachment,
  setCloudDefaultWorkstation,
  type CloudWorkstationsState,
} from "./workstations-client";

interface CloudWorkstationMutationState {
  kind: "idle" | "default" | "attach";
  message: string | null;
  workstationId: string | null;
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

  const refreshCloudWorkstations = useCallback(
    async (signal?: AbortSignal) => {
      if (!canLoadCloudWorkstations || !config.workstationsEndpoint) {
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
      canLoadCloudWorkstations,
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
    async (workstationId: string) => {
      if (!config.workstationAttachEndpoint) {
        return;
      }
      setWorkstationMutation({
        kind: "attach",
        message: "Attach requested. Waiting for the workstation to join this room.",
        workstationId,
      });
      onOpenWorkstationsRail();
      try {
        await requestCloudWorkstationAttachment(
          config.workstationAttachEndpoint,
          authState,
          workstationId,
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

  const workstationRefreshIntervalMs = cloudWorkstationRefreshIntervalMs({
    canChooseHostedWorkstation: canChooseHostedWorkstation && canLoadCloudWorkstations,
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
  }, [handleAttachWorkstation, onOpenWorkstationsRail, workstationLaunchReadiness]);

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

  return useMemo(
    () => ({
      busyWorkstationId: workstationMutation.workstationId,
      onAttachWorkstation: canChooseHostedWorkstation ? handleAttachWorkstation : undefined,
      onSetDefaultWorkstation: canChooseHostedWorkstation ? handleSetDefaultWorkstation : undefined,
      workstationAction,
      workstationPanelStatusMessage,
      workstationSelection,
    }),
    [
      canChooseHostedWorkstation,
      handleAttachWorkstation,
      handleSetDefaultWorkstation,
      workstationAction,
      workstationMutation.workstationId,
      workstationPanelStatusMessage,
      workstationSelection,
    ],
  );
}
