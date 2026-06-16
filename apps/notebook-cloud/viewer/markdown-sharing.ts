import type { CloudShareDisplay } from "./sharing-client";

export type CloudMarkdownShareScope = "viewer" | "editor" | "owner";
export type CloudMarkdownInviteStatus = "pending" | "accepted" | "revoked" | "expired";
export type CloudMarkdownAccessRequestStatus = "pending" | "approved" | "denied" | "dismissed";
export type CloudMarkdownShareInviteScope = "viewer" | "editor";

export interface CloudMarkdownDocumentAclRow {
  document_id: string;
  subject_kind: "principal" | "public";
  subject: string;
  scope: CloudMarkdownShareScope;
  created_at: string;
  updated_at: string;
  created_by_actor_label: string;
  display?: CloudShareDisplay;
}

export interface CloudMarkdownDocumentInvite {
  id: string;
  document_id: string;
  email: string;
  provider_hint: string | null;
  scope: CloudMarkdownShareInviteScope;
  status: CloudMarkdownInviteStatus;
  invited_by_actor_label: string;
  accepted_by_principal: string | null;
  created_at: string;
  expires_at: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
  revoked_by_actor_label: string | null;
  display?: CloudShareDisplay;
}

export interface CloudMarkdownAccessRequest {
  id: string;
  document_id: string;
  requester_principal: string;
  scope: "editor";
  status: CloudMarkdownAccessRequestStatus;
  requested_by_actor_label: string;
  resolved_by_actor_label: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  display?: Extract<CloudShareDisplay, { kind: "principal" }>;
}

export type CloudMarkdownShareAccessRow =
  | {
      id: string;
      kind: "acl";
      acl: CloudMarkdownDocumentAclRow;
      label: string;
      detail: string;
      title: string;
      badge: string;
      stateLabel: string | null;
      removable: boolean;
    }
  | {
      id: string;
      kind: "invite";
      invite: CloudMarkdownDocumentInvite;
      label: string;
      detail: string;
      title: string;
      badge: string;
      stateLabel: string | null;
      removable: boolean;
    }
  | {
      id: string;
      kind: "access_request";
      accessRequest: CloudMarkdownAccessRequest;
      label: string;
      detail: string;
      title: string;
      badge: string;
      stateLabel: string | null;
      removable: false;
    };

export interface CloudMarkdownShareProjection {
  rows: CloudMarkdownShareAccessRow[];
  summary: string | null;
}

export function buildCloudMarkdownShareProjection(input: {
  acl: CloudMarkdownDocumentAclRow[];
  invites?: CloudMarkdownDocumentInvite[];
  accessRequests?: CloudMarkdownAccessRequest[];
}): CloudMarkdownShareProjection {
  const rows = [
    ...[...input.acl].sort(compareMarkdownAclRows).map(markdownAclRowToAccessRow),
    ...(input.invites ?? [])
      .filter((invite) => invite.status === "pending")
      .map(markdownInviteToAccessRow),
    ...(input.accessRequests ?? [])
      .filter((request) => request.status === "pending")
      .map(markdownAccessRequestToAccessRow),
  ];
  return {
    rows,
    summary: markdownShareSummary(rows),
  };
}

function markdownAclRowToAccessRow(row: CloudMarkdownDocumentAclRow): CloudMarkdownShareAccessRow {
  const label = labelForMarkdownAcl(row);
  const detail = detailForMarkdownAcl(row);
  return {
    id: `acl:${row.subject_kind}:${row.subject}:${row.scope}`,
    kind: "acl",
    acl: row,
    label,
    detail,
    title: `${label}: ${detail}`,
    badge: scopeLabel(row.scope),
    stateLabel: row.subject_kind === "public" ? "Enabled" : null,
    removable: row.subject_kind === "public" || row.scope !== "owner",
  };
}

function markdownInviteToAccessRow(
  invite: CloudMarkdownDocumentInvite,
): CloudMarkdownShareAccessRow {
  const label = displayEmail(invite.display?.label || invite.email);
  const detail = invite.provider_hint
    ? `Pending invite via ${invite.provider_hint}`
    : "Pending invite";
  return {
    id: `invite:${invite.id}`,
    kind: "invite",
    invite,
    label,
    detail,
    title: invite.email,
    badge: scopeLabel(invite.scope),
    stateLabel: "Pending",
    removable: true,
  };
}

function markdownAccessRequestToAccessRow(
  accessRequest: CloudMarkdownAccessRequest,
): CloudMarkdownShareAccessRow {
  const displayLabel = accessRequest.display?.label?.trim();
  const label =
    displayLabel && displayLabel !== accessRequest.requester_principal
      ? displayEmail(displayLabel)
      : displayEmail(labelForPrincipalSubject(accessRequest.requester_principal));
  const title = accessRequest.display?.email || accessRequest.requester_principal;
  return {
    id: `access-request:${accessRequest.id}`,
    kind: "access_request",
    accessRequest,
    label,
    detail: "Requested edit access",
    title,
    badge: scopeLabel(accessRequest.scope),
    stateLabel: "Requested",
    removable: false,
  };
}

function markdownShareSummary(rows: CloudMarkdownShareAccessRow[]): string | null {
  if (rows.length === 0) {
    return null;
  }
  const principalCount = rows.filter(
    (row) => row.kind === "acl" && row.acl.subject_kind === "principal",
  ).length;
  const publicCount = rows.filter(
    (row) => row.kind === "acl" && row.acl.subject_kind === "public",
  ).length;
  const inviteCount = rows.filter((row) => row.kind === "invite").length;
  const requestCount = rows.filter((row) => row.kind === "access_request").length;
  const parts: string[] = [];
  if (principalCount > 0) {
    parts.push(`${principalCount} ${principalCount === 1 ? "person" : "people"}`);
  }
  if (publicCount > 0) {
    parts.push("public link");
  }
  if (inviteCount > 0) {
    parts.push(`${inviteCount} ${inviteCount === 1 ? "invite" : "invites"}`);
  }
  if (requestCount > 0) {
    parts.push(`${requestCount} ${requestCount === 1 ? "request" : "requests"}`);
  }
  return parts.join(", ");
}

function labelForMarkdownAcl(row: CloudMarkdownDocumentAclRow): string {
  if (row.subject_kind === "public") {
    return "Public link";
  }
  return row.display?.label || row.subject;
}

function detailForMarkdownAcl(row: CloudMarkdownDocumentAclRow): string {
  if (row.subject_kind === "public") {
    return "Anyone with the link can view";
  }
  if (row.display?.kind === "principal" && row.display.email) {
    return row.display.email;
  }
  return row.subject;
}

function scopeLabel(scope: CloudMarkdownShareScope): string {
  switch (scope) {
    case "owner":
      return "Owner";
    case "editor":
      return "Can edit";
    case "viewer":
      return "Can view";
  }
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
  const tail = subject.split(":").at(-1)?.trim();
  if (!tail) return subject;
  try {
    return decodeURIComponent(tail) || tail;
  } catch {
    return tail;
  }
}

function compareMarkdownAclRows(
  left: CloudMarkdownDocumentAclRow,
  right: CloudMarkdownDocumentAclRow,
): number {
  const rank = (row: CloudMarkdownDocumentAclRow): number => {
    if (row.scope === "owner") return 0;
    if (row.scope === "editor") return 1;
    if (row.subject_kind === "public") return 3;
    return 2;
  };
  return (
    rank(left) - rank(right) ||
    labelForMarkdownAcl(left).localeCompare(labelForMarkdownAcl(right)) ||
    left.scope.localeCompare(right.scope)
  );
}
