/**
 * runtimed — transport-agnostic notebook client library.
 *
 * Sync with the runtimed daemon from any JS runtime (Tauri, browser,
 * Node, Deno) without framework-specific dependencies.
 */

// Core
export { SyncEngine } from "./sync-engine";
export type { PresenceHeartbeatOptions, SyncEngineOptions, SyncEngineLogger } from "./sync-engine";

// Transport
export type {
  ConnectionStatus,
  FrameListener,
  NotebookRequestOptions,
  NotebookTransport,
} from "./transport";
export {
  FrameType,
  MAX_CONTROL_FRAME_SIZE,
  MAX_FRAME_SIZE,
  frameSizeLimits,
  sendAutomergeSyncFrame,
  sendPresenceFrame,
  type FrameSizeLimits,
  type FrameTypeValue,
} from "./transport";

// Protocol contract
export {
  DISPLAY_CAPABLE_JUPYTER_OUTPUT_TYPES,
  INITIAL_LOAD_PHASES,
  NOTEBOOK_DOC_PHASES,
  NOTEBOOK_REQUEST_TYPES,
  NOTEBOOK_RESPONSE_RESULTS,
  RUNTIME_STATE_PHASES,
  SESSION_CONTROL_TYPES,
  isDisplayCapableJupyterOutput,
  isDisplayCapableJupyterOutputType,
  isInitialLoadFailed,
  isInitialLoadStreaming,
  type DisplayCapableJupyterOutput,
  type DisplayCapableJupyterOutputType,
  type SessionControlMessage,
} from "./protocol-contract";

// Reactive runtime-state store (framework-agnostic RxJS projections)
export { BUSY_THROTTLE_MS, RuntimeStateStore, throttleBusyStatus } from "./runtime-state-store";

// Local-first persistence: the NotebookDoc seed record plus the render-only
// RuntimeStateDoc paint cache (see notebookDocChanged$ and the key-segment
// docs in notebook-doc-persistence.ts)
export {
  IndexedDbStorageAdapter,
  type IndexedDbStorageAdapterOptions,
} from "./persistence/indexeddb-storage-adapter";
export {
  NOTEBOOK_DOC_CHUNKS_KEY_SEGMENT,
  NOTEBOOK_DOC_SNAPSHOT_KEY_SEGMENT,
  NotebookDocPersistence,
  RUNTIME_STATE_CACHE_KEY_SEGMENT,
  clearPersistedNotebookDoc,
  clearPersistedNotebookDocChunks,
  clearPersistedNotebookRecord,
  decodeNotebookDocChunkMeta,
  decodePersistedNotebookDoc,
  encodeNotebookDocChunkMeta,
  encodePersistedNotebookDoc,
  loadAllPersistedNotebookDocChunkStores,
  loadPersistedNotebookDoc,
  loadPersistedNotebookDocChunks,
  loadPersistedNotebookRecord,
  notebookDocChunkMetaKey,
  notebookDocChunksPrefix,
  notebookDocIncrementalChunkKey,
  notebookDocPrincipalChunksPrefix,
  notebookDocSnapshotChunkKey,
  type NotebookDocChunkInfo,
  type NotebookDocChunkedOptions,
  type NotebookDocPersistenceLogger,
  type NotebookDocPersistenceMeta,
  type NotebookDocPersistenceOptions,
  type PersistedNotebookDoc,
  type PersistedNotebookDocChunkStore,
  type PersistedNotebookDocChunks,
} from "./persistence/notebook-doc-persistence";
export {
  SaveBatchEntryError,
  saveBatch,
  type StorageAdapter,
  type StorageChunk,
  type StorageKey,
} from "./persistence/storage-adapter";

// Cross-tab convergence bridge (BroadcastChannel; same notebook, same
// principal — see notebook-tab-bridge.ts)
export {
  NOTEBOOK_TAB_BRIDGE_CHANNEL_PREFIX,
  NOTEBOOK_TAB_BRIDGE_MESSAGE_VERSION,
  NotebookTabBridge,
  createNotebookTabBridge,
  notebookTabBridgeChannelName,
  type NotebookTabBridgeChangesMessage,
  type NotebookTabBridgeChannel,
  type NotebookTabBridgeLogger,
  type NotebookTabBridgeOptions,
} from "./notebook-tab-bridge";

// Scope capabilities (generated from nteract_identity::ConnectionScope)
export {
  CONNECTION_SCOPES,
  allowsAclMutation,
  allowsBlobUpload,
  allowsExecutionRequestSubmit,
  allowsNotebookWrite,
  allowsPublish,
  allowsRuntimeStateWrite,
  isConnectionScope,
  parseConnectionScope,
  type ConnectionScope,
} from "./scope-capabilities";

