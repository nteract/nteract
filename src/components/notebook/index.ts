export {
  friendlyNotebookActorLabel,
  friendlyNotebookOperatorLabel,
  parseNotebookActorLabel,
  parseNotebookOperatorLabel,
  splitNotebookActorPrincipalOperator,
  type ParsedNotebookActorKind,
  type ParsedNotebookActorLabel,
} from "./actor-labels";
export {
  notebookActorIdentityFromAccess,
  notebookActorIdentityFromProjection,
  notebookActorIdentityFromRuntime,
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromRuntime,
} from "./actor-projection";
export { CrdtBridgeProvider, useCrdtBridge } from "./crdt-bridge";
export {
  createCrdtBridge,
  remoteChangesFromTextAttributions,
  type CrdtBridge,
  type CrdtBridgeConfig,
  type CrdtSourceHandle,
  type RemoteChange,
  type TextAttributionLike,
} from "./crdt-editor-bridge";
export {
  notebookShellRuntimeTargetSummary,
  projectNotebookLaunchEnvironment,
  projectNotebookCommandRuntimeActions,
  projectNotebookCommandRuntimeStatus,
  projectNotebookCommandRuntimeStatusFromRuntimeState,
  projectNotebookShellCapabilities,
  projectNotebookWorkstationLaunchReadiness,
  projectNotebookWorkstationSelection,
  projectNotebookWorkstationSurface,
  readOnlyNotebookShellCapabilities,
  resolveNotebookShellRuntimeTarget,
  stabilizeNotebookShellCapabilities,
  type NotebookCommandRuntimeActionAvailability,
  type NotebookCommandRuntimeActionsProjection,
  type NotebookCommandRuntimeState,
  type NotebookCommandRuntimeStatusProjection,
  type NotebookLaunchEnvironmentOptionKind,
  type NotebookLaunchEnvironmentOptionProjection,
  type NotebookLaunchEnvironmentProjection,
  type NotebookLaunchEnvironmentSource,
  type NotebookLaunchKernelSpecProjection,
  type NotebookRegisteredWorkstation,
  type NotebookRegisteredWorkstationEnvironment,
  type NotebookRegisteredWorkstationProjection,
  type NotebookRegisteredWorkstationStatus,
  type NotebookActorIdentity,
  type NotebookActorKind,
  type NotebookActorOperator,
  type NotebookActorPrincipal,
  type NotebookActorProjection,
  type NotebookActorSourceProvider,
  type NotebookShellAccessCapabilities,
  type NotebookShellAccessLevel,
  type NotebookShellAccessSource,
  type NotebookShellAuthCapabilities,
  type NotebookShellCapabilities,
  type NotebookShellControlPolicy,
  type NotebookShellExecutionPolicy,
  type NotebookShellPackagePolicy,
  type NotebookShellRuntimeCapabilities,
  type NotebookShellRuntimeTargetKind,
  type NotebookShellRuntimeTargetProjection,
  type NotebookShellRuntimeTargetStatus,
  type NotebookShellSharingPolicy,
  type ProjectNotebookShellCapabilitiesOptions,
  projectNotebookWorkstationPanel,
  type NotebookWorkstationFactKind,
  type NotebookWorkstationFactProjection,
  type NotebookWorkstationEnvironmentPolicy,
  type NotebookWorkstationEnvironmentProjection,
  type NotebookWorkstationLaunchActionKind,
  type NotebookWorkstationLaunchActionProjection,
  type NotebookWorkstationLaunchReadinessProjection,
  type NotebookWorkstationLaunchReadinessState,
  type NotebookWorkstationPanelProjection,
  type NotebookWorkstationPanelTone,
  type NotebookWorkstationSelectionProjection,
  type NotebookWorkstationSelectionState,
  type NotebookWorkstationSurfaceMutationProjection,
  type NotebookWorkstationSurfaceProjection,
  type NotebookWorkstationToolbarActionProjection,
  type ProjectNotebookCommandRuntimeActionsOptions,
  type ProjectNotebookCommandRuntimeStatusOptions,
  type ProjectNotebookLaunchEnvironmentOptions,
  type ProjectNotebookWorkstationLaunchReadinessOptions,
  type ProjectNotebookWorkstationSelectionOptions,
  type ProjectNotebookWorkstationSurfaceOptions,
} from "./capabilities";
export {
  applyExecutionViewChangeset,
  applyOutputChangeset,
  getOutputProjectionFailures,
  resetRuntimeStoresProjection,
  resolveOutputProjectionSync,
  subscribeOutputProjectionFailures,
  useOutputProjectionFailures,
  type ApplyExecutionViewChangesetOptions,
  type ApplyOutputChangesetOptions,
} from "./state/runtime-store-projection";
export { NotebookDocumentShell, type NotebookDocumentShellProps } from "./NotebookDocumentShell";
export { NotebookDocumentHeader, type NotebookDocumentHeaderProps } from "./NotebookDocumentHeader";
export {
  NotebookNotice,
  NotebookNoticeAction,
  NotebookNoticeStack,
  type NotebookNoticeActionProps,
  type NotebookNoticeProps,
  type NotebookNoticeStackProps,
  type NotebookNoticeTone,
} from "./NotebookNotice";
export { RuntimeDecisionDialog, type RuntimeDecisionDialogProps } from "./RuntimeDecisionDialog";
export { TrustDialog, type TrustDialogProps } from "./TrustDialog";
export {
  EnvBuildDecisionDialog,
  extractCondaEnvCreateCommand,
  type EnvBuildDecisionDialogProps,
} from "./EnvBuildDecisionDialog";
export {
  DaemonStatusBanner,
  type DaemonStatus,
  type DaemonStatusBannerProps,
} from "./DaemonStatusBanner";
export { DebugBanner, type DebugBannerProps } from "./DebugBanner";
export {
  KernelLaunchErrorBanner,
  shouldShowKernelLaunchErrorBanner,
  type KernelLaunchErrorBannerProps,
} from "./KernelLaunchErrorBanner";
export {
  PoolErrorBanner,
  type PoolErrorBannerProps,
  type PoolErrorDetails,
} from "./PoolErrorBanner";
export { UntrustedBanner, type UntrustedBannerProps } from "./UntrustedBanner";
export type {
  EnvSyncState,
  PyProjectDeps,
  PyProjectInfo,
  TrustInfo,
  TyposquatWarning,
} from "./runtime-surface-types";
export {
  NotebookCommandToolbar,
  type NotebookCommandToolbarProps,
  type NotebookCommandToolbarStatus,
  type NotebookCommandToolbarUpdateAction,
  type NotebookCommandToolbarWorkstationAction,
  type NotebookEnvironmentManager,
} from "./NotebookCommandToolbar";
export {
  NotebookDocumentToolbar,
  shouldShowNotebookDocumentCommandToolbar,
  type NotebookDocumentToolbarProps,
} from "./NotebookDocumentToolbar";
export { NotebookToolbarFrame, type NotebookToolbarFrameProps } from "./NotebookToolbarFrame";
export {
  NotebookIdentityBadge,
  NotebookIdentityGroup,
  type NotebookIdentityBadgeProps,
  type NotebookIdentityGroupProps,
} from "./NotebookIdentity";
export { NotebookPresenceStatus, type NotebookPresenceStatusProps } from "./NotebookPresenceStatus";
export {
  NotebookConnectionIdentity,
  isRemoteNotebookContext,
  type NotebookConnectionIdentityProps,
  type NotebookConnectionStatusSource,
} from "./NotebookConnectionIdentity";
export {
  NotebookToolbarIdentity,
  notebookToolbarActors,
  type NotebookToolbarIdentityProps,
} from "./NotebookToolbarIdentity";
export {
  NotebookEnvironmentSummary,
  type NotebookEnvironmentSummaryProps,
} from "./NotebookEnvironmentSummary";
export {
  accessLevelLabel,
  accessSourceLabel,
  createNotebookEnvironmentSurface,
  type CreateNotebookEnvironmentSurfaceOptions,
  type NotebookEnvironmentSurface,
  type NotebookPackageSyncStatus,
  type NotebookRuntimeStatus,
  type NotebookTrustStatus,
} from "./environment-surface";
export {
  NotebookEditModeButton,
  type NotebookEditMode,
  type NotebookEditModeButtonProps,
  type NotebookEditModeState,
} from "./NotebookEditModeButton";
export { computeCanMutateCells } from "./mutation-gate";
export {
  createNotebookInteractionModeProjection,
  type CreateNotebookInteractionModeProjectionOptions,
  type NotebookInteractionHostSupport,
  type NotebookInteractionMode,
  type NotebookInteractionModeProjection,
  type NotebookInteractionPermission,
  type NotebookInteractionState,
} from "./interaction-mode";
export { NotebookCellList, type NotebookCellListProps } from "./NotebookCellList";
export {
  NotebookPackageSummaryPanel,
  type NotebookPackageSummaryPanelProps,
} from "./NotebookPackageSummaryPanel";
export {
  NotebookWorkstationsPanel,
  type NotebookWorkstationsPanelProps,
} from "./NotebookWorkstationsPanel";
export { NotebookDocumentRail, type NotebookDocumentRailProps } from "./NotebookDocumentRail";
export {
  NotebookCommentsPanel,
  type NotebookCommentDraftTarget,
  type NotebookCommentsPanelProps,
} from "./NotebookCommentsPanel";
export { NotebookReadOnlyView, type NotebookReadOnlyViewProps } from "./NotebookReadOnlyView";
export {
  PresenceValueProvider,
  usePresenceContext,
  usePresenceContextRequired,
  type PresenceContextValue,
} from "./presence-context";
export {
  navigateNotebookOutlineItem,
  type NavigateNotebookOutlineItemOptions,
} from "./outline-navigation";
export { useActiveOutlineItemId, useOutlineSelection } from "./outline-interaction";
export { useOutlineStatusLabel } from "./outline-status-label";
export {
  getCellById,
  getCellIdsSnapshot,
  getNotebookCellsSnapshot,
  replaceNotebookCells,
  resetNotebookCells,
  subscribeIds,
  updateCellById,
  updateCellSourceById,
  updateNotebookCells,
  useCell,
  useCellIds,
  useMaterializeVersion,
  useSourceVersion,
  type NotebookCellMetadata,
  type NotebookStoreCell,
  type NotebookStoreCodeCell,
  type NotebookStoreMarkdownCell,
  type NotebookStoreOutput,
  type NotebookStoreRawCell,
} from "./state/cell-store";
export {
  flushCellUIState,
  getActiveInteractionTarget,
  getFocusedCellId,
  setActiveInteractionTarget,
  setFocusedCellId,
  setSearchCurrentMatch,
  setSearchQuery,
  useCellQueuePriority,
  useActiveInteractionTarget,
  useFocusedCellId,
  useIsCellExecuting,
  useIsCellFocused,
  useIsCellQueued,
  useIsGroupExecuting,
  useIsNextCellFromFocused,
  useIsPreviousCellFromFocused,
  useNotebookCellUIStateBridge,
  useSearchActiveOffset,
  useSearchCurrentMatch,
  useSearchQuery,
  type NotebookCellUIStateBridgeInput,
  type NotebookFindMatch,
} from "./state/cell-ui-state";
export { createNotebookCellId, type NotebookCellIdRandomSource } from "./state/notebook-cell-id";
export {
  createNotebookController,
  type NotebookController,
  type NotebookControllerCellType,
  type NotebookControllerHandle,
  type NotebookControllerMutationKind,
  type NotebookControllerOptions,
  type NotebookControllerSyncMode,
} from "./state/notebook-controller";
export {
  deleteExecutions,
  getCellExecutionId,
  getCellIdForExecutionId,
  getExecutionById,
  getNotebookQueueProjection,
  isExecutionRuntimeOwned,
  markExecutionsRuntimeOwned,
  resetNotebookExecutions,
  setCellExecutionPointer,
  setExecution,
  setNotebookQueueProjection,
  useCellExecutionId,
  useExecution,
  useExecutionStructureVersion,
  useNotebookQueueProjection,
  type ExecutionSnapshot,
  type NotebookQueueProjectionSnapshot,
} from "./state/execution-store";
export {
  deleteOutput,
  deleteOutputs,
  getCellOutputsSnapshot,
  getOutputById,
  resetNotebookOutputs,
  setOutput,
  subscribeOutputsVersion,
  useCellOutputs,
  useOutput,
  useOutputStructureVersion,
  useOutputsVersion,
} from "./state/output-store";
export {
  closeNotebookRail,
  getNotebookRailUiState,
  openNotebookRailPanel,
  resetNotebookRailUiState,
  setActiveNotebookRailPanel,
  setNotebookRailCollapsed,
  setSelectedNotebookOutlineItemId,
  toggleNotebookRailPanel,
  useNotebookRailUiState,
  type NotebookRailUiState,
} from "./state/rail-ui-state";
export {
  createNotebookViewModelFromNotebookCells,
  notebookCellToViewCell,
  useNotebookViewModel,
} from "./state/view-model-store";
export {
  createNotebookViewStoreProjector,
  NotebookViewStoreProjector,
  type NotebookViewStoreProjectionCell,
  type NotebookViewStoreProjectorOptions,
  type ResetNotebookViewStoreProjectionOptions,
} from "./state/view-store-projection";
export {
  createNotebookViewModel,
  notebookViewCellsToOutlineItems,
  notebookViewCellsToReadOnlyCells,
  notebookViewCellToReadOnlyCell,
  notebookViewCellsToTracebackTargets,
  notebookOutlineItemsToMarkdownHeadingAnchors,
  type CreateNotebookViewModelOptions,
  type NotebookPackageManager,
  type NotebookPackageSection,
  type NotebookPackageViewModel,
  type NotebookViewModel,
  type NotebookViewCell,
  type NotebookViewCellType,
  type NotebookViewLanguageResolver,
  type NotebookTracebackCellTarget,
} from "./view-model";
