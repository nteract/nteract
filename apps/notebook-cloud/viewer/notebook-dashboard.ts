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

export type CloudNotebookDashboardFilterId =
  | "all"
  | "owned"
  | "shared"
  | "published"
  | "generated"
  | "untitled";

export interface CloudNotebookDashboardFilter {
  count: number;
  id: CloudNotebookDashboardFilterId;
  label: string;
}

export interface CloudNotebookDashboardModel {
  continueNotebook: CloudNotebookListItem | null;
  filters: readonly CloudNotebookDashboardFilter[];
  metrics: readonly CloudNotebookDashboardMetric[];
  notebooks: readonly CloudNotebookListItem[];
}

export interface CloudNotebookDashboardSection {
  action: CloudNotebookDashboardSectionAction | null;
  detail: string;
  id: string;
  notebooks: readonly CloudNotebookListItem[];
  overflowAction?: CloudNotebookDashboardSectionFilterAction | null;
  title: string;
  totalCount: number;
}

export interface CloudNotebookDashboardSectionFilterAction {
  filterId: CloudNotebookDashboardFilterId;
  kind: "filter";
  label: string;
}

export type CloudNotebookDashboardSectionAction =
  | CloudNotebookDashboardSectionFilterAction
  | {
      kind: "rename";
      label: string;
      notebook: CloudNotebookListItem;
    };

export interface CloudNotebookDashboardView {
  emptyMessage: string;
  filterId: CloudNotebookDashboardFilterId;
  query: string;
  resultCount: number;
  sections: readonly CloudNotebookDashboardSection[];
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
  const namedWork = titled.filter((notebook) => !cloudNotebookIsGeneratedRun(notebook));
  const generatedCount = sorted.filter(cloudNotebookIsGeneratedRun).length;
  const untitled = sorted.filter((notebook) => !cloudNotebookHasTitle(notebook));
  const editableCount = notebooks.filter(
    (notebook) => notebook.scope === "owner" || notebook.scope === "editor",
  ).length;
  const ownerCount = notebooks.filter((notebook) => notebook.scope === "owner").length;
  const publishedCount = notebooks.filter((notebook) =>
    Boolean(notebook.latest_revision_id),
  ).length;

  return {
    continueNotebook: namedWork[0] ?? titled[0] ?? sorted[0] ?? null,
    filters: cloudNotebookDashboardFilters({
      notebooks,
      generatedCount,
      ownerCount,
      publishedCount,
      untitledCount: untitled.length,
    }),
    notebooks: sorted,
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
  };
}