// Handle
export type {
  CommentAnchor,
  CommentMessageSnapshot,
  CommentMutationState,
  CommentsProjection,
  CommentThreadSnapshot,
  CommentThreadStatus,
  ExecutionQueueProjection,
  ExecutionViewChangeset,
  ExecutionViewSnapshot,
  SyncableHandle,
  FrameEvent,
  LocalMutationResult,
  InitialLoadPhase,
  NotebookDocPhase,
  RuntimeStatePhase,
  SessionStatus,
  TextAttribution,
} from "./handle";

// Notebook handle host
export {
  NotebookHandleHost,
  type HostedNotebookHandle,
  type NotebookHandleHostOptions,
  type NotebookHandleSlot,
} from "./notebook-handle-host";

// Text attribution events
export {
  createTextAttributionEvent,
  isTextAttributionEvent,
  TEXT_ATTRIBUTION_EVENT_TYPE,
  type TextAttributionEvent,
} from "./text-attribution-event";

// Cell changeset
export {
  classifyCellChangesetMaterialization,
  cellChangesetTouchesChrome,
  type CellPointerRefreshPlan,
  type CellChangeset,
  type CellChangesetMaterialization,
  type CellChangesetProjectionPlan,
  type ChangedCell,
  type ChangedFields,
  type IncrementalCellProjection,
  type StructuralCellProjection,
  mergeChangesets,
  planCellPointerRefresh,
  planCellChangesetProjection,
  summarizeChangedFields,
} from "./cell-changeset";

// Runtime state
export {
  type CommDocEntry,
  DEFAULT_RUNTIME_STATE,
  type EnvState,
  type EnvProgressEnvType,
  type EnvProgressEvent,
  type EnvProgressPhase,
  type ExecutionState,
  type ExecutionTransition,
  KERNEL_ERROR_REASON,
  type KernelActivity,
  type KernelErrorReasonKey,
  type KernelState,
  type ProjectContext,
  type ProjectFile,
  type ProjectFileExtras,
  type ProjectFileKind,
  type ProjectFileParsed,
  type QueueEntry,
  type QueueState,
  type RuntimeLifecycle,
  type RuntimeState,
  type TrustState,
  type TrustStatus,
  type WorkstationAttachmentState,
  diffExecutions,
} from "./runtime-state";

// Pool state
export { type PoolState, type RuntimePoolState, DEFAULT_POOL_STATE } from "./pool-state";

// Broadcast types
export { type CommBroadcast, isCommBroadcast, type KnownBroadcast } from "./broadcast-types";

// Env progress projection
export {
  EMPTY_ENV_PROGRESS,
  envProgressKey,
  type EnvProgressState,
  getEnvProgressStatusText,
  projectEnvProgress,
} from "./env-progress";

// Notebook outline projection
export {
  buildNotebookOutlineTree,
  deriveNotebookOutlineItems,
  notebookCellAnchorHref,
  notebookCellAnchorId,
  notebookHeadingAnchorHref,
  notebookHeadingAnchorId,
  notebookOutlineItemHref,
  notebookOutputAnchorId,
  projectNotebookOutline,
  resolveNotebookOutlineContextItemId,
  resolveNotebookOutlineSelection,
  slugifyNotebookHeading,
  type NotebookOutlineHrefTarget,
  type NotebookOutlineItem,
  type NotebookOutlineItemKind,
  type NotebookOutlineImagePreview,
  type NotebookOutlineMarkdownAnchor,
  type NotebookOutlineMarkdownProjection,
  type NotebookOutlineMarkdownRun,
  type NotebookOutlineProjection,
  type NotebookOutlineSelectionInput,
  type NotebookOutlineSourceCell,
  type NotebookOutlineSourceOutput,
  type NotebookOutlineTitleSegment,
  type NotebookOutlineTreeNode,
  type ProjectNotebookOutlineOptions,
} from "./notebook-outline";

// Notebook edit access projection
export {
  isNotebookRoomAccessLevel,
  isNotebookRoomConnectionScope,
  notebookRoomAccessLevelCanEditDocument,
  notebookRoomAccessLevelFromConnectionScope,
  projectNotebookEditAccess,
  projectNotebookRoomEditAccess,
  type NotebookEditAccessProjection,
  type NotebookEditHostSupport,
  type NotebookEditMode,
  type NotebookEditPermission,
  type NotebookEditState,
  type NotebookRoomAccessLevel,
  type NotebookRoomConnectionScope,
  type NotebookRoomEditAccessProjection,
  type NotebookRoomRequestedScope,
  type ProjectNotebookEditAccessOptions,
  type ProjectNotebookRoomEditAccessOptions,
} from "./notebook-edit-access";

