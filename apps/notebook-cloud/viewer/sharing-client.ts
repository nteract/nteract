import {
  getBoundedCacheValue,
  setBoundedCacheValue,
  stableCacheKey,
} from "runtimed/src/projection-cache";

export type CloudShareScope = "viewer" | "editor" | "runtime_peer" | "owner";
export type CloudShareInviteScope = "viewer" | "editor";
export type CloudInviteStatus = "pending" | "accepted" | "revoked" | "expired";
export type CloudAccessRequestStatus = "pending" | "approved" | "denied" | "dismissed";
export type CloudShareAccessRowStateTone = "success" | "pending";

export type CloudShareDisplay =
  | {
      kind: "principal";
      label: string;
      principal: string;
      email: string | null;
    }
  | {
      kind: "pending_invite";
      label: string;
      email: string;
    }
  | {
      kind: "public_viewer";
      label: string;
    };

export interface CloudNotebookAclRow {
  notebook_id: string;
  subject_kind: "principal" | "public";
  subject: string;
  scope: CloudShareScope;
  created_at: string;
  updated_at: string;
  created_by_actor_label: string;
  display?: CloudShareDisplay;
}

export interface CloudNotebookInvite {
  id: string;
  notebook_id: string;
  email: string;
  provider_hint: string | null;
  scope: CloudShareInviteScope;
  status: CloudInviteStatus;
  invited_by_actor_label: string;
  accepted_by_principal: string | null;
  created_at: string;
  expires_at: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  revoked_by_actor_label: string | null;
  display?: CloudShareDisplay;
}

export interface CloudNotebookAccessRequest {
  id: string;
  notebook_id: string;
  requester_principal: string;
  scope: "editor";
  status: CloudAccessRequestStatus;
  requested_by_actor_label: string;
  resolved_by_actor_label: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  display?: Extract<CloudShareDisplay, { kind: "principal" }>;
}

export type CloudShareAccessRow =
  | {
      id: string;
      kind: "acl";
      acl: CloudNotebookAclRow;
      label: string;
      detail: string;
      title: string;
      scope: CloudShareScope;
      badge: string;
      stateLabel: string | null;
      stateTone: CloudShareAccessRowStateTone | null;
      removable: boolean;
    }
  | {
      id: string;
      kind: "invite";
      invite: CloudNotebookInvite;
      label: string;
      detail: string;
      title: string;
      scope: CloudShareInviteScope;
      badge: string;
      stateLabel: string | null;
      stateTone: CloudShareAccessRowStateTone | null;
      removable: boolean;
    }
  | {
      id: string;
      kind: "access_request";
      accessRequest: CloudNotebookAccessRequest;
      label: string;
      detail: string;
      title: string;
      scope: "editor";
      badge: string;
      stateLabel: string | null;
      stateTone: CloudShareAccessRowStateTone | null;
      removable: boolean;
    };

const SHARE_ACCESS_ROW_CACHE = new Map<string, CloudShareAccessRow>();
const SHARE_ACCESS_ROWS_CACHE = new Map<string, CloudShareAccessRow[]>();
const SHARE_ACCESS_ROW_CACHE_LIMIT = 512;
const SHARE_ACCESS_ROWS_CACHE_LIMIT = 128;

export function clearCloudShareAccessRowsCachesForTests(): void {
  SHARE_ACCESS_ROW_CACHE.clear();
  SHARE_ACCESS_ROWS_CACHE.clear();
}

