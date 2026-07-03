import { BehaviorSubject, distinctUntilChanged, map, type Observable } from "rxjs";

import type { ViewerStatus } from "./notice-types";
import {
  projectCloudAccessRequestNotice,
  shouldFallbackCloudEditUrlToView,
  shouldLoadOwnCloudAccessRequest,
  type CloudAccessRequestNoticeProjection,
} from "./cloud-access-request-state";
import {
  cloudNotebookAccessScopeForShell,
  cloudNotebookLiveRoomConnectionPolicy,
  cloudNotebookScopeCanEditDocument,
  type CloudNotebookCatalogAccessScope,
  type CloudNotebookLiveRoomConnectionPolicy,
} from "./cloud-notebook-catalog-access";
import {
  cloudNotebookInteractionModeForAccess,
  cloudNotebookSelectedModeCorrectionForAccess,
  type CloudNotebookUrlMode,
} from "./cloud-notebook-mode";
import type { CloudNotebookAccessRequest } from "./sharing-client";

export type CloudCatalogAccessFetchStatus = "idle" | "loading" | "ready" | "error";

export interface CloudCatalogAccessFacts {
  status: CloudCatalogAccessFetchStatus;
  scope: CloudNotebookCatalogAccessScope | null;
}

export interface CloudAccessConnectionFacts {
  error: string | null;
  peerId: string | null;
  scope: string | null;
  statusKind: ViewerStatus["kind"];
}

export interface CloudAccessRequestFacts {
  error: string | null;
  latest: CloudNotebookAccessRequest | null;
  requestedByUser: boolean;
}

export interface CloudAccessSourceFacts {
  canUseAuthenticatedCloudApi: boolean;
  catalog: CloudCatalogAccessFacts;
  connection: CloudAccessConnectionFacts;
  hasBrowserAppIdentity: boolean;
  request: CloudAccessRequestFacts;
  selectedMode: CloudNotebookUrlMode;
}

export interface CloudAccessFactsProjection {
  accessConnectionScope: string | null;
  accessRequestNotice: CloudAccessRequestNoticeProjection | null;
  catalogGrantsDocumentEdit: boolean;
  connectionReadyForAccessScope: boolean;
  effectiveAccessRequest: CloudNotebookAccessRequest | null;
  liveRoomPolicy: CloudNotebookLiveRoomConnectionPolicy;
  selectedInteractionModeForAccess: CloudNotebookUrlMode;
  selectedModeCorrection: CloudNotebookUrlMode | null;
  shouldFallbackEditUrlToView: boolean;
  shouldLoadOwnEditAccessRequest: boolean;
}

interface CloudAccessFactsSetOptions {
  notify?: boolean;
}

export function cloudCatalogAccessFacts({
  canUseAuthenticatedCloudApi,
  loadFailed,
  resolved,
  scope,
}: {
  canUseAuthenticatedCloudApi: boolean;
  loadFailed: boolean;
  resolved: boolean;
  scope: CloudNotebookCatalogAccessScope | null;
}): CloudCatalogAccessFacts {
  if (!canUseAuthenticatedCloudApi) {
    return Object.freeze({ status: "idle", scope: null });
  }
  if (loadFailed) {
    return Object.freeze({ status: "error", scope: null });
  }
  if (resolved) {
    return Object.freeze({ status: "ready", scope });
  }
  return Object.freeze({ status: "loading", scope: null });
}

export function projectCloudAccessLiveRoomPolicy({
  canUseAuthenticatedCloudApi,
  catalog,
}: {
  canUseAuthenticatedCloudApi: boolean;
  catalog: CloudCatalogAccessFacts;
}): CloudNotebookLiveRoomConnectionPolicy {
  return cloudNotebookLiveRoomConnectionPolicy({
    canUseAuthenticatedCloudApi,
    catalogLoadFailed: catalog.status === "error",
    catalogResolved: catalog.status === "ready",
    catalogScope: catalog.scope,
  });
}

