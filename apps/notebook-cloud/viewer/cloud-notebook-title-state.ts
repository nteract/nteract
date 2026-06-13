import { notebookRouteSegmentTitle } from "../src/notebook-route-title";

export interface CloudNotebookRouteTitle {
  label: string;
  detail: string | null;
  title: string;
}

export interface CloudNotebookTitleDisplay {
  label: string;
  detail: string | null;
  title: string;
}

export interface CloudNotebookCatalogResponse {
  notebook?: {
    id?: unknown;
    title?: unknown;
  };
}

const UNTITLED_NOTEBOOK_LABEL = "Untitled notebook";

export function cloudNotebookTitleDisplay(
  catalogTitle: string | null | undefined,
  fallback: CloudNotebookRouteTitle,
): CloudNotebookTitleDisplay {
  if (catalogTitle === undefined) {
    return fallback;
  }

  const label = catalogTitle?.trim() || UNTITLED_NOTEBOOK_LABEL;
  return {
    label,
    detail: null,
    title: label,
  };
}

export function cloudNotebookDocumentTitle(displayTitle: string): string {
  return `nteract notebook: ${displayTitle.trim() || UNTITLED_NOTEBOOK_LABEL}`;
}

export function cloudNotebookRouteTitleFromPathname(pathname: string): CloudNotebookTitleDisplay {
  const pathParts = pathname.split("/").filter(Boolean);
  const routeSlug = pathParts[0] === "n" ? pathParts[2] : null;
  const routeTitle = notebookRouteSegmentTitle(routeSlug);

  if (routeTitle) {
    return {
      label: routeTitle,
      detail: null,
      title: routeTitle,
    };
  }

  return {
    label: "Cloud Notebook",
    detail: null,
    title: "Cloud Notebook",
  };
}

export function cloudNotebookCatalogResponseTitle(
  body: CloudNotebookCatalogResponse,
  notebookId: string,
): string | null {
  const notebook = body.notebook;
  if (!notebook || notebook.id !== notebookId) {
    throw new Error("Unable to load notebook title: response shape was invalid");
  }
  if (notebook.title === null || typeof notebook.title === "string") {
    return notebook.title;
  }
  throw new Error("Unable to load notebook title: response shape was invalid");
}

export function cloudNotebookUrlAfterRename(currentHref: string, viewerUrl: string): string {
  try {
    const currentUrl = new URL(currentHref);
    const renamedUrl = new URL(viewerUrl, currentUrl.origin);
    if (!renamedUrl.pathname.startsWith("/n/")) {
      return currentHref;
    }
    currentUrl.pathname = renamedUrl.pathname;
    return currentUrl.href;
  } catch {
    return currentHref;
  }
}