export function projectCloudNotebookDashboardView(
  model: CloudNotebookDashboardModel,
  input?: {
    filterId?: CloudNotebookDashboardFilterId | null;
    query?: string | null;
  },
): CloudNotebookDashboardView {
  const filterId = model.filters.some((filter) => filter.id === input?.filterId)
    ? (input?.filterId ?? "all")
    : "all";
  const query = normalizeSearchQuery(input?.query);
  const filtered = model.notebooks
    .filter((notebook) => cloudNotebookMatchesFilter(notebook, filterId))
    .filter((notebook) => cloudNotebookMatchesSearch(notebook, query));

  return {
    emptyMessage: cloudNotebookDashboardEmptyMessage(filterId, query),
    filterId,
    query,
    resultCount: filtered.length,
    sections: cloudNotebookDashboardSections(filtered, { filterId, query }),
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

function cloudNotebookDashboardFilters({
  generatedCount,
  notebooks,
  ownerCount,
  publishedCount,
  untitledCount,
}: {
  generatedCount: number;
  notebooks: readonly CloudNotebookListItem[];
  ownerCount: number;
  publishedCount: number;
  untitledCount: number;
}): CloudNotebookDashboardFilter[] {
  const filters: CloudNotebookDashboardFilter[] = [
    { id: "all", label: "Recent", count: notebooks.length },
    { id: "owned", label: "Owned", count: ownerCount },
    {
      id: "shared",
      label: "Shared",
      count: notebooks.filter((notebook) => notebook.scope !== "owner").length,
    },
    { id: "published", label: "Published", count: publishedCount },
  ];
  if (generatedCount > 0) {
    filters.push({ id: "generated", label: "Generated", count: generatedCount });
  }
  filters.push({ id: "untitled", label: "Untitled", count: untitledCount });
  return filters;
}

function cloudNotebookDashboardSections(
  notebooks: readonly CloudNotebookListItem[],
  context: {
    filterId: CloudNotebookDashboardFilterId;
    query: string;
  },
): CloudNotebookDashboardSection[] {
  const sections: CloudNotebookDashboardSection[] = [];
  if (notebooks.length === 0) {
    return sections;
  }

  if (context.filterId === "untitled") {
    sections.push(untitledNotebookSection(notebooks, { limit: null }));
    return sections;
  }

  if (context.filterId === "generated") {
    sections.push(generatedNotebookSection(notebooks, { limit: null }));
    return sections;
  }

  if (context.query.length === 0 && (context.filterId === "all" || context.filterId === "owned")) {
    return cloudNotebookWorkSections(notebooks);
  }

  const buckets = activityBuckets(notebooks);
  for (const bucket of buckets) {
    if (bucket.notebooks.length === 0) continue;
    sections.push({
      action: null,
      detail: bucket.detail,
      id: bucket.id,
      notebooks: bucket.notebooks,
      overflowAction: null,
      title: context.query.length > 0 && bucket.id === "latest" ? "Search results" : bucket.title,
      totalCount: bucket.totalCount,
    });
  }
  return sections;
}

const SECONDARY_DASHBOARD_SECTION_LIMIT = 5;

function cloudNotebookWorkSections(
  notebooks: readonly CloudNotebookListItem[],
): CloudNotebookDashboardSection[] {
  const namedWork = notebooks.filter(
    (notebook) => cloudNotebookHasTitle(notebook) && !cloudNotebookIsGeneratedRun(notebook),
  );
  const generatedRuns = notebooks.filter(cloudNotebookIsGeneratedRun);
  const untitled = notebooks.filter((notebook) => !cloudNotebookHasTitle(notebook));

  const sections: CloudNotebookDashboardSection[] = [];
  if (namedWork.length > 0) {
    sections.push({
      action: null,
      detail: bucketDetail(namedWork.length, "ready to reopen"),
      id: "named",
      notebooks: namedWork,
      overflowAction: null,
      title: "Recent work",
      totalCount: namedWork.length,
    });
  }
  if (generatedRuns.length > 0) {
    sections.push(
      generatedNotebookSection(generatedRuns, { limit: SECONDARY_DASHBOARD_SECTION_LIMIT }),
    );
  }
  if (untitled.length > 0) {
    sections.push(untitledNotebookSection(untitled, { limit: SECONDARY_DASHBOARD_SECTION_LIMIT }));
  }
  return sections;
}

function generatedNotebookSection(
  notebooks: readonly CloudNotebookListItem[],
  options: { limit: number | null },
): CloudNotebookDashboardSection {
  const visibleNotebooks = limitNotebooks(notebooks, options.limit);
  const overflowAction =
    options.limit && notebooks.length > visibleNotebooks.length
      ? {
          filterId: "generated" as const,
          kind: "filter" as const,
          label: "Review generated",
        }
      : null;
  return {
    action: overflowAction,
    detail: bucketDetail(notebooks.length, "from smoke and debug work"),
    id: "generated",
    notebooks: visibleNotebooks,
    overflowAction,
    title: "Generated runs",
    totalCount: notebooks.length,
  };
}

function untitledNotebookSection(
  notebooks: readonly CloudNotebookListItem[],
  options: { limit: number | null },
): CloudNotebookDashboardSection {
  const nextRenameable = notebooks.find(cloudNotebookCanRename);
  const visibleNotebooks = limitNotebooks(notebooks, options.limit);
  return {
    action: nextRenameable
      ? {
          kind: "rename",
          label: "Title next",
          notebook: nextRenameable,
        }
      : null,
    id: "untitled",
    title: "Needs title",
    detail: "Rename notebooks worth keeping so they stay easy to find.",
    notebooks: visibleNotebooks,
    overflowAction:
      options.limit && notebooks.length > visibleNotebooks.length
        ? {
            filterId: "untitled",
            kind: "filter",
            label: "Review untitled",
          }
        : null,
    totalCount: notebooks.length,
  };
}

function limitNotebooks(
  notebooks: readonly CloudNotebookListItem[],
  limit: number | null,
): readonly CloudNotebookListItem[] {
  return limit === null ? notebooks : notebooks.slice(0, limit);
}

function cloudNotebookCanRename(notebook: CloudNotebookListItem): boolean {
  return notebook.scope === "owner" || notebook.scope === "editor";
}

function cloudNotebookIsGeneratedRun(notebook: CloudNotebookListItem): boolean {
  const title = notebook.title?.trim() ?? "";
  return (
    /\b(?:smoke|debug|latency)\b/iu.test(title) || /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(title)
  );
}

function cloudNotebookMatchesFilter(
  notebook: CloudNotebookListItem,
  filterId: CloudNotebookDashboardFilterId,
): boolean {
  switch (filterId) {
    case "all":
      return true;
    case "owned":
      return notebook.scope === "owner";
    case "shared":
      return notebook.scope !== "owner";
    case "published":
      return Boolean(notebook.latest_revision_id);
    case "generated":
      return cloudNotebookIsGeneratedRun(notebook);
    case "untitled":
      return !cloudNotebookHasTitle(notebook);
  }
}

function cloudNotebookMatchesSearch(notebook: CloudNotebookListItem, query: string): boolean {
  if (!query) return true;
  const searchable = [
    notebook.title,
    notebook.notebook_id,
    notebook.scope,
    notebook.latest_revision_id ? "published" : "private",
    cloudNotebookDisplayTitle(notebook),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return searchable.includes(query);
}

function cloudNotebookDashboardEmptyMessage(
  filterId: CloudNotebookDashboardFilterId,
  query: string,
): string {
  if (query) {
    return "No notebooks match that search.";
  }
  switch (filterId) {
    case "all":
      return "No notebooks yet.";
    case "owned":
      return "No owned notebooks yet.";
    case "shared":
      return "No notebooks have been shared with this account.";
    case "published":
      return "No published notebooks yet.";
    case "generated":
      return "No generated runs.";
    case "untitled":
      return "No untitled notebooks.";
  }
}

function normalizeSearchQuery(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function activityBuckets(notebooks: readonly CloudNotebookListItem[]): {
  detail: string;
  id: "latest" | "recent" | "earlier";
  notebooks: CloudNotebookListItem[];
  title: string;
  totalCount: number;
}[] {
  const anchorTime = notebooks.reduce((latest, notebook) => {
    const time = Date.parse(notebook.updated_at);
    return Number.isNaN(time) ? latest : Math.max(latest, time);
  }, 0);
  if (anchorTime <= 0) {
    return [
      {
        id: "latest",
        title: "Recent notebooks",
        detail: `${notebooks.length} notebook${notebooks.length === 1 ? "" : "s"}`,
        notebooks: [...notebooks],
        totalCount: notebooks.length,
      },
    ];
  }

  const anchorDay = startOfUtcDay(anchorTime);
  const latest: CloudNotebookListItem[] = [];
  const recent: CloudNotebookListItem[] = [];
  const earlier: CloudNotebookListItem[] = [];

  for (const notebook of notebooks) {
    const updated = Date.parse(notebook.updated_at);
    if (Number.isNaN(updated)) {
      earlier.push(notebook);
      continue;
    }
    const ageDays = Math.floor((anchorDay - startOfUtcDay(updated)) / 86_400_000);
    if (ageDays <= 0) {
      latest.push(notebook);
    } else if (ageDays <= 7) {
      recent.push(notebook);
    } else {
      earlier.push(notebook);
    }
  }

  return [
    {
      id: "latest",
      title: "Latest activity",
      detail: bucketDetail(latest.length, "updated most recently"),
      notebooks: latest,
      totalCount: latest.length,
    },
    {
      id: "recent",
      title: "Previous activity",
      detail: bucketDetail(recent.length, "from the last week"),
      notebooks: recent,
      totalCount: recent.length,
    },
    {
      id: "earlier",
      title: "Earlier",
      detail: bucketDetail(earlier.length, "older notebooks"),
      notebooks: earlier,
      totalCount: earlier.length,
    },
  ];
}

function bucketDetail(count: number, label: string): string {
  return `${count} notebook${count === 1 ? "" : "s"} ${label}`;
}

function startOfUtcDay(time: number): number {
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isNotebookScope(value: unknown): value is CloudNotebookListItem["scope"] {
  return value === "viewer" || value === "editor" || value === "runtime_peer" || value === "owner";
}
