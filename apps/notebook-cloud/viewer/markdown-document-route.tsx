import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Eye, FileText, Loader2, PencilLine } from "lucide-react";
import type { NotebookOutlineItem } from "runtimed";
import { CodeMirrorEditor } from "@/components/editor/codemirror-editor";
import { ProjectedMarkdownView } from "@/components/markdown/ProjectedMarkdownView";
import { NotebookOutlinePanel } from "@/components/notebook-rail/NotebookRail";
import { projectMarkdownDocument, type MarkdownDocumentProjection } from "@/lib/markdown-document";
import { cloudResponseError } from "./cloud-response";
import type { CloudMarkdownDocumentConfig, CloudViewerAuthConfig } from "./cloud-viewer-types";
import { fetchWithCloudPrototypeAuth, type CloudPrototypeAuthState } from "./collaborator-auth";
import { createMarkdownHandle, type MarkdownHandle } from "./runtimed-wasm-client";
import {
  useCloudAppSessionBridge,
  useCloudAppSessionStatus,
  useCloudPrototypeAuth,
} from "./use-cloud-auth";

interface MarkdownCatalogResponse {
  document: {
    document_id: string;
    title: string | null;
    body_doc_id: string;
    scope: "owner" | "editor" | "viewer";
    updated_at: string;
  };
}

type RouteState =
  | { kind: "loading" }
  | { kind: "ready"; title: string; body: string; scope: "owner" | "editor" | "viewer" }
  | { kind: "error"; message: string };

