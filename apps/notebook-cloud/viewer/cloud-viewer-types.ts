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
}

export interface CloudNotebookListBootstrap {
  kind: "notebook-list";
  notebooks: CloudNotebookListItem[];
  saved_at: string;
  session?: CloudAppSession | null;
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
  | { kind: "ready"; notebooks: CloudNotebookListItem[] }
  | { kind: "signed_out" }
  | { kind: "error"; message: string };

export interface CloudNotebookRenameState {
  notebookId: string;
  title: string;
}
