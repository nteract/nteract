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
export {
  readOnlyNotebookShellCapabilities,
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
  type NotebookShellRuntimeCapabilities,
} from "./capabilities";
export { NotebookDocumentShell, type NotebookDocumentShellProps } from "./NotebookDocumentShell";
export { NotebookDocumentHeader, type NotebookDocumentHeaderProps } from "./NotebookDocumentHeader";
export {
  NotebookNotice,
  NotebookNoticeAction,
  type NotebookNoticeActionProps,
  type NotebookNoticeProps,
  type NotebookNoticeTone,
} from "./NotebookNotice";
export {
  NotebookCommandToolbar,
  type NotebookCommandRuntimeState,
  type NotebookCommandToolbarProps,
  type NotebookCommandToolbarStatus,
  type NotebookCommandToolbarUpdateAction,
  type NotebookEnvironmentManager,
} from "./NotebookCommandToolbar";
export { NotebookToolbarFrame, type NotebookToolbarFrameProps } from "./NotebookToolbarFrame";
export {
  NotebookIdentityBadge,
  NotebookIdentityGroup,
  type NotebookIdentityBadgeProps,
  type NotebookIdentityGroupProps,
} from "./NotebookIdentity";
export { NotebookPresenceStatus, type NotebookPresenceStatusProps } from "./NotebookPresenceStatus";
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
export { NotebookDocumentRail, type NotebookDocumentRailProps } from "./NotebookDocumentRail";
export { NotebookReadOnlyView, type NotebookReadOnlyViewProps } from "./NotebookReadOnlyView";
export {
  navigateNotebookOutlineItem,
  type NavigateNotebookOutlineItemOptions,
} from "./outline-navigation";
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