export function projectCloudAccessFacts(
  source: CloudAccessSourceFacts,
): CloudAccessFactsProjection {
  const catalogResolved = source.catalog.status === "ready";
  const catalogGrantsDocumentEdit = cloudNotebookScopeCanEditDocument(source.catalog.scope);
  const liveRoomPolicy = projectCloudAccessLiveRoomPolicy({
    canUseAuthenticatedCloudApi: source.canUseAuthenticatedCloudApi,
    catalog: source.catalog,
  });
  const connectionReadyForAccessScope =
    !source.connection.error &&
    Boolean(source.connection.peerId) &&
    (source.connection.statusKind === "ready" || source.connection.statusKind === "empty");
  const accessConnectionScope = cloudNotebookAccessScopeForShell({
    catalogScope: source.catalog.scope,
    connectionReady: connectionReadyForAccessScope,
    connectionScope: source.connection.scope,
  });
  const effectiveAccessRequest = catalogGrantsDocumentEdit ? null : source.request.latest;
  const shouldLoadOwnEditAccessRequest = shouldLoadOwnCloudAccessRequest({
    canUseAuthenticatedCloudApi: source.canUseAuthenticatedCloudApi,
    catalogGrantsDocumentEdit,
    connectionScope: source.connection.scope,
    editAccessRequested: source.request.requestedByUser,
    hasBrowserAppIdentity: source.hasBrowserAppIdentity,
    selectedMode: source.selectedMode,
  });
  const selectedInteractionModeForAccess = cloudNotebookInteractionModeForAccess({
    accessRequestStatus: effectiveAccessRequest?.status,
    accessScope: accessConnectionScope,
    catalogResolved,
    connectionScope: source.connection.scope,
    selectedMode: source.selectedMode,
  });
  const selectedModeCorrection = cloudNotebookSelectedModeCorrectionForAccess({
    accessMode: selectedInteractionModeForAccess,
    selectedMode: source.selectedMode,
  });
  const shouldFallbackEditUrlToView = shouldFallbackCloudEditUrlToView({
    catalogGrantsDocumentEdit,
    catalogResolved,
    editAccessRequested: source.request.requestedByUser,
    selectedMode: source.selectedMode,
  });
  const accessRequestNotice = projectCloudAccessRequestNotice({
    error: source.request.error,
    request: effectiveAccessRequest,
    selectedMode: source.selectedMode,
  });

  return Object.freeze({
    accessConnectionScope,
    accessRequestNotice,
    catalogGrantsDocumentEdit,
    connectionReadyForAccessScope,
    effectiveAccessRequest,
    liveRoomPolicy,
    selectedInteractionModeForAccess,
    selectedModeCorrection,
    shouldFallbackEditUrlToView,
    shouldLoadOwnEditAccessRequest,
  });
}

/**
 * Per-notebook cloud access facts store.
 *
 * Source facts stay host-owned: catalog fetch state, live-room connection
 * state, URL-selected mode, and edit-request fetch results. The store only
 * projects stable UI facts from those sources; it is not an ACL authority.
 */
export class CloudAccessFactsStore {
  private sourceFacts: CloudAccessSourceFacts;
  private currentProjection: CloudAccessFactsProjection;
  private publishedProjection: CloudAccessFactsProjection;
  private pendingProjectionNotification = false;
  private readonly projectionSubject: BehaviorSubject<CloudAccessFactsProjection>;

  readonly projection$: Observable<CloudAccessFactsProjection>;

  constructor(initial: CloudAccessSourceFacts) {
    this.sourceFacts = initial;
    this.currentProjection = projectCloudAccessFacts(initial);
    this.publishedProjection = this.currentProjection;
    this.projectionSubject = new BehaviorSubject(this.currentProjection);
    this.projection$ = this.projectionSubject.asObservable();
  }

  select<T>(
    project: (projection: CloudAccessFactsProjection) => T,
    equals: (a: T, b: T) => boolean = Object.is,
  ): Observable<T> {
    return this.projection$.pipe(map(project), distinctUntilChanged(equals));
  }

  get source(): CloudAccessSourceFacts {
    return this.sourceFacts;
  }

  get snapshot(): CloudAccessFactsProjection {
    return this.currentProjection;
  }