export function buildCloudShareAccessRows(input: {
  acl: CloudNotebookAclRow[];
  invites: CloudNotebookInvite[];
  accessRequests?: CloudNotebookAccessRequest[];
}): CloudShareAccessRow[] {
  const rows: CloudShareAccessRow[] = [];
  const rowKeys: string[] = [];

  for (const acl of [...input.acl].sort(compareAclRows)) {
    const id = `acl:${acl.subject_kind}:${acl.subject}:${acl.scope}`;
    const label = labelForAcl(acl);
    const detail = detailForAcl(acl);
    const title = titleForAcl(acl);
    const badge = scopeLabel(acl.scope);
    const stateLabel = acl.subject_kind === "public" ? "Enabled" : null;
    const stateTone = acl.subject_kind === "public" ? "success" : null;
    const removable = acl.subject_kind === "public" || acl.scope !== "owner";
    const rowKey = stableCacheKey([
      "acl",
      cloudNotebookAclRowCacheKey(acl),
      id,
      label,
      detail,
      title,
      acl.scope,
      badge,
      stateLabel,
      stateTone,
      removable,
    ]);
    rows.push(
      cachedCloudShareAccessRow(rowKey, () => ({
        id,
        kind: "acl",
        acl: stableCloudNotebookAclRow(acl),
        label,
        detail,
        title,
        scope: acl.scope,
        badge,
        stateLabel,
        stateTone,
        removable,
      })),
    );
    rowKeys.push(rowKey);
  }

  for (const invite of input.invites.filter((candidate) => candidate.status === "pending")) {
    const id = `invite:${invite.id}`;
    const label = displayEmail(invite.display?.label || invite.email);
    const detail = invite.provider_hint
      ? `Pending invite via ${invite.provider_hint}`
      : "Pending invite";
    const title = invite.email;
    const badge = scopeLabel(invite.scope);
    const rowKey = stableCacheKey([
      "invite",
      cloudNotebookInviteCacheKey(invite),
      id,
      label,
      detail,
      title,
      invite.scope,
      badge,
    ]);
    rows.push(
      cachedCloudShareAccessRow(rowKey, () => ({
        id,
        kind: "invite",
        invite: stableCloudNotebookInvite(invite),
        label,
        detail,
        title,
        scope: invite.scope,
        badge,
        stateLabel: "Pending",
        stateTone: "pending",
        removable: true,
      })),
    );
    rowKeys.push(rowKey);
  }

  for (const request of (input.accessRequests ?? []).filter(
    (candidate) => candidate.status === "pending",
  )) {
    const id = `access-request:${request.id}`;
    const label = labelForAccessRequest(request);
    const detail = "Requested edit access";
    const title = titleForAccessRequest(request);
    const badge = scopeLabel(request.scope);
    const rowKey = stableCacheKey([
      "access_request",
      cloudNotebookAccessRequestCacheKey(request),
      id,
      label,
      detail,
      title,
      request.scope,
      badge,
    ]);
    rows.push(
      cachedCloudShareAccessRow(rowKey, () => ({
        id,
        kind: "access_request",
        accessRequest: stableCloudNotebookAccessRequest(request),
        label,
        detail,
        title,
        scope: request.scope,
        badge,
        stateLabel: "Requested",
        stateTone: "pending",
        removable: false,
      })),
    );
    rowKeys.push(rowKey);
  }

  return cachedCloudShareAccessRows(rowKeys, rows);
}

export function cloudShareAccessSummary(rows: CloudShareAccessRow[]): string | null {
  if (rows.length === 0) return null;

  const people = rows.filter(
    (row) =>
      row.kind === "acl" && row.acl.subject_kind === "principal" && row.scope !== "runtime_peer",
  ).length;
  const runtimes = rows.filter(
    (row) =>
      row.kind === "acl" && row.acl.subject_kind === "principal" && row.scope === "runtime_peer",
  ).length;
  const publicLinks = rows.filter(
    (row) => row.kind === "acl" && row.acl.subject_kind === "public",
  ).length;
  const invites = rows.filter((row) => row.kind === "invite").length;
  const requests = rows.filter((row) => row.kind === "access_request").length;

  const parts: string[] = [];
  if (people > 0) parts.push(pluralize(people, "person", "people"));
  if (runtimes > 0) parts.push(pluralize(runtimes, "runtime", "runtimes"));
  if (publicLinks > 0)
    parts.push(publicLinks === 1 ? "public link" : `${publicLinks} public links`);
  if (invites > 0) parts.push(pluralize(invites, "invite", "invites"));
  if (requests > 0) parts.push(pluralize(requests, "request", "requests"));
  return parts.join(", ") || null;
}

export function hasPublicViewerAccess(acl: CloudNotebookAclRow[]): boolean {
  return acl.some(
    (row) => row.subject_kind === "public" && row.subject === "anonymous" && row.scope === "viewer",
  );
}

export function scopeLabel(scope: CloudShareScope): string {
  switch (scope) {
    case "owner":
      return "Owner";
    case "editor":
      return "Can edit";
    case "runtime_peer":
      return "Runtime";
    case "viewer":
      return "Can view";
  }
}

