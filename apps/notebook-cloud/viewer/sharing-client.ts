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

export function buildCloudShareAccessRows(input: {
  acl: CloudNotebookAclRow[];
  invites: CloudNotebookInvite[];
  accessRequests?: CloudNotebookAccessRequest[];
}): CloudShareAccessRow[] {
  const rows: CloudShareAccessRow[] = [];

  for (const acl of [...input.acl].sort(compareAclRows)) {
    rows.push({
      id: `acl:${acl.subject_kind}:${acl.subject}:${acl.scope}`,
      kind: "acl",
      acl,
      label: labelForAcl(acl),
      detail: detailForAcl(acl),
      title: titleForAcl(acl),
      scope: acl.scope,
      badge: scopeLabel(acl.scope),
      stateLabel: acl.subject_kind === "public" ? "Enabled" : null,
      stateTone: acl.subject_kind === "public" ? "success" : null,
      removable: acl.subject_kind === "public" || acl.scope !== "owner",
    });
  }

  for (const invite of input.invites.filter((candidate) => candidate.status === "pending")) {
    rows.push({
      id: `invite:${invite.id}`,
      kind: "invite",
      invite,
      label: displayEmail(invite.display?.label || invite.email),
      detail: invite.provider_hint
        ? `Pending invite via ${invite.provider_hint}`
        : "Pending invite",
      title: invite.email,
      scope: invite.scope,
      badge: scopeLabel(invite.scope),
      stateLabel: "Pending",
      stateTone: "pending",
      removable: true,
    });
  }

  for (const request of (input.accessRequests ?? []).filter(
    (candidate) => candidate.status === "pending",
  )) {
    rows.push({
      id: `access-request:${request.id}`,
      kind: "access_request",
      accessRequest: request,
      label: labelForAccessRequest(request),
      detail: "Requested edit access",
      title: titleForAccessRequest(request),
      scope: request.scope,
      badge: scopeLabel(request.scope),
      stateLabel: "Requested",
      stateTone: "pending",
      removable: false,
    });
  }

  return rows;
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