// Notebook actor projection
export {
  friendlyNotebookActorLabel,
  friendlyNotebookOperatorLabel,
  notebookActorIdentityFromAccess,
  notebookActorIdentityFromProjection,
  notebookActorIdentityFromRuntime,
  notebookActorProjectionFromAccess,
  notebookActorProjectionFromLabel,
  notebookActorProjectionFromRuntime,
  notebookActorProjectionWithPrincipalImage,
  parseNotebookActorLabel,
  parseNotebookOperatorLabel,
  splitNotebookActorPrincipalOperator,
  type NotebookActorIdentity,
  type NotebookActorKind,
  type NotebookActorOperator,
  type NotebookActorPrincipal,
  type NotebookActorProjection,
  type NotebookActorProjectionFromLabelOptions,
  type NotebookActorSourceProvider,
  type ParsedNotebookActorKind,
  type ParsedNotebookActorLabel,
} from "./notebook-actor-projection";

// Notebook shell capability projection
export {
  notebookShellRuntimeTargetSummary,
  notebookShellWorkstationAttachmentCacheKey,
  projectNotebookShellCapabilities,
  projectNotebookRuntimeTargetFromWorkstationAttachment,
  readOnlyNotebookShellCapabilities,
  resolveNotebookShellRuntimeTarget,
  stabilizeNotebookShellCapabilities,
  workstationAttachmentCanExecute,
  workstationAttachmentIsConnected,
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
  type ProjectNotebookRuntimeTargetFromWorkstationAttachmentOptions,
  type ProjectNotebookShellCapabilitiesOptions,
} from "./notebook-shell-capabilities";

// Notebook workstation panel projection
export {
  clearNotebookWorkstationPanelProjectionCacheForTests,
  projectNotebookWorkstationPanel,
  type NotebookWorkstationFactKind,
  type NotebookWorkstationFactProjection,
  type NotebookWorkstationPanelProjection,
  type NotebookWorkstationPanelTone,
} from "./notebook-workstation-panel";

// Notebook workstation selection projection
export {
  clearNotebookWorkstationSelectionProjectionCacheForTests,
  projectNotebookWorkstationSelection,
  type NotebookRegisteredWorkstation,
  type NotebookRegisteredWorkstationEnvironment,
  type NotebookRegisteredWorkstationFactKind,
  type NotebookRegisteredWorkstationFactProjection,
  type NotebookRegisteredWorkstationProjection,
  type NotebookRegisteredWorkstationStatus,
  type NotebookWorkstationEnvironmentPolicy,
  type NotebookWorkstationEnvironmentProjection,
  type NotebookWorkstationSelectionProjection,
  type NotebookWorkstationSelectionState,
  type ProjectNotebookWorkstationSelectionOptions,
} from "./notebook-workstation-selection";

// Notebook workstation attachment projections
export {
  projectNotebookWorkstationAttachmentFromClaim,
  type NotebookWorkstationAttachmentClaim,
  type NotebookWorkstationAttachmentClaimStatus,
  type NotebookWorkstationAttachmentTarget,
  type ProjectNotebookWorkstationAttachmentFromClaimOptions,
} from "./notebook-workstation-attachment";

// Notebook workstation launch-readiness projection
export {
  clearNotebookWorkstationLaunchReadinessProjectionCacheForTests,
  projectNotebookWorkstationLaunchReadiness,
  type NotebookWorkstationLaunchActionKind,
  type NotebookWorkstationLaunchActionProjection,
  type NotebookWorkstationLaunchReadinessProjection,
  type NotebookWorkstationLaunchReadinessState,
  type ProjectNotebookWorkstationLaunchReadinessOptions,
} from "./notebook-workstation-launch";

// Notebook workstation surface projection
export {
  clearNotebookWorkstationSurfaceProjectionCacheForTests,
  projectNotebookWorkstationSurface,
  type NotebookWorkstationSurfaceMutationProjection,
  type NotebookWorkstationSurfaceProjection,
  type NotebookWorkstationToolbarActionProjection,
  type ProjectNotebookWorkstationSurfaceOptions,
} from "./notebook-workstation-surface";

