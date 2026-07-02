import { cloudNotebookUrlWithMode, type CloudNotebookUrlMode } from "./cloud-notebook-mode";
import {
  isNotebookComputeSessionSummary,
  projectNotebookComputeSessionFact,
  type NotebookComputeSessionSummary,
} from "runtimed";

export interface CloudNotebookListItem {
  notebook_id: string;
  title: string | null;
  owner_principal: string;
  scope: "viewer" | "editor" | "runtime_peer" | "owner";
  created_at: string;
  updated_at: string;
  latest_revision_id: string | null;
  compute_session?: NotebookComputeSessionSummary | null;
  composition?: CloudNotebookComposition;
  language?: string;
  viewer_url: string;
  endpoints: {
    catalog: string;
    acl: string;
    access_requests: string;
  };
}

export interface CloudNotebookComposition {
  code: number;
  markdown: number;
  raw: number;
}

export type CloudNotebookDashboardRuntimeStatus =
  | "executing"
  | "ready"
  | "starting"
  | "stale"
  | "error"
  | "none";

export type CloudNotebookDashboardFilterId =
  | "all"
  | "owned"
  | "shared"
  | "compute"
  | "published"
  | "generated"
  | "untitled";

export interface CloudNotebookDashboardFilter {
  count: number;
  group: CloudNotebookDashboardFilterGroupId;
  id: CloudNotebookDashboardFilterId;
  label: string;
}

export type CloudNotebookDashboardFilterGroupId = "work" | "cleanup";

export interface CloudNotebookDashboardFilterGroup {
  filters: readonly CloudNotebookDashboardFilter[];
  id: CloudNotebookDashboardFilterGroupId;
  label: string;
}

export interface CloudNotebookDashboardModel {
  continueNotebook: CloudNotebookListItem | null;
  continueRow: CloudNotebookDashboardRow | null;
  filterGroups: readonly CloudNotebookDashboardFilterGroup[];
  filters: readonly CloudNotebookDashboardFilter[];
  notebooks: readonly CloudNotebookListItem[];
}

export interface CloudNotebookDashboardSection {
  action: CloudNotebookDashboardSectionAction | null;
  detail: string;
  id: string;
  notebooks: readonly CloudNotebookListItem[];
  overflowAction?: CloudNotebookDashboardSectionFilterAction | null;
  rows: readonly CloudNotebookDashboardRow[];
  title: string;
  totalCount: number;
}

export interface CloudNotebookDashboardRow {
  composition?: CloudNotebookComposition;
  contextLabel: string | null;
  environmentLabel?: string;
  facts: readonly CloudNotebookDashboardRowFact[];
  identityLabel: string | null;
  notebook: CloudNotebookListItem;
  ownerInitials: string;
  ownerLabel: string;
  runtimeStatus: CloudNotebookDashboardRuntimeStatus;
}

export interface CloudNotebookDashboardRowFact {
  kind: "access" | "compute" | "published";
  label: string;
  tone?: "active" | "starting" | "stale" | "error";
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
  filterGroups: readonly CloudNotebookDashboardFilterGroup[];
  filters: readonly CloudNotebookDashboardFilter[];
  query: string;
  resultCount: number;
  sections: readonly CloudNotebookDashboardSection[];
  showResultCount: boolean;
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
  const filters = cloudNotebookDashboardFilters(notebooks);

