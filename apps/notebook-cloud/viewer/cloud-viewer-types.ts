import type { CloudAppSession } from "./app-session";
import type { CloudViewerConfig } from "./cloud-viewer-session";
import type { CloudMarkdownDocumentListItem } from "./markdown-document-dashboard";
import type { CloudNotebookListItem } from "./notebook-dashboard";
import type { CloudOidcAuthConfig } from "./oidc-auth";
import type { MarkdownProjectionPlan } from "@/lib/markdown-projection";

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

export interface CloudMarkdownDocumentListResponse {
  ok: boolean;
  documents: CloudMarkdownDocumentListItem[];
}

export interface CloudMarkdownDocumentListBootstrap {
  kind: "markdown-document-list";
  documents: CloudMarkdownDocumentListItem[];
  saved_at: string;
  session?: CloudAppSession | null;
}

export interface CloudMarkdownDocumentCreateResponse {
  ok: boolean;
  title?: string | null;
  viewer_url?: string;
}

export interface CloudMarkdownDocumentUpdateResponse {
  ok: boolean;
  document_id?: string;
  title?: string | null;
  updated_at?: string;
  viewer_url?: string;
}

export interface CloudMarkdownDocumentBootstrap {
  body_doc_id: string;
  latest_revision_id: string | null;
  render_seed?: CloudMarkdownDocumentRenderSeed | null;
  scope: "owner" | "editor" | "viewer";
  title: string | null;
  updated_at: string;
}

export interface CloudMarkdownDocumentRenderSeed {
  source: "latest_revision";
  revision_id: string;
  body_heads_hash: string;
  byte_length: number;
  title: string | null;
  body: string;
  markdown_plan: MarkdownProjectionPlan | null;
}

export interface CloudMarkdownDocumentConfig {
  documentKind: "markdown";
  documentId: string;
  catalogEndpoint: string;
  aclEndpoint: string;
  invitesEndpoint: string;
  accessRequestsEndpoint: string;
  syncEndpoint: string;
  runtimedWasmModulePath: string;
  runtimedWasmPath: string;
  bootstrap?: CloudMarkdownDocumentBootstrap | null;
  session?: CloudAppSession | null;
  hostCapabilities?: {
    canManageSharing?: boolean;
  };
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
