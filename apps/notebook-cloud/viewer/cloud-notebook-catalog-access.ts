import type { ConnectionScope } from "../src/auth-shared";
import type { NotebookInteractionMode } from "@/components/notebook";
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

export interface CloudNotebookSyncScopeProjectionInput {
  catalogResolved: boolean;
  catalogScope?: CloudNotebookCatalogAccessScope | null;
  selectedMode: NotebookInteractionMode;
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

export function cloudNotebookScopeCanEditDocument(
  scope: string | null | undefined,
): scope is Extract<ConnectionScope, "editor" | "owner"> {
  return scope === "editor" || scope === "owner";
}
