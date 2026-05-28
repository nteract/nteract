export type CloudShareScope = "viewer" | "editor" | "runtime_peer" | "owner";
export type CloudShareInviteScope = "viewer" | "editor";
export type CloudInviteStatus = "pending" | "accepted" | "revoked" | "expired";

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

export type CloudShareAccessRow =
  | {
      id: string;
      kind: "acl";
      acl: CloudNotebookAclRow;
      label: string;
      detail: string;
      scope: CloudShareScope;
      badge: string;
      removable: boolean;
    }
  | {
      id: string;
      kind: "invite";
      invite: CloudNotebookInvite;
      label: string;
      detail: string;
      scope: CloudShareInviteScope;
      badge: string;
      removable: boolean;
    };

export function buildCloudShareAccessRows(input: {
  acl: CloudNotebookAclRow[];
  invites: CloudNotebookInvite[];
}): CloudShareAccessRow[] {
  const rows: CloudShareAccessRow[] = [];

  for (const acl of [...input.acl].sort(compareAclRows)) {
    rows.push({
      id: `acl:${acl.subject_kind}:${acl.subject}:${acl.scope}`,
      kind: "acl",
      acl,
      label: labelForAcl(acl),
      detail: detailForAcl(acl),
      scope: acl.scope,
      badge: scopeLabel(acl.scope),
      removable: acl.subject_kind === "public" || acl.scope !== "owner",
    });
  }

  for (const invite of input.invites.filter((candidate) => candidate.status === "pending")) {
    rows.push({
      id: `invite:${invite.id}`,
      kind: "invite",
      invite,
      label: invite.display?.label || invite.email,
      detail: invite.provider_hint
        ? `Pending invite via ${invite.provider_hint}`
        : "Pending invite",
      scope: invite.scope,
      badge: scopeLabel(invite.scope),
      removable: true,
    });
  }

  return rows;
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
    return row.display?.label || "Anyone with the link";
  }
  return row.display?.label || row.subject;
}

function detailForAcl(row: CloudNotebookAclRow): string {
  if (row.subject_kind === "public") {
    return "Public read-only access";
  }
  const display = row.display;
  if (display?.kind === "principal") {
    const email = display.email?.trim();
    if (email && email !== display.label) {
      return email;
    }
    return display.principal;
  }
  return row.subject;
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