export function normalizeShareInviteEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  const parts = email.split("@");
  if (
    !email ||
    email.includes("/") ||
    /\s/.test(email) ||
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !parts[1].includes(".")
  ) {
    return null;
  }
  return email;
}

function labelForAcl(row: CloudNotebookAclRow): string {
  if (row.subject_kind === "public") {
    return "Public link";
  }
  const displayLabel = row.display?.label?.trim();
  if (displayLabel && displayLabel !== row.subject) {
    return displayEmail(displayLabel);
  }
  return displayEmail(labelForPrincipalSubject(row.subject));
}

function detailForAcl(row: CloudNotebookAclRow): string {
  if (row.subject_kind === "public") {
    return row.display?.label || "Anyone with the link";
  }
  const display = row.display;
  if (display?.kind === "principal") {
    const email = display.email?.trim();
    if (email && email !== display.label) {
      return displayEmail(email);
    }
    if (display.principal !== row.subject) {
      return display.principal;
    }
  }
  return detailForPrincipalSubject(row.subject);
}

function titleForAcl(row: CloudNotebookAclRow): string {
  if (row.subject_kind === "public") {
    return row.display?.label || "Public link";
  }

  if (row.display?.kind === "principal") {
    const email = row.display.email?.trim();
    if (email) return email;
    if (row.display.principal !== row.subject) return row.display.principal;
  }

  return row.subject;
}

function labelForAccessRequest(request: CloudNotebookAccessRequest): string {
  const displayLabel = request.display?.label?.trim();
  if (displayLabel && displayLabel !== request.requester_principal) {
    return displayEmail(displayLabel);
  }
  return displayEmail(labelForPrincipalSubject(request.requester_principal));
}

function titleForAccessRequest(request: CloudNotebookAccessRequest): string {
  const email = request.display?.email?.trim();
  if (email) return email;
  if (request.display?.principal && request.display.principal !== request.requester_principal) {
    return request.display.principal;
  }
  return request.requester_principal;
}

function displayEmail(value: string): string {
  const trimmed = value.trim();
  const parts = trimmed.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1].includes(" ")) {
    return trimmed;
  }

  const local = parts[0];
  const first = local.at(0) ?? "";
  const last = local.length > 2 ? (local.at(-1) ?? "") : "";
  return `${first}...${last}@${parts[1]}`;
}

function labelForPrincipalSubject(subject: string): string {
  const decoded = decodePrincipalTail(subject);
  return decoded || subject;
}

function detailForPrincipalSubject(subject: string): string {
  if (subject.startsWith("user:dev:")) {
    return "Dev identity";
  }
  if (subject.startsWith("user:anaconda:")) {
    return "Anaconda identity";
  }
  return subject;
}