  return {
    continueNotebook: namedWork[0] ?? titled[0] ?? sorted[0] ?? null,
    continueRow: dashboardRow(namedWork[0] ?? titled[0] ?? sorted[0] ?? null),
    filterGroups: cloudNotebookDashboardFilterGroups(filters),
    filters,
    notebooks: sorted,
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
  const searched = model.notebooks.filter((notebook) =>
    cloudNotebookMatchesSearch(notebook, query),
  );
  const filters = cloudNotebookVisibleDashboardFilters(
    cloudNotebookDashboardFiltersWithCounts(model.filters, searched),
    { filterId, query },
  );
  const filtered = searched.filter((notebook) => cloudNotebookMatchesFilter(notebook, filterId));

  return {
    emptyMessage: cloudNotebookDashboardEmptyMessage(filterId, query, filtered.length),
    filterId,
    filterGroups: cloudNotebookDashboardFilterGroups(filters),
    filters,
    query,
    resultCount: filtered.length,
    sections: cloudNotebookDashboardSections(filtered, {
      continueNotebookId:
        filterId === "all" && query.length === 0
          ? (model.continueNotebook?.notebook_id ?? null)
          : null,
      filterId,
      query,
    }),
    showResultCount: filterId !== "all" || query.length > 0,
  };
}

export function cloudNotebookDisplayTitle(notebook: CloudNotebookListItem): string {
  return notebook.title?.trim() || "Untitled notebook";
}

export function cloudNotebookDashboardOpenUrl(
  notebook: CloudNotebookListItem,
  options: { browserOrigin?: string | null } = {},
): string {
  return cloudNotebookOpenUrlWithMode(notebook.viewer_url, cloudNotebookDefaultOpenMode(notebook), {
    browserOrigin: options.browserOrigin,
  });
}

export function cloudNotebookOpenUrlWithMode(
  viewerUrl: string,
  mode: CloudNotebookUrlMode,
  options: { browserOrigin?: string | null } = {},
): string {
  return cloudNotebookViewerUrlOnBrowserOrigin(
    cloudNotebookUrlWithMode(viewerUrl, mode),
    options.browserOrigin ?? currentBrowserOrigin(),
  );
}

export function cloudNotebookViewerUrlOnBrowserOrigin(
  viewerUrl: string,
  browserOrigin: string | null | undefined,
): string {
  if (!browserOrigin) {
    return viewerUrl;
  }
  try {
    const origin = new URL(browserOrigin);
    const url = new URL(viewerUrl, origin);
    if (!url.pathname.startsWith("/n/")) {
      return viewerUrl;
    }
    url.protocol = origin.protocol;
    url.host = origin.host;
    return url.href;
  } catch {
    return viewerUrl;
  }
}

export function cloudNotebookShortId(notebookId: string): string {
  const trimmed = notebookId.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

export function cloudNotebookLanguageDisplayLabel(
  language: string | null | undefined,
): string | null {
  switch (language) {
    case "python":
      return "Python";
    case "deno":
      return "Deno";
    default:
      return null;
  }
}

function cloudNotebookDefaultOpenMode(notebook: CloudNotebookListItem): CloudNotebookUrlMode {
  return notebook.scope === "owner" || notebook.scope === "editor" ? "edit" : "view";
}

function currentBrowserOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
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
    (candidate.compute_session === undefined ||
      candidate.compute_session === null ||
      isNotebookComputeSessionSummary(candidate.compute_session)) &&
    (candidate.composition === undefined || isCloudNotebookComposition(candidate.composition)) &&
    (candidate.language === undefined || typeof candidate.language === "string") &&
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

function cloudNotebookDashboardFilters(
  notebooks: readonly CloudNotebookListItem[],
): CloudNotebookDashboardFilter[] {
  const generatedCount = notebooks.filter(cloudNotebookIsGeneratedRun).length;
  const ownerCount = notebooks.filter((notebook) => notebook.scope === "owner").length;
  const computeCount = notebooks.filter(cloudNotebookHasComputeSession).length;
  const publishedCount = notebooks.filter((notebook) =>
    Boolean(notebook.latest_revision_id),
  ).length;
  const sharedCount = notebooks.filter((notebook) => notebook.scope !== "owner").length;
  const untitledCount = notebooks.filter((notebook) => !cloudNotebookHasTitle(notebook)).length;
  const filters: CloudNotebookDashboardFilter[] = [
    { id: "all", label: "Recent", count: notebooks.length, group: "work" },
  ];
  if (ownerCount > 0) {
    filters.push({ id: "owned", label: "Owned", count: ownerCount, group: "work" });
  }
  if (sharedCount > 0) {
    filters.push({ id: "shared", label: "Shared with me", count: sharedCount, group: "work" });
  }
  if (computeCount > 0) {
    filters.push({ id: "compute", label: "Compute", count: computeCount, group: "work" });
  }
  if (publishedCount > 0) {
    filters.push({ id: "published", label: "Published", count: publishedCount, group: "work" });
  }
  if (generatedCount > 0) {
    filters.push({ id: "generated", label: "Generated", count: generatedCount, group: "cleanup" });
  }
  if (untitledCount > 0) {
    filters.push({ id: "untitled", label: "Untitled", count: untitledCount, group: "cleanup" });
  }
  return filters;
}

function cloudNotebookDashboardFiltersWithCounts(
  filters: readonly CloudNotebookDashboardFilter[],
  notebooks: readonly CloudNotebookListItem[],
): CloudNotebookDashboardFilter[] {
  return filters.map((filter) => ({
    ...filter,
    count: notebooks.filter((notebook) => cloudNotebookMatchesFilter(notebook, filter.id)).length,
  }));
}

function cloudNotebookVisibleDashboardFilters(
  filters: readonly CloudNotebookDashboardFilter[],
  context: { filterId: CloudNotebookDashboardFilterId; query: string },
): CloudNotebookDashboardFilter[] {
  if (context.query.length === 0) {
    return [...filters];
  }
  return filters.filter(
    (filter) => filter.id === "all" || filter.id === context.filterId || filter.count > 0,
  );
}

function cloudNotebookDashboardFilterGroups(
  filters: readonly CloudNotebookDashboardFilter[],
): CloudNotebookDashboardFilterGroup[] {
  const work = filters.filter((filter) => filter.group === "work");
  const cleanup = filters.filter((filter) => filter.group === "cleanup");
  const groups: CloudNotebookDashboardFilterGroup[] = [];
  if (work.length > 0) {
    groups.push({ id: "work", label: "Notebook views", filters: Object.freeze(work) });
  }
  if (cleanup.length > 0) {
    groups.push({ id: "cleanup", label: "Cleanup filters", filters: Object.freeze(cleanup) });
  }
  return groups;
}

function cloudNotebookDashboardSections(
  notebooks: readonly CloudNotebookListItem[],
  context: {
    continueNotebookId: string | null;
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

  if (context.filterId === "compute") {
    sections.push(computeNotebookSection(notebooks));
    return sections;
  }

  if (context.query.length === 0 && (context.filterId === "all" || context.filterId === "owned")) {
    return cloudNotebookWorkSections(notebooks, { omitNotebookId: context.continueNotebookId });
  }

  if (context.query.length > 0) {
    return [
      {
        action: null,
        detail: bucketDetail(notebooks.length, "matching search"),
        id: "search",
        notebooks,
        overflowAction: null,
        rows: dashboardRows(notebooks),
        title: "Search results",
        totalCount: notebooks.length,
      },
    ];
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
      rows: dashboardRows(bucket.notebooks),
      title: bucket.title,
      totalCount: bucket.totalCount,
    });
  }
  return sections;
}

const SECONDARY_DASHBOARD_SECTION_LIMIT = 5;

function cloudNotebookWorkSections(
  notebooks: readonly CloudNotebookListItem[],
  options: { omitNotebookId: string | null },
): CloudNotebookDashboardSection[] {
  const namedWork = notebooks.filter((notebook) => {
    if (notebook.notebook_id === options.omitNotebookId) {
      return false;
    }
    return (
      notebook.scope === "owner" &&
      cloudNotebookHasTitle(notebook) &&
      !cloudNotebookIsGeneratedRun(notebook)
    );
  });
  const sharedWithMe = notebooks.filter(
    (notebook) =>
      notebook.scope !== "owner" &&
      cloudNotebookHasTitle(notebook) &&
      !cloudNotebookIsGeneratedRun(notebook),
  );
  const generatedRuns = notebooks.filter(cloudNotebookIsGeneratedRun);
  const untitled = notebooks.filter((notebook) => !cloudNotebookHasTitle(notebook));

  const sections: CloudNotebookDashboardSection[] = [];
  if (namedWork.length > 0) {
    sections.push({
      action: null,
      detail: remainingNotebookDetail(namedWork.length),
      id: "named",
      notebooks: namedWork,
      overflowAction: null,
      rows: dashboardRows(namedWork),
      title: "Recent work",
      totalCount: namedWork.length,
    });
  }
  if (sharedWithMe.length > 0) {
    sections.push(
      sharedWithMeNotebookSection(sharedWithMe, { limit: SECONDARY_DASHBOARD_SECTION_LIMIT }),
    );
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

function sharedWithMeNotebookSection(
  notebooks: readonly CloudNotebookListItem[],
  options: { limit: number | null },
): CloudNotebookDashboardSection {
  const visibleNotebooks = limitNotebooks(notebooks, options.limit);
  const overflowAction =
    options.limit && notebooks.length > visibleNotebooks.length
      ? {
          filterId: "shared" as const,
          kind: "filter" as const,
          label: "View all shared",
        }
      : null;
  return {
    action: overflowAction,
    detail: bucketDetail(notebooks.length, "shared with this account"),
    id: "shared",
    notebooks: visibleNotebooks,
    overflowAction,
    rows: dashboardRows(visibleNotebooks),
    title: "Shared with me",
    totalCount: notebooks.length,
  };
}

function computeNotebookSection(
  notebooks: readonly CloudNotebookListItem[],
): CloudNotebookDashboardSection {
  return {
    action: null,
    detail: bucketDetail(notebooks.length, "with compute state"),
    id: "compute",
    notebooks,
    overflowAction: null,
    rows: dashboardRows(notebooks),
    title: "Active compute",
    totalCount: notebooks.length,
  };
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
    rows: dashboardRows(visibleNotebooks),
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
    rows: dashboardRows(visibleNotebooks),
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

function dashboardRows(notebooks: readonly CloudNotebookListItem[]): CloudNotebookDashboardRow[] {
  return notebooks
    .map(dashboardRow)
    .filter((row): row is CloudNotebookDashboardRow => Boolean(row));
}

function dashboardRow(notebook: CloudNotebookListItem | null): CloudNotebookDashboardRow | null {
  if (!notebook) {
    return null;
  }
  const ownerLabel = cloudNotebookOwnerLabel(notebook.owner_principal);
  return {
    ...(notebook.composition ? { composition: notebook.composition } : {}),
    contextLabel: cloudNotebookDashboardRowContextLabel(notebook),
    ...(notebook.compute_session?.environment_label
      ? { environmentLabel: notebook.compute_session.environment_label }
      : {}),
    facts: Object.freeze(cloudNotebookDashboardRowFacts(notebook)),
    identityLabel: cloudNotebookHasTitle(notebook)
      ? null
      : cloudNotebookShortId(notebook.notebook_id),
    notebook,
    ownerInitials: cloudNotebookOwnerInitials(ownerLabel),
    ownerLabel,
    runtimeStatus: cloudNotebookDashboardRuntimeStatus(notebook),
  };
}

export function cloudNotebookDashboardRuntimeStatus(
  notebook: CloudNotebookListItem,
): CloudNotebookDashboardRuntimeStatus {
  const session = notebook.compute_session;
  if (!session) {
    return "none";
  }
  switch (session.status) {
    case "starting":
      return "starting";
    case "stale":
      return "stale";
    case "error":
      return "error";
    case "active":
      return session.queue_depth > 0 ? "executing" : "ready";
  }
}

function cloudNotebookDashboardRowContextLabel(notebook: CloudNotebookListItem): string | null {
  if (!cloudNotebookHasTitle(notebook)) {
    return "Needs title";
  }
  if (cloudNotebookIsGeneratedRun(notebook)) {
    return "Generated run";
  }
  switch (notebook.scope) {
    case "editor":
      return "Shared notebook";
    case "viewer":
      return "Shared notebook";
    case "runtime_peer":
      return "Runtime peer access";
    case "owner":
      break;
  }
  return null;
}

function cloudNotebookDashboardRowFacts(
  notebook: CloudNotebookListItem,
): CloudNotebookDashboardRowFact[] {
  const facts: CloudNotebookDashboardRowFact[] = [];
  const computeFact = projectNotebookComputeSessionFact(notebook.compute_session);
  if (computeFact) {
    facts.push({
      kind: "compute",
      label: computeFact.label,
      tone: computeFact.tone,
    });
  }
  switch (notebook.scope) {
    case "editor":
      facts.push({ kind: "access", label: "editor" });
      break;
    case "viewer":
      facts.push({ kind: "access", label: "viewer" });
      break;
    case "runtime_peer":
      facts.push({ kind: "access", label: "runtime" });
      break;
    case "owner":
      break;
  }
  if (notebook.latest_revision_id) {
    facts.push({ kind: "published", label: "Published" });
  }
  return facts;
}

function cloudNotebookIsGeneratedRun(notebook: CloudNotebookListItem): boolean {
  const title = notebook.title?.trim() ?? "";
  return (
    /^Sync Recovery Smoke$/u.test(title) ||
    /^Toolbar attach smoke 20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(title) ||
    /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(title)
  );
}

function cloudNotebookHasComputeSession(notebook: CloudNotebookListItem): boolean {
  return Boolean(notebook.compute_session);
}

function isCloudNotebookComposition(value: unknown): value is CloudNotebookComposition {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CloudNotebookComposition>;
  return (
    isNonNegativeFiniteNumber(candidate.code) &&
    isNonNegativeFiniteNumber(candidate.markdown) &&
    isNonNegativeFiniteNumber(candidate.raw)
  );
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function cloudNotebookOwnerLabel(principal: string): string {
  const trimmed = principal.trim();
  if (!trimmed) {
    return "Unknown";
  }
  const emailLocal = trimmed.match(/([^:@\s]+)@[^@\s]+$/u)?.[1];
  if (emailLocal) {
    return emailLocal;
  }
  const parts = trimmed.split(":").filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

function cloudNotebookOwnerInitials(label: string): string {
  const normalized = label
    .replace(/[_+.-]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const initials =
    normalized.length >= 2
      ? `${normalized[0]?.[0] ?? ""}${normalized[1]?.[0] ?? ""}`
      : (normalized[0]?.slice(0, 2) ?? label.slice(0, 2));
  return initials.toUpperCase() || "??";
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
    case "compute":
      return cloudNotebookHasComputeSession(notebook);
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
    notebook.compute_session ? "compute runtime workstation active starting stale" : null,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return searchable.includes(query);
}

function cloudNotebookDashboardEmptyMessage(
  filterId: CloudNotebookDashboardFilterId,
  query: string,
  resultCount: number,
): string {
  if (query) {
    return "No notebooks match that search.";
  }
  switch (filterId) {
    case "all":
      return resultCount > 0 ? "No other notebooks yet." : "No notebooks yet.";
    case "owned":
      return "No owned notebooks yet.";
    case "shared":
      return "No notebooks have been shared with this account.";
    case "compute":
      return "No notebooks have active compute state.";
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

function remainingNotebookDetail(count: number): string {
  return `${count} more notebook${count === 1 ? "" : "s"} to reopen`;
}

function startOfUtcDay(time: number): number {
  const date = new Date(time);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isNotebookScope(value: unknown): value is CloudNotebookListItem["scope"] {
  return value === "viewer" || value === "editor" || value === "runtime_peer" || value === "owner";
}
