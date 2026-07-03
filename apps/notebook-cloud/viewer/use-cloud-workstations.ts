import { useCallback, useMemo } from "react";
import type { WorkstationAttachmentState } from "runtimed";

import {
  projectNotebookWorkstationSurface,
  type NotebookCommandToolbarWorkstationAction,
  type NotebookShellCapabilities,
} from "@/components/notebook";

import type { CloudPrototypeAuthState } from "./collaborator-auth";
import type { CloudViewerConfig } from "./cloud-viewer-session";
import { cloudWorkstationsStore } from "./cloud-workstations-store";
import {
  useCloudWorkstationMutation,
  useCloudWorkstationPairing,
  useCloudWorkstationsController,
  useCloudWorkstationsError,
  useCloudWorkstationsRegistry,
} from "./use-cloud-workstations-store";

export type { CloudWorkstationPairing } from "./cloud-workstations-store";

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
  const canChooseHostedWorkstation =
    capabilities.access.source === "cloud" &&
    capabilities.auth.canUseAuthenticatedIdentity &&
    capabilities.access.level === "owner";
  const canLoadHostedWorkstations = canLoadCloudWorkstations && canChooseHostedWorkstation;

  // The store owns the registry poll, mutations, and pairing lifecycle. The rail
  // wipes the registry only on lost authenticated identity - a transient loss of
  // hosted eligibility keeps the last-good registry.
  useCloudWorkstationsController({
    auth: authState,
    workstationsEndpoint: config.workstationsEndpoint,
    defaultEndpoint: config.workstationDefaultEndpoint,
    attachEndpoint: config.workstationAttachEndpoint,
    canFetch: canLoadHostedWorkstations,
    panelIsOpen,
    closedGate: {
      status: capabilities.auth.canUseAuthenticatedIdentity ? "loading" : "signed_out",
      wipeRegistry: !capabilities.auth.canUseAuthenticatedIdentity,
    },
  });

  const registry = useCloudWorkstationsRegistry();
  const workstationMutation = useCloudWorkstationMutation();
  const workstationsError = useCloudWorkstationsError();
  const pairingWithName = useCloudWorkstationPairing();

  const handleSetDefaultWorkstation = useCallback(
    (workstationId: string) => cloudWorkstationsStore.setDefault(workstationId),
    [],
  );

  const handleAttachWorkstation = useCallback(
    (workstationId: string, options: AttachWorkstationOptions = {}): Promise<boolean> => {
      if (!config.workstationAttachEndpoint) {
        return Promise.resolve(false);
      }
      if (options.revealPanel) {
        onOpenWorkstationsRail();
      }
      return cloudWorkstationsStore.attach(workstationId, {
        message: options.message,
        replaceExisting: options.replaceExisting,
      });
    },
    [config.workstationAttachEndpoint, onOpenWorkstationsRail],
  );

  const handleStartPairing = useCallback(() => cloudWorkstationsStore.startPairing(), []);
  const handleCancelPairing = useCallback(() => cloudWorkstationsStore.cancelPairing(), []);

  const workstationSurface = useMemo(
    () =>
      projectNotebookWorkstationSurface({
        activeAttachment: workstationAttachment,
        capabilities,
        canRegisterWorkstation: canChooseHostedWorkstation,
        canSelectWorkstation: canChooseHostedWorkstation,
        canSetDefaultWorkstation: canChooseHostedWorkstation,
        canStartWorkstation: canChooseHostedWorkstation,
        defaultWorkstationId: registry.defaultWorkstationId,
        loadingMessage:
          !canLoadCloudWorkstations && canChooseHostedWorkstation
            ? "Preparing workstation access..."
            : null,
        mutation: workstationMutation,
        registeredWorkstations: registry.workstations,
        registryError: workstationsError,
      }),
    [
      canChooseHostedWorkstation,
      canLoadCloudWorkstations,
      capabilities,
      registry,
      workstationAttachment,
      workstationMutation,
      workstationsError,
    ],
  );
  const workstationSelection = workstationSurface.selection;
  const workstationLaunchReadiness = workstationSurface.launchReadiness;
  const workstationPanelStatusMessage = workstationSurface.panelStatusMessage;
  const canStartSelectedWorkstation = workstationSurface.canStartSelectedWorkstation;

  const workstationAction = useMemo<NotebookCommandToolbarWorkstationAction | null>(() => {
    const action = workstationSurface.toolbarAction;
    if (!action) return null;
    if (action.disabled || action.kind !== "attach_workstation" || !action.workstationId) {
      return {
        disabled: action.disabled,
        label: action.label,
        pending: action.pending,
        title: action.title,
        onClick: onOpenWorkstationsRail,
      };
    }
    const workstationId = action.workstationId;
    return {
      disabled: action.disabled,
      label: action.label,
      pending: action.pending,
      title: action.title,
      onClick: () => handleAttachWorkstation(workstationId),
    };
  }, [handleAttachWorkstation, onOpenWorkstationsRail, workstationSurface.toolbarAction]);

  const startSelectedWorkstation = useCallback(
    async (options: Omit<AttachWorkstationOptions, "revealPanel"> = {}) => {
      const workstationId = workstationLaunchReadiness.workstationId;
      if (!workstationId) {
        onOpenWorkstationsRail();
        return false;
      }
      return handleAttachWorkstation(workstationId, options);
    },
    [handleAttachWorkstation, onOpenWorkstationsRail, workstationLaunchReadiness.workstationId],
  );
  return useMemo(
    () => ({
      busyWorkstationId: workstationSurface.busyWorkstationId,
      canStartSelectedWorkstation,
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
      canStartSelectedWorkstation,
      canChooseHostedWorkstation,
      handleAttachWorkstation,
      handleCancelPairing,
      handleSetDefaultWorkstation,
      handleStartPairing,
      startSelectedWorkstation,
      pairingWithName,
      workstationSurface.busyWorkstationId,
      workstationAction,
      workstationPanelStatusMessage,
      workstationSelection,
    ],
  );
}