function decodePrincipalTail(subject: string): string | null {
  const tail = subject.split(":").at(-1)?.trim();
  if (!tail) return null;
  try {
    return decodeURIComponent(tail) || tail;
  } catch {
    return tail;
  }
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function compareAclRows(a: CloudNotebookAclRow, b: CloudNotebookAclRow): number {
  const rank = (row: CloudNotebookAclRow): number => {
    if (row.subject_kind === "principal" && row.scope === "owner") return 0;
    if (row.subject_kind === "principal") return 1;
    return 2;
  };
  const rankDelta = rank(a) - rank(b);
  if (rankDelta !== 0) return rankDelta;
  return `${labelForAcl(a)}:${a.scope}`.localeCompare(`${labelForAcl(b)}:${b.scope}`);
}

function cachedCloudShareAccessRow<Row extends CloudShareAccessRow>(
  cacheKey: string,
  createRow: () => Row,
): Row {
  const cached = getBoundedCacheValue(SHARE_ACCESS_ROW_CACHE, cacheKey);
  if (cached) return cached as Row;

  const row = Object.freeze(createRow()) as Row;
  setBoundedCacheValue(SHARE_ACCESS_ROW_CACHE, cacheKey, row, SHARE_ACCESS_ROW_CACHE_LIMIT);
  return row;
}

function cachedCloudShareAccessRows(
  rowKeys: readonly string[],
  rows: readonly CloudShareAccessRow[],
): CloudShareAccessRow[] {
  const cacheKey = stableCacheKey(rowKeys);
  const cached = getBoundedCacheValue(SHARE_ACCESS_ROWS_CACHE, cacheKey);
  if (cached) return cached;

  const stableRows = Object.freeze([...rows]) as CloudShareAccessRow[];
  setBoundedCacheValue(
    SHARE_ACCESS_ROWS_CACHE,
    cacheKey,
    stableRows,
    SHARE_ACCESS_ROWS_CACHE_LIMIT,
  );
  return stableRows;
}

function cloudNotebookAclRowCacheKey(row: CloudNotebookAclRow): string {
  return stableCacheKey([
    row.notebook_id,
    row.subject_kind,
    row.subject,
    row.scope,
    row.created_at,
    row.updated_at,
    row.created_by_actor_label,
    cloudShareDisplayCacheKey(row.display),
  ]);
}

function stableCloudNotebookAclRow(row: CloudNotebookAclRow): CloudNotebookAclRow {
  const display = row.display ? stableCloudShareDisplay(row.display) : undefined;
  return Object.freeze({
    notebook_id: row.notebook_id,
    subject_kind: row.subject_kind,
    subject: row.subject,
    scope: row.scope,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by_actor_label: row.created_by_actor_label,
    ...(display ? { display } : {}),
  });
}

function cloudNotebookInviteCacheKey(invite: CloudNotebookInvite): string {
  return stableCacheKey([
    invite.id,
    invite.notebook_id,
    invite.email,
    invite.provider_hint,
    invite.scope,
    invite.status,
    invite.invited_by_actor_label,
    invite.accepted_by_principal,
    invite.created_at,
    invite.expires_at,
    invite.accepted_at,
    invite.revoked_at,
    invite.revoked_by_actor_label,
    cloudShareDisplayCacheKey(invite.display),
  ]);
}

function stableCloudNotebookInvite(invite: CloudNotebookInvite): CloudNotebookInvite {
  const display = invite.display ? stableCloudShareDisplay(invite.display) : undefined;
  return Object.freeze({
    id: invite.id,
    notebook_id: invite.notebook_id,
    email: invite.email,
    provider_hint: invite.provider_hint,
    scope: invite.scope,
    status: invite.status,
    invited_by_actor_label: invite.invited_by_actor_label,
    accepted_by_principal: invite.accepted_by_principal,
    created_at: invite.created_at,
    expires_at: invite.expires_at,
    accepted_at: invite.accepted_at,
    revoked_at: invite.revoked_at,
    revoked_by_actor_label: invite.revoked_by_actor_label,
    ...(display ? { display } : {}),
  });
}

function cloudNotebookAccessRequestCacheKey(request: CloudNotebookAccessRequest): string {
  return stableCacheKey([
    request.id,
    request.notebook_id,
    request.requester_principal,
    request.scope,
    request.status,
    request.requested_by_actor_label,
    request.resolved_by_actor_label,
    request.created_at,
    request.updated_at,
    request.resolved_at,
    cloudShareDisplayCacheKey(request.display),
  ]);
}

function stableCloudNotebookAccessRequest(
  request: CloudNotebookAccessRequest,
): CloudNotebookAccessRequest {
  const display = request.display ? stableCloudShareDisplay(request.display) : undefined;
  return Object.freeze({
    id: request.id,
    notebook_id: request.notebook_id,
    requester_principal: request.requester_principal,
    scope: request.scope,
    status: request.status,
    requested_by_actor_label: request.requested_by_actor_label,
    resolved_by_actor_label: request.resolved_by_actor_label,
    created_at: request.created_at,
    updated_at: request.updated_at,
    resolved_at: request.resolved_at,
    ...(display ? { display } : {}),
  });
}

function cloudShareDisplayCacheKey(display: CloudShareDisplay | undefined): string | null {
  if (!display) return null;
  if (display.kind === "principal") {
    return stableCacheKey([display.kind, display.label, display.principal, display.email]);
  }
  if (display.kind === "pending_invite") {
    return stableCacheKey([display.kind, display.label, display.email]);
  }
  return stableCacheKey([display.kind, display.label]);
}

function stableCloudShareDisplay<Display extends CloudShareDisplay>(display: Display): Display {
  return Object.freeze({ ...display }) as Display;
}