export function MarkdownDocumentRoute({
  authConfig,
  config,
}: {
  authConfig: CloudViewerAuthConfig;
  config: CloudMarkdownDocumentConfig;
}) {
  const appSessionStatus = useCloudAppSessionStatus(config.session ?? null);
  const { authState } = useCloudPrototypeAuth(authConfig, {
    appSessionRefreshFallback: true,
    appSessionLoading: appSessionStatus.status === "loading",
    appSession: appSessionStatus.session,
  });
  useCloudAppSessionBridge(
    authState,
    appSessionStatus.session,
    appSessionStatus.status === "loading",
    appSessionStatus.refreshAppSessionStatus,
  );
  const [routeState, setRouteState] = useState<RouteState>({ kind: "loading" });
  const [mode, setMode] = useState<"source" | "read">("source");
  const handleRef = useRef<MarkdownHandle | null>(null);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        setRouteState({ kind: "loading" });
        const catalog = await fetchMarkdownCatalog(config, authState);
        if (disposed) return;
        const title = catalog.document.title?.trim() || "Untitled Markdown";
        const handle = await createMarkdownHandle(
          catalog.document.body_doc_id,
          title,
          markdownActorLabel(authState),
          config.runtimedWasmModulePath,
          config.runtimedWasmPath,
        );
        const initialBody = `# ${title}\n\nStart writing.`;
        handle.replace_body_for_import(initialBody);
        handleRef.current?.free();
        handleRef.current = handle;
        setRouteState({
          kind: "ready",
          title,
          body: handle.body() ?? "",
          scope: catalog.document.scope,
        });
      } catch (error) {
        if (disposed) return;
        setRouteState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      disposed = true;
      handleRef.current?.free();
      handleRef.current = null;
    };
  }, [authState, config]);

  const projection = useMemo<MarkdownDocumentProjection | null>(() => {
    if (routeState.kind !== "ready") {
      return null;
    }
    return projectMarkdownDocument({
      id: config.documentId,
      title: routeState.title,
      body: routeState.body,
      access: routeState.scope,
      requestedMode: mode,
      updatedAt: null,
    });
  }, [config.documentId, mode, routeState]);

  const onEditorValueChange = useCallback((nextBody: string) => {
    const handle = handleRef.current;
    if (!handle) {
      return;
    }
    const previousBody = handle.body() ?? "";
    const splice = diffAsSplice(previousBody, nextBody);
    handle.splice_body(splice.index, splice.deleteCount, splice.insertText);
    const body = handle.body() ?? nextBody;
    setRouteState((current) => (current.kind === "ready" ? { ...current, body } : current));
  }, []);

  if (routeState.kind === "loading") {
    return (
      <main className="cloud-markdown-shell">
        <div className="cloud-state" data-kind="loading">
          <Loader2 aria-hidden="true" />
          Opening Markdown document
        </div>
      </main>
    );
  }

  if (routeState.kind === "error" || !projection) {
    return (
      <main className="cloud-markdown-shell">
        <div className="cloud-state" data-kind="error">
          {routeState.kind === "error" ? routeState.message : "Markdown document did not project"}
        </div>
      </main>
    );
  }

  const canEdit = projection.canEdit;

  return (
    <main className="cloud-markdown-shell">
      <header className="cloud-markdown-toolbar">
        <a href="/m" aria-label="Open Markdown documents" className="cloud-markdown-home-link">
          <ArrowLeft aria-hidden="true" />
        </a>
        <div>
          <p className="cloud-dashboard-eyebrow">Markdown</p>
          <h1>{projection.title}</h1>
        </div>
        <div className="cloud-markdown-toolbar-actions">
          <button type="button" aria-pressed={mode === "read"} onClick={() => setMode("read")}>
            <Eye aria-hidden="true" />
            Read
          </button>
          <button
            type="button"
            aria-pressed={mode === "source"}
            disabled={!canEdit}
            onClick={() => setMode("source")}
          >
            <PencilLine aria-hidden="true" />
            Source
          </button>
        </div>
      </header>
      <div className="cloud-markdown-notice">
        Markdown body edits are local to this browser until the hosted Automerge sync channel lands.
      </div>
      <div className="cloud-markdown-workspace">
        <aside className="cloud-markdown-rail">
          <div className="cloud-markdown-rail-title">
            <FileText aria-hidden="true" />
            Outline
          </div>
          <NotebookOutlinePanel
            items={markdownOutlineItems(projection)}
            emptyMessage="Add Markdown headings to structure this document. They will appear here."
            getItemHref={(item) => item.href}
            onNavigateItem={(_item, href) => {
              window.location.hash = href;
              return true;
            }}
          />
        </aside>
        <section className="cloud-markdown-stage">
          {mode === "source" && canEdit ? (
            <CodeMirrorEditor
              key={config.documentId}
              initialValue={projection.body}
              language="markdown"
              lineWrapping
              className="cloud-markdown-editor"
              onValueChange={onEditorValueChange}
            />
          ) : projection.markdownPlan ? (
            <ProjectedMarkdownView
              plan={projection.markdownPlan}
              className="cloud-markdown-preview"
              headingAnchors={projection.headingAnchors}
            />
          ) : (
            <div className="cloud-state" data-kind="empty">
              Nothing to render yet.
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

async function fetchMarkdownCatalog(
  config: CloudMarkdownDocumentConfig,
  authState: CloudPrototypeAuthState,
): Promise<MarkdownCatalogResponse> {
  const response = await fetchWithCloudPrototypeAuth(
    new URL(config.catalogEndpoint, window.location.origin).href,
    { headers: { Accept: "application/json" } },
    authState.mode === "dev" ? { ...authState, requestedScope: "viewer" } : authState,
  );
  if (!response.ok) {
    throw await cloudResponseError(response, "Unable to open Markdown document");
  }
  const body = (await response.json()) as MarkdownCatalogResponse;
  if (!isMarkdownCatalogResponse(body)) {
    throw new Error("Unable to open Markdown document: response shape was invalid");
  }
  return body;
}

function isMarkdownCatalogResponse(value: unknown): value is MarkdownCatalogResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const document = (value as Partial<MarkdownCatalogResponse>).document;
  return (
    Boolean(document) &&
    typeof document?.document_id === "string" &&
    (document.title === null || typeof document.title === "string") &&
    typeof document.body_doc_id === "string" &&
    (document.scope === "owner" || document.scope === "editor" || document.scope === "viewer") &&
    typeof document.updated_at === "string"
  );
}

function markdownOutlineItems(projection: MarkdownDocumentProjection): NotebookOutlineItem[] {
  return projection.outlineItems.map((item) => ({
    id: item.id,
    cellId: item.blockId,
    cellType: "markdown",
    title: item.title,
    level: item.level,
    kind: "heading",
    cellAnchorId: item.blockId,
    headingAnchorId: item.anchor,
    href: item.href,
    anchor: item.anchor,
  }));
}

function markdownActorLabel(authState: CloudPrototypeAuthState): string {
  const user = encodeURIComponent(authState.user ?? "browser");
  return `user:markdown:${user}/browser:${crypto.randomUUID()}`;
}

function diffAsSplice(
  previous: string,
  next: string,
): { index: number; deleteCount: number; insertText: string } {
  if (previous === next) {
    return { index: 0, deleteCount: 0, insertText: "" };
  }
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < next.length &&
    previous.charCodeAt(prefix) === next.charCodeAt(prefix)
  ) {
    prefix += 1;
  }
  let previousSuffix = previous.length;
  let nextSuffix = next.length;
  while (
    previousSuffix > prefix &&
    nextSuffix > prefix &&
    previous.charCodeAt(previousSuffix - 1) === next.charCodeAt(nextSuffix - 1)
  ) {
    previousSuffix -= 1;
    nextSuffix -= 1;
  }
  return {
    index: prefix,
    deleteCount: previousSuffix - prefix,
    insertText: next.slice(prefix, nextSuffix),
  };
}