// Notebook launch environment projection
export {
  clearNotebookLaunchEnvironmentProjectionCacheForTests,
  projectNotebookLaunchEnvironment,
  type NotebookLaunchEnvironmentOptionKind,
  type NotebookLaunchEnvironmentOptionProjection,
  type NotebookLaunchEnvironmentProjection,
  type NotebookLaunchEnvironmentSource,
  type NotebookLaunchKernelSpecProjection,
  type ProjectNotebookLaunchEnvironmentOptions,
} from "./notebook-launch-environment";

// Projection cache helpers
export { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";

// Notebook interaction projection
export {
  createNotebookInteractionStore,
  notebookInteractionTargetCellId,
  notebookInteractionTargetsEqual,
  notebookInteractionTargetToPresenceTarget,
  notebookPresenceInteractionTargetsEqual,
  notebookPresenceTargetToInteractionTarget,
  type NotebookInteractionSnapshot,
  type NotebookInteractionStore,
  type NotebookInteractionTarget,
  type PresenceInteractionTarget,
} from "./notebook-interaction";

// Comm diffing
export {
  type CommChanges,
  type CommDiffResult,
  type CommDiffState,
  detectOutputManifestHashes,
  detectUnresolvedOutputs,
  diffComms,
  isManifestHash,
  type OutputManifestHashes,
  type ResolvedComm,
  type UnresolvedOutputs,
} from "./comm-diff";

// Snapshot widget comm projection
export {
  normalizeSnapshotWidgetComms,
  resolveSnapshotWidgetComms,
  snapshotWidgetCommsFromRuntimeAndCommsState,
  snapshotWidgetCommsFromRuntimeState,
  type SnapshotWidgetComm,
  widgetCommStoreState,
} from "./snapshot-widget-comms";

// Derived state
export {
  type DaemonQueueState,
  deriveEnvironmentYml,
  deriveEnvManager,
  deriveEnvSyncState,
  deriveKernelInfo,
  derivePixiInfo,
  derivePyproject,
  deriveQueueState,
  deriveRuntimeKind,
  type EnvManager,
  type EnvManagerMetadataInputs,
  type EnvSyncDiff,
  type EnvSyncState,
  type EnvironmentYmlDeps,
  type EnvironmentYmlInfo,
  isKernelStatus,
  KERNEL_STATUS,
  type KernelInfo,
  type KernelStatus,
  lifecycleToLegacyStatus,
  type PixiInfo,
  type PyProjectDeps,
  type PyProjectInfo,
  RUNTIME_STATUS,
  runtimeStatusKey,
  type RuntimeKind,
  type RuntimeStatusKey,
  statusKeyToLegacyStatus,
} from "./derived-state";

// Notebook command runtime projection
export {
  clearNotebookCommandRuntimeStatusCacheForTests,
  getLifecycleLabel,
  getStatusKeyLabel,
  notebookCommandRuntimeStateForStatusKey,
  projectNotebookCommandRuntimeActions,
  projectNotebookCommandRuntimeStatus,
  projectNotebookCommandRuntimeStatusFromRuntimeState,
  RUNTIME_STATUS_LABELS,
  type NotebookCommandRuntimeActionAvailability,
  type NotebookCommandRuntimeActionsProjection,
  type NotebookCommandRuntimeState,
  type NotebookCommandRuntimeStatusProjection,
  type ProjectNotebookCommandRuntimeActionsOptions,
  type ProjectNotebookCommandRuntimeStatusOptions,
} from "./notebook-command-runtime";

// Notebook client
export {
  NotebookClient,
  type ExecuteCellOptions,
  type NotebookClientOptions,
  type RunAllCellsOptions,
  SaveNotebookError,
} from "./notebook-client";
export type {
  BlobDurability,
  BlobUploadErrorKind,
  CommRequestMessage,
  CompletionItem,
  DependencyGuard,
  DenoLaunchedConfig,
  EnvSource,
  GuardedNotebookProvenance,
  HistoryEntry,
  LaunchedEnvConfig,
  LaunchSpec,
  NotebookRequest,
  NotebookResponse,
  PackageManager,
  SaveErrorKind,
} from "./request-types";

// Blob upload
export { BlobUploadError, PUT_BLOB_TIMEOUT_MS, putBlob, type PutBlobResult } from "./blob-upload";
export {
  createBlobResolver,
  createHttpBlobResolver,
  normalizeBlobResolver,
  type BlobRef,
  type BlobResolver,
  type BlobResolverInput,
  type BlobResolverOptions,
} from "./blob-resolver";

// MIME priority
export { DEFAULT_MIME_PRIORITY } from "./mime-priority";

// Testing
export { DirectTransport } from "./direct-transport";
export type { ServerHandle } from "./direct-transport";
