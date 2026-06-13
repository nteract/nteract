export type CloudNotebookUrlMode = "edit" | "view";

export function cloudNotebookInteractionModeForAccess({
  accessRequestStatus,
  catalogResolved = false,
  accessScope,
  connectionScope,
  selectedMode,
}: {
  accessRequestStatus?: string | null;
  catalogResolved?: boolean;
  accessScope?: string | null;
  connectionScope: string | null;
  selectedMode: CloudNotebookUrlMode;
}): CloudNotebookUrlMode {
  if (selectedMode !== "edit") {
    return selectedMode;
  }
  if (accessScope === "editor" || accessScope === "owner") {
    return "edit";
  }
  if (accessRequestStatus === "pending" || accessRequestStatus === "approved") {
    return "edit";
  }
  if (catalogResolved && !accessScope) {
    return "view";
  }
  if (connectionScope !== "viewer") {
    return selectedMode;
  }
  return "view";
}

export function cloudNotebookSelectedModeCorrectionForAccess({
  accessMode,
  selectedMode,
}: {
  accessMode: CloudNotebookUrlMode;
  selectedMode: CloudNotebookUrlMode;
}): CloudNotebookUrlMode | null {
  if (selectedMode === "edit" && accessMode === "view") {
    return "view";
  }
  return null;
}

export function cloudNotebookModeFromSearch(search: string): CloudNotebookUrlMode {
  const params = new URLSearchParams(search);
  return normalizeCloudNotebookMode(params.get("mode"));
}

export function cloudNotebookUrlWithMode(href: string, mode: CloudNotebookUrlMode): string {
  const trimmed = href.trim();
  if (!trimmed) {
    return `?mode=${mode}`;
  }

  try {
    const parsed = new URL(trimmed, "https://nteract.invalid");
    parsed.searchParams.set("mode", mode);
    if (isAbsoluteUrl(trimmed) || trimmed.startsWith("//")) {
      return parsed.href;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    const joiner = trimmed.includes("?") ? "&" : "?";
    return `${trimmed}${joiner}mode=${encodeURIComponent(mode)}`;
  }
}

export function replaceCloudNotebookModeInCurrentUrl(mode: CloudNotebookUrlMode): void {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("mode", mode);
  const next = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== current) {
    window.history.replaceState(window.history.state, "", next);
  }
}

function normalizeCloudNotebookMode(value: string | null): CloudNotebookUrlMode {
  return value === "edit" ? "edit" : "view";
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+\-.]*:/i.test(value);
}