  set(next: CloudAccessSourceFacts, options: CloudAccessFactsSetOptions = {}): void {
    this.sourceFacts = next;
    const nextProjection = projectCloudAccessFacts(next);
    if (cloudAccessFactsProjectionEquals(this.currentProjection, nextProjection)) {
      if (options.notify !== false) {
        this.flush();
      }
      return;
    }
    this.currentProjection = nextProjection;
    this.pendingProjectionNotification = !cloudAccessFactsProjectionEquals(
      this.publishedProjection,
      this.currentProjection,
    );
    if (options.notify === false) {
      return;
    }
    this.flush();
  }

  update(
    project: (current: CloudAccessSourceFacts) => CloudAccessSourceFacts,
    options?: CloudAccessFactsSetOptions,
  ): void {
    this.set(project(this.source), options);
  }

  flush(): void {
    if (!this.pendingProjectionNotification) {
      return;
    }
    this.pendingProjectionNotification = false;
    if (cloudAccessFactsProjectionEquals(this.publishedProjection, this.currentProjection)) {
      return;
    }
    this.publishedProjection = this.currentProjection;
    this.projectionSubject.next(this.currentProjection);
  }
}

export function cloudAccessFactsProjectionEquals(
  a: CloudAccessFactsProjection,
  b: CloudAccessFactsProjection,
): boolean {
  return (
    a === b ||
    (a.accessConnectionScope === b.accessConnectionScope &&
      accessRequestNoticeEquals(a.accessRequestNotice, b.accessRequestNotice) &&
      a.catalogGrantsDocumentEdit === b.catalogGrantsDocumentEdit &&
      a.connectionReadyForAccessScope === b.connectionReadyForAccessScope &&
      effectiveAccessRequestEquals(a.effectiveAccessRequest, b.effectiveAccessRequest) &&
      liveRoomPolicyEquals(a.liveRoomPolicy, b.liveRoomPolicy) &&
      a.selectedInteractionModeForAccess === b.selectedInteractionModeForAccess &&
      a.selectedModeCorrection === b.selectedModeCorrection &&
      a.shouldFallbackEditUrlToView === b.shouldFallbackEditUrlToView &&
      a.shouldLoadOwnEditAccessRequest === b.shouldLoadOwnEditAccessRequest)
  );
}
// Adding a field to `CloudAccessFactsProjection` breaks this manifest's
// typecheck, flagging the comparator for update.
const _CLOUD_ACCESS_FACTS_FIELDS = {
  accessConnectionScope: true,
  accessRequestNotice: true,
  catalogGrantsDocumentEdit: true,
  connectionReadyForAccessScope: true,
  effectiveAccessRequest: true,
  liveRoomPolicy: true,
  selectedInteractionModeForAccess: true,
  selectedModeCorrection: true,
  shouldFallbackEditUrlToView: true,
  shouldLoadOwnEditAccessRequest: true,
} satisfies Record<keyof CloudAccessFactsProjection, true>;
void _CLOUD_ACCESS_FACTS_FIELDS;

/** Dedup identity for the frozen notice sub-object. */
function accessRequestNoticeEquals(
  a: CloudAccessRequestNoticeProjection | null,
  b: CloudAccessRequestNoticeProjection | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.tone === b.tone && a.title === b.title && a.message === b.message;
}

/**
 * Dedup identity for the effective request: the fields a viewer's live-room
 * decision keys off. The actor labels and `created_at` are display-only, so a
 * change there does not re-emit.
 */
function effectiveAccessRequestEquals(
  a: CloudNotebookAccessRequest | null,
  b: CloudNotebookAccessRequest | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.notebook_id === b.notebook_id &&
    a.requester_principal === b.requester_principal &&
    a.scope === b.scope &&
    a.status === b.status &&
    a.updated_at === b.updated_at &&
    (a.resolved_at ?? null) === (b.resolved_at ?? null)
  );
}

/** Dedup identity for the live-room policy sub-object. */
function liveRoomPolicyEquals(
  a: CloudNotebookLiveRoomConnectionPolicy,
  b: CloudNotebookLiveRoomConnectionPolicy,
): boolean {
  return (
    a === b ||
    (a.shouldConnectLiveRoom === b.shouldConnectLiveRoom &&
      (a.disabledStatus?.kind ?? null) === (b.disabledStatus?.kind ?? null) &&
      (a.disabledStatus?.message ?? null) === (b.disabledStatus?.message ?? null))
  );
}
