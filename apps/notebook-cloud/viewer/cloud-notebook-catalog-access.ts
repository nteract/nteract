import type { ConnectionScope } from "../src/auth-shared";
import type { NotebookInteractionMode } from "@/components/notebook";
import { CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC } from "./connection-diagnostics";
import type { CloudNotebookCatalogResponse } from "./cloud-notebook-title-state";
import { isCloudNotebookListItem, type CloudNotebookListItem } from "./notebook-dashboard";

export type CloudNotebookCatalogAccessScope = Exclude<
  CloudNotebookListItem["scope"],
  "runtime_peer"
>;

export interface CloudNotebookAccessScopeProjectionInput {
  catalogScope?: CloudNotebookCatalogAccessScope | null;
  connectionReady: boolean;
  connectionScope: string | null;
}

export interface CloudNotebookCatalogAccessLoadResult {
  catalogResolved: boolean;
  catalogScope: CloudNotebookCatalogAccessScope | null;
  catalogTitle?: string | null;
}

export type CloudNotebookCatalogAccessLoaderOptions =
  | {
      loadCatalogAccess: () => Promise<CloudNotebookCatalogAccessLoadResult>;
      notebookId: string;
    }
  | {
      loadNotebooks: () => Promise<readonly unknown[]>;
      notebookId: string;
    };

export interface CloudNotebookSyncScopeProjectionInput {
  catalogResolved: boolean;
  catalogScope?: CloudNotebookCatalogAccessScope | null;
  selectedMode: NotebookInteractionMode;
}

export interface CloudNotebookLiveRoomConnectionProjectionInput {
  canUseAuthenticatedCloudApi: boolean;
  catalogLoadFailed?: boolean;
  catalogResolved: boolean;
  catalogScope?: CloudNotebookCatalogAccessScope | null;
}

export interface CloudNotebookLiveRoomConnectionPolicy {
  shouldConnectLiveRoom: boolean;
  disabledStatus: { kind: "error" | "loading"; message: string } | null;
}

export function cloudNotebookCatalogScopeFromList(
  notebooks: readonly unknown[],
  notebookId: string,
): CloudNotebookCatalogAccessScope | null {
  const notebook = notebooks.find(
    (candidate) => isCloudNotebookListItem(candidate) && candidate.notebook_id === notebookId,
  );
  if (!isCloudNotebookListItem(notebook) || notebook.scope === "runtime_peer") {
    return null;
  }
  return notebook.scope;
}

export function cloudNotebookCatalogAccessFromList(
  notebooks: readonly unknown[],
  notebookId: string,
): CloudNotebookCatalogAccessLoadResult {
  return {
    catalogResolved: true,
    catalogScope: cloudNotebookCatalogScopeFromList(notebooks, notebookId),
  };
}

export function cloudNotebookCatalogAccessFromCatalogResponse(
  body: CloudNotebookCatalogResponse,
  notebookId: string,
): CloudNotebookCatalogAccessLoadResult {
  const notebook = body.notebook;
  if (!notebook || notebook.id !== notebookId) {
    throw new Error("Unable to load notebook catalog: response shape was invalid");
  }
  if (notebook.title !== null && typeof notebook.title !== "string") {
    throw new Error("Unable to load notebook catalog: response shape was invalid");
  }
  return {
    catalogResolved: true,
    catalogScope: cloudNotebookCatalogAccessScope(body.access?.scope) ?? "viewer",
    catalogTitle: notebook.title,
  };
}

export function createCloudNotebookCatalogAccessLoader(
  options: CloudNotebookCatalogAccessLoaderOptions,
): {
  load: () => Promise<CloudNotebookCatalogAccessLoadResult>;
} {
  let inFlight: Promise<CloudNotebookCatalogAccessLoadResult> | null = null;
  const load = () => {
    inFlight ??= (
      "loadCatalogAccess" in options
        ? options.loadCatalogAccess()
        : options
            .loadNotebooks()
            .then((notebooks) => cloudNotebookCatalogAccessFromList(notebooks, options.notebookId))
    ).catch((error: unknown) => {
      inFlight = null;
      throw error;
    });
    return inFlight;
  };
  return { load };
}

export function cloudNotebookAccessScopeForShell({
  catalogScope = null,
  connectionReady,
  connectionScope,
}: CloudNotebookAccessScopeProjectionInput): string | null {
  if (connectionReady && connectionScope) {
    return connectionScope;
  }
  return catalogScope ?? connectionScope;
}

export function cloudNotebookSyncScopeForCatalogAccess({
  catalogResolved,
  catalogScope = null,
  selectedMode,
}: CloudNotebookSyncScopeProjectionInput): Exclude<ConnectionScope, "runtime_peer"> {
  if (catalogScope) {
    return catalogScope;
  }
  if (catalogResolved) {
    return "viewer";
  }
  return selectedMode === "edit" ? "owner" : "viewer";
}

export function cloudNotebookLiveRoomConnectionPolicy({
  canUseAuthenticatedCloudApi,
  catalogLoadFailed = false,
  catalogResolved,
  catalogScope = null,
}: CloudNotebookLiveRoomConnectionProjectionInput): CloudNotebookLiveRoomConnectionPolicy {
  if (!canUseAuthenticatedCloudApi || catalogLoadFailed || catalogScope) {
    return { shouldConnectLiveRoom: true, disabledStatus: null };
  }
  if (!catalogResolved) {
    return {
      shouldConnectLiveRoom: false,
      disabledStatus: { kind: "loading", message: "Checking notebook access..." },
    };
  }
  return {
    shouldConnectLiveRoom: false,
    disabledStatus: { kind: "error", message: CLOUD_CONNECTION_NO_ACCESS_DIAGNOSTIC },
  };
}

export function cloudNotebookScopeCanEditDocument(
  scope: string | null | undefined,
): scope is Extract<ConnectionScope, "editor" | "owner"> {
  return scope === "editor" || scope === "owner";
}

function cloudNotebookCatalogAccessScope(value: unknown): CloudNotebookCatalogAccessScope | null {
  if (value === "viewer" || value === "editor" || value === "owner") {
    return value;
  }
  return null;
}
