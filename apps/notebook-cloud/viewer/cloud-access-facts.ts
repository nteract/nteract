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
  private readonly source$: BehaviorSubject<CloudAccessSourceFacts>;

  readonly projection$: Observable<CloudAccessFactsProjection>;

  constructor(initial: CloudAccessSourceFacts) {
    this.source$ = new BehaviorSubject(initial);
    this.projection$ = this.source$.pipe(
      map(projectCloudAccessFacts),
      distinctUntilChanged(cloudAccessFactsProjectionEquals),
    );
  }

  select<T>(
    project: (projection: CloudAccessFactsProjection) => T,
    equals: (a: T, b: T) => boolean = Object.is,
  ): Observable<T> {
    return this.projection$.pipe(map(project), distinctUntilChanged(equals));
  }

  get source(): CloudAccessSourceFacts {
    return this.source$.getValue();
  }

  get snapshot(): CloudAccessFactsProjection {
    return projectCloudAccessFacts(this.source);
  }

  set(next: CloudAccessSourceFacts): void {
    this.source$.next(next);
  }

  update(project: (current: CloudAccessSourceFacts) => CloudAccessSourceFacts): void {
    this.set(project(this.source));
  }
}

export function cloudAccessFactsProjectionEquals(
  a: CloudAccessFactsProjection,
  b: CloudAccessFactsProjection,
): boolean {
  return cloudAccessFactsProjectionKey(a) === cloudAccessFactsProjectionKey(b);
}

function cloudAccessFactsProjectionKey(projection: CloudAccessFactsProjection): string {
  return [
    projection.accessConnectionScope ?? "",
    cloudAccessRequestNoticeKey(projection.accessRequestNotice),
    projection.catalogGrantsDocumentEdit ? "edit" : "read",
    projection.connectionReadyForAccessScope ? "ready" : "not-ready",
    cloudAccessRequestKey(projection.effectiveAccessRequest),
    projection.liveRoomPolicy.shouldConnectLiveRoom ? "connect" : "hold",
    projection.liveRoomPolicy.disabledStatus?.kind ?? "",
    projection.liveRoomPolicy.disabledStatus?.message ?? "",
    projection.selectedInteractionModeForAccess,
    projection.selectedModeCorrection ?? "",
    projection.shouldFallbackEditUrlToView ? "fallback" : "",
    projection.shouldLoadOwnEditAccessRequest ? "load-request" : "",
  ].join("\u001f");
}

function cloudAccessRequestKey(request: CloudNotebookAccessRequest | null): string {
  if (!request) return "";
  return [
    request.id,
    request.notebook_id,
    request.requester_principal,
    request.scope,
    request.status,
    request.updated_at,
    request.resolved_at ?? "",
  ].join("\u001e");
}

function cloudAccessRequestNoticeKey(notice: CloudAccessRequestNoticeProjection | null): string {
  if (!notice) return "";
  return [notice.kind, notice.tone, notice.title, notice.message].join("\u001e");
}
