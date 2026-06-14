import { BehaviorSubject, distinctUntilChanged, map, type Observable } from "rxjs";

import {
  buildCloudShareAccessProjection,
  hasPublicViewerAccess,
  normalizeShareInviteEmail,
  type CloudNotebookAccessRequest,
  type CloudNotebookAclRow,
  type CloudNotebookInvite,
  type CloudShareAccessProjection,
} from "./sharing-client";

export type CloudSharingLoadState = "idle" | "loading" | "ready" | "error";
export type CloudSharingCopyState = "idle" | "copied" | "failed";

export interface CloudSharingSourceFacts {
  accessRequests: readonly CloudNotebookAccessRequest[];
  acl: readonly CloudNotebookAclRow[];
  copyState: CloudSharingCopyState;
  inviteEmail: string;
  invites: readonly CloudNotebookInvite[];
  loadState: CloudSharingLoadState;
}

export interface CloudSharingFactsProjection {
  access: CloudShareAccessProjection;
  compactCopyLinkLabel: string;
  copyLinkLabel: string;
  inviteReady: boolean;
  publicEnabled: boolean;
  showInitialAccessLoading: boolean;
}

interface CloudSharingFactsSetOptions {
  notify?: boolean;
}

/**
 * Projection for the owner-facing sharing panel.
 *
 * D1 ACL rows, invite rows, and access-request rows remain source facts loaded
 * and mutated by the cloud host APIs. This projection only derives stable panel
 * affordances from those facts.
 */
export function projectCloudSharingFacts({
  accessRequests,
  acl,
  copyState,
  inviteEmail,
  invites,
  loadState,
}: CloudSharingSourceFacts): CloudSharingFactsProjection {
  const access = buildCloudShareAccessProjection({
    acl: [...acl],
    invites: [...invites],
    accessRequests: [...accessRequests],
  });
  const publicEnabled = hasPublicViewerAccess([...acl]);
  const copyLinkLabel =
    copyState === "copied" ? "Copied link" : copyState === "failed" ? "Copy failed" : "Copy link";
  const compactCopyLinkLabel =
    copyState === "copied" ? "Copied" : copyState === "failed" ? "Failed" : "Copy";

  return Object.freeze({
    access,
    compactCopyLinkLabel,
    copyLinkLabel,
    inviteReady: normalizeShareInviteEmail(inviteEmail) !== null,
    publicEnabled,
    showInitialAccessLoading: loadState === "loading" && access.allRows.length === 0,
  });
}

/**
 * Per-notebook cloud sharing facts store.
 *
 * Source facts stay host-owned: D1 ACL rows, invite rows, edit-request rows,
 * public-link copy state, and panel fetch state. The store projects stable
 * owner-panel affordances from those facts; it is not an ACL authority.
 */
export class CloudSharingFactsStore {
  private sourceFacts: CloudSharingSourceFacts;
  private currentProjection: CloudSharingFactsProjection;
  private publishedProjection: CloudSharingFactsProjection;
  private pendingProjectionNotification = false;
  private readonly projectionSubject: BehaviorSubject<CloudSharingFactsProjection>;

  readonly projection$: Observable<CloudSharingFactsProjection>;

  constructor(initial: CloudSharingSourceFacts) {
    this.sourceFacts = initial;
    this.currentProjection = projectCloudSharingFacts(initial);
    this.publishedProjection = this.currentProjection;
    this.projectionSubject = new BehaviorSubject(this.currentProjection);
    this.projection$ = this.projectionSubject.asObservable();
  }

  select<T>(
    project: (projection: CloudSharingFactsProjection) => T,
    equals: (a: T, b: T) => boolean = Object.is,
  ): Observable<T> {
    return this.projection$.pipe(map(project), distinctUntilChanged(equals));
  }

  get source(): CloudSharingSourceFacts {
    return this.sourceFacts;
  }

  get snapshot(): CloudSharingFactsProjection {
    return this.currentProjection;
  }

  set(next: CloudSharingSourceFacts, options: CloudSharingFactsSetOptions = {}): void {
    this.sourceFacts = next;
    const nextProjection = projectCloudSharingFacts(next);
    if (cloudSharingFactsProjectionEquals(this.currentProjection, nextProjection)) {
      if (options.notify !== false) {
        this.flush();
      }
      return;
    }
    this.currentProjection = nextProjection;
    this.pendingProjectionNotification = !cloudSharingFactsProjectionEquals(
      this.publishedProjection,
      this.currentProjection,
    );
    if (options.notify === false) {
      return;
    }
    this.flush();
  }

  update(
    project: (current: CloudSharingSourceFacts) => CloudSharingSourceFacts,
    options?: CloudSharingFactsSetOptions,
  ): void {
    this.set(project(this.source), options);
  }

  flush(): void {
    if (!this.pendingProjectionNotification) {
      return;
    }
    this.pendingProjectionNotification = false;
    if (cloudSharingFactsProjectionEquals(this.publishedProjection, this.currentProjection)) {
      return;
    }
    this.publishedProjection = this.currentProjection;
    this.projectionSubject.next(this.currentProjection);
  }
}

export function cloudSharingFactsProjectionEquals(
  a: CloudSharingFactsProjection,
  b: CloudSharingFactsProjection,
): boolean {
  return (
    a.access === b.access &&
    a.compactCopyLinkLabel === b.compactCopyLinkLabel &&
    a.copyLinkLabel === b.copyLinkLabel &&
    a.inviteReady === b.inviteReady &&
    a.publicEnabled === b.publicEnabled &&
    a.showInitialAccessLoading === b.showInitialAccessLoading
  );
}
