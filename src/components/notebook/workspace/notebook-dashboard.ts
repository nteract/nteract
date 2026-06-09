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
  sections: readonly CloudNotebookDashboardSection[];
  sidebar: CloudNotebookDashboardSidebar;
}

export interface CloudNotebookDashboardSidebar {
  published: readonly CloudNotebookListItem[];
  access: {
    owned: number;
    editable: number;
    viewOnly: number;
  };
}

export interface CloudNotebookDashboardSection {
  action: CloudNotebookDashboardSectionAction | null;
  detail: string;
  id: "titled" | "untitled";
  notebooks: readonly CloudNotebookListItem[];
  title: string;
}

export interface CloudNotebookDashboardSectionAction {
  kind: "rename";
  label: string;
  notebook: CloudNotebookListItem;
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
  const titled = sorted.filter(cloudNotebookHasTitle);
  const untitled = sorted.filter((notebook) => !cloudNotebookHasTitle(notebook));
  const editableCount = notebooks.filter(
    (notebook) => notebook.scope === "owner" || notebook.scope === "editor",
  ).length;
  const ownerCount = notebooks.filter((notebook) => notebook.scope === "owner").length;
  const editorCount = notebooks.filter((notebook) => notebook.scope === "editor").length;
  const viewerCount = notebooks.filter((notebook) => notebook.scope === "viewer").length;
  const published = sorted.filter((notebook) => Boolean(notebook.latest_revision_id));
  const publishedCount = published.length;

  return {
    continueNotebook: titled[0] ?? sorted[0] ?? null,
    notebooks: sorted,
    sections: cloudNotebookDashboardSections({ titled, untitled }),
    metrics: [
      {
        label: "Visible notebooks",
        value: String(notebooks.length),
        detail: `${titled.length} titled, ${editableCount} editable`,
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
    sidebar: {
      published,
      access: {
        owned: ownerCount,
        editable: editorCount,
        viewOnly: viewerCount,
      },
    },
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

export function isCloudNotebookListItem(value: unknown): value is CloudNotebookListItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CloudNotebookListItem>;
  return (
    typeof candidate.notebook_id === "string" &&
    (candidate.title === null || typeof candidate.title === "string") &&
    typeof candidate.owner_principal === "string" &&
    isNotebookScope(candidate.scope) &&
    typeof candidate.created_at === "string" &&
    typeof candidate.updated_at === "string" &&
    (candidate.latest_revision_id === null || typeof candidate.latest_revision_id === "string") &&
    typeof candidate.viewer_url === "string" &&
    Boolean(candidate.endpoints) &&
    typeof candidate.endpoints?.catalog === "string" &&
    typeof candidate.endpoints?.acl === "string" &&
    typeof candidate.endpoints?.access_requests === "string"
  );
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

function cloudNotebookHasTitle(notebook: CloudNotebookListItem): boolean {
  return Boolean(notebook.title?.trim());
}

function cloudNotebookDashboardSections({
  titled,
  untitled,
}: {
  titled: readonly CloudNotebookListItem[];
  untitled: readonly CloudNotebookListItem[];
}): CloudNotebookDashboardSection[] {
  const sections: CloudNotebookDashboardSection[] = [];
  if (titled.length > 0) {
    sections.push({
      action: null,
      id: "titled",
      title: "Named notebooks",
      detail: `${titled.length} notebook${titled.length === 1 ? "" : "s"} with titles`,
      notebooks: titled,
    });
  }
  if (untitled.length > 0) {
    const nextRenameable = untitled.find(cloudNotebookCanRename);
    sections.push({
      action: nextRenameable
        ? {
            kind: "rename",
            label: "Title next",
            notebook: nextRenameable,
          }
        : null,
      id: "untitled",
      title: titled.length > 0 ? "Untitled notebooks" : "Notebooks",
      detail:
        titled.length > 0
          ? "Scratch rooms and older notebooks without titles. Rename the ones worth keeping."
          : "Rename notebooks you want to keep at the top of your home.",
      notebooks: untitled,
    });
  }
  return sections;
}

function cloudNotebookCanRename(notebook: CloudNotebookListItem): boolean {
  return notebook.scope === "owner" || notebook.scope === "editor";
}

function isNotebookScope(value: unknown): value is CloudNotebookListItem["scope"] {
  return value === "viewer" || value === "editor" || value === "runtime_peer" || value === "owner";
}
