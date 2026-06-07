export interface CloudNotebookListItem {
  notebook_id: string;
  title: string | null;
  owner_principal: string;
  scope: "viewer" | "editor" | "runtime_peer" | "owner";
  created_at: string;
  updated_at: string;
  latest_revision_id: string | null;
  viewer_url: string;
  endpoints: {
    catalog: string;
    acl: string;
    access_requests: string;
  };
}

export interface CloudNotebookDashboardMetric {
  label: string;
  value: string;
  detail: string;
  icon: "notebooks" | "owned" | "published";
}

export interface CloudNotebookDashboardModel {
  continueNotebook: CloudNotebookListItem | null;
  metrics: readonly CloudNotebookDashboardMetric[];
  notebooks: readonly CloudNotebookListItem[];
}

export function projectCloudNotebookDashboard(
  notebooks: readonly CloudNotebookListItem[],
): CloudNotebookDashboardModel {
  const sorted = [...notebooks].sort((left, right) => {
    const leftTime = Date.parse(left.updated_at);
    const rightTime = Date.parse(right.updated_at);
    const timeOrder =
      (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
    return (
      timeOrder ||
      notebookScopeRank(right.scope) - notebookScopeRank(left.scope) ||
      left.notebook_id.localeCompare(right.notebook_id)
    );
  });
  const editableCount = notebooks.filter(
    (notebook) => notebook.scope === "owner" || notebook.scope === "editor",
  ).length;
  const ownerCount = notebooks.filter((notebook) => notebook.scope === "owner").length;
  const publishedCount = notebooks.filter((notebook) =>
    Boolean(notebook.latest_revision_id),
  ).length;

  return {
    continueNotebook: sorted[0] ?? null,
    notebooks: sorted,
    metrics: [
      {
        label: "Visible notebooks",
        value: String(notebooks.length),
        detail: `${editableCount} editable`,
        icon: "notebooks",
      },
      {
        label: "Owned",
        value: String(ownerCount),
        detail: "can manage access",
        icon: "owned",
      },
      {
        label: "Published",
        value: String(publishedCount),
        detail: "revision metadata",
        icon: "published",
      },
    ],
  };
}

export function cloudNotebookDisplayTitle(notebook: CloudNotebookListItem): string {
  return notebook.title?.trim() || "Untitled notebook";
}

export function cloudNotebookShortId(notebookId: string): string {
  const trimmed = notebookId.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function notebookScopeRank(scope: CloudNotebookListItem["scope"]): number {
  switch (scope) {
    case "owner":
      return 4;
    case "editor":
      return 3;
    case "runtime_peer":
      return 2;
    case "viewer":
      return 1;
  }
}
