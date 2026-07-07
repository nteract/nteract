import type { CloudAppSession } from "./app-session";
import type { CloudViewerConfig } from "./cloud-viewer-session";
import type { CloudNotebookListItem } from "./notebook-dashboard";
import type { CloudOidcAuthConfig } from "./oidc-auth";

export interface CloudViewerAuthConfig {
  oidc: CloudOidcAuthConfig | null;
  localDev: CloudViewerLocalDevAuthConfig | null;
}

export interface CloudViewerLocalDevAuthConfig {
  authUrl: string;
  label?: string;
}

export interface ViewerRuntime {
  config: CloudViewerConfig;
}

export type ViewerRuntimeState =
  | { kind: "ready"; runtime: ViewerRuntime }
  | { kind: "error"; message: string };

export interface CloudNotebookListResponse {
  ok: boolean;
  notebooks: CloudNotebookListItem[];
  total_count?: number;
  /** Requester's worker principal, used only to key local-first shell cache. */
  current_user_principal?: string;
  /** Requester's unified-profile display name, when the store has one. */
  current_user_display?: string;
  /** Requester's unified-profile avatar URL, when the store has one. */
  current_user_avatar?: string;
}

export interface CloudNotebookListBootstrap {
  kind: "notebook-list";
  notebooks: CloudNotebookListItem[];
  saved_at: string;
  session?: CloudAppSession | null;
  total_count?: number;
}

export interface CloudNotebookListSnapshot {
  notebooks: CloudNotebookListItem[];
  totalCount: number;
}

export interface CloudNotebookCreateResponse {
  ok: boolean;
  title?: string | null;
  viewer_url?: string;
}

export interface CloudNotebookUpdateResponse {
  ok: boolean;
  notebook_id?: string;
  title?: string | null;
  updated_at?: string;
  viewer_url?: string;
}

export type CloudNotebookListState =
  | { kind: "loading" }
  | { kind: "ready"; notebooks: CloudNotebookListItem[]; totalCount: number }
  | { kind: "signed_out" }
  | { kind: "error"; message: string };

export interface CloudNotebookRenameState {
  notebookId: string;
  title: string;
}
