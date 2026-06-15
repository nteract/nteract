import type { CloudShareDisplay } from "./sharing-client";

export type CloudMarkdownShareScope = "viewer" | "editor" | "owner";

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

export interface CloudMarkdownShareAccessRow {
  id: string;
  acl: CloudMarkdownDocumentAclRow;
  label: string;
  detail: string;
  title: string;
  badge: string;
  removable: boolean;
}

export interface CloudMarkdownShareProjection {
  rows: CloudMarkdownShareAccessRow[];
  summary: string | null;
}

export function buildCloudMarkdownShareProjection(input: {
  acl: CloudMarkdownDocumentAclRow[];
}): CloudMarkdownShareProjection {
  const rows = [...input.acl].sort(compareMarkdownAclRows).map(markdownAclRowToAccessRow);
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
    acl: row,
    label,
    detail,
    title: `${label}: ${detail}`,
    badge: scopeLabel(row.scope),
    removable: row.subject_kind === "public" || row.scope !== "owner",
  };
}

function markdownShareSummary(rows: CloudMarkdownShareAccessRow[]): string | null {
  if (rows.length === 0) {
    return null;
  }
  const principalCount = rows.filter((row) => row.acl.subject_kind === "principal").length;
  const publicCount = rows.length - principalCount;
  const parts: string[] = [];
  if (principalCount > 0) {
    parts.push(`${principalCount} ${principalCount === 1 ? "person" : "people"}`);
  }
  if (publicCount > 0) {
    parts.push("public link");
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
