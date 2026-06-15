import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Eye, FileText, Globe2, Loader2, PencilLine } from "lucide-react";
import type { EditorView } from "@codemirror/view";
import type { ConnectionStatus, NotebookOutlineItem } from "runtimed";
import {
  CodeMirrorEditor,
  externalChangeAnnotation,
  type CodeMirrorEditorRef,
} from "@/components/editor/codemirror-editor";
import { ProjectedMarkdownView } from "@/components/markdown/ProjectedMarkdownView";
import { NotebookOutlinePanel } from "@/components/notebook-rail/NotebookRail";
import { projectMarkdownDocument, type MarkdownDocumentProjection } from "@/lib/markdown-document";
import { cloudResponseError } from "./cloud-response";
import type { CloudMarkdownDocumentConfig, CloudViewerAuthConfig } from "./cloud-viewer-types";
import { fetchWithCloudPrototypeAuth, type CloudPrototypeAuthState } from "./collaborator-auth";
import {
  startMarkdownDocumentLiveSync,
  type MarkdownDocumentLiveSyncController,
} from "./markdown-document-live-sync";
import { MarkdownSharingControls } from "./markdown-sharing-controls";
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
    latest_revision_id: string | null;
  };
}

type PublishStatus =
  | { kind: "idle"; message: string | null }
  | { kind: "publishing"; message: string }
  | { kind: "published"; message: string; revisionId: string }
  | { kind: "error"; message: string };

type RouteState =
  | { kind: "loading" }
  | {
      kind: "ready";
      title: string;
      body: string;
      bodyReady: boolean;
      scope: "owner" | "editor" | "viewer";
      connectionStatus: ConnectionStatus;
      latestRevisionId: string | null;
    }
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
  const [publishStatus, setPublishStatus] = useState<PublishStatus>({
    kind: "idle",
    message: null,
  });
  const syncControllerRef = useRef<MarkdownDocumentLiveSyncController | null>(null);
  const editorRef = useRef<CodeMirrorEditorRef | null>(null);
  const connectionStatusRef = useRef<ConnectionStatus>("connecting");
  const latestRevisionIdRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let controller: MarkdownDocumentLiveSyncController | null = null;
    void (async () => {
      try {
        connectionStatusRef.current = "connecting";
        setRouteState({ kind: "loading" });
        const catalog = await fetchMarkdownCatalog(config, authState);
        if (disposed) return;
        latestRevisionIdRef.current = catalog.document.latest_revision_id;
        const title = catalog.document.title?.trim() || "Untitled Markdown";
        controller = await startMarkdownDocumentLiveSync({
          authState,
          config,
          appSession: appSessionStatus.session,
          title,
          scope: catalog.document.scope,
          onConnectionLost: (reason) => {
            console.warn("[notebook-cloud] Markdown document connection lost", reason);
          },
          onError: (error) => {
            console.warn("[notebook-cloud] Markdown document sync failed", error);
          },
          onStatus: (connectionStatus) => {
            connectionStatusRef.current = connectionStatus;
            setRouteState((current) =>
              current.kind === "ready" ? { ...current, connectionStatus } : current,
            );
          },
          onSnapshot: (snapshot) => {
            setRouteState({
              kind: "ready",
              title: snapshot.title,
              body: snapshot.body,
              bodyReady: snapshot.bodyReady,
              scope: catalog.document.scope,
              connectionStatus: connectionStatusRef.current,
              latestRevisionId: latestRevisionIdRef.current,
            });
          },
        });
        if (disposed) {
          controller.dispose();
          return;
        }
        syncControllerRef.current?.dispose();
        syncControllerRef.current = controller;
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
      controller?.dispose();
      if (syncControllerRef.current === controller) {
        syncControllerRef.current = null;
      }
    };
  }, [appSessionStatus.session, authState, config]);

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
      publishedRevisionId: routeState.latestRevisionId,
      updatedAt: null,
    });
  }, [config.documentId, mode, routeState]);

  const onEditorValueChange = useCallback((nextBody: string) => {
    syncControllerRef.current?.editBody(nextBody);
    setPublishStatus((current) =>
      current.kind === "published" ? { kind: "idle", message: "Unpublished changes." } : current,
    );
  }, []);

  const publishMarkdownDocumentSnapshot = useCallback(async () => {
    const controller = syncControllerRef.current;
    if (!controller || routeState.kind !== "ready") {
      setPublishStatus({
        kind: "error",
        message: "Markdown document is still connecting. Try publishing again in a moment.",
      });
      return;
    }
    setPublishStatus({
      kind: "publishing",
      message: "Publishing Markdown document...",
    });
    try {
      const snapshot = await controller.publishSnapshot();
      latestRevisionIdRef.current = snapshot.revisionId;
      setRouteState((current) =>
        current.kind === "ready" ? { ...current, latestRevisionId: snapshot.revisionId } : current,
      );
      setPublishStatus({
        kind: "published",
        message: "Public link updated.",
        revisionId: snapshot.revisionId,
      });
    } catch (error) {
      setPublishStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [routeState.kind]);

  useEffect(() => {
    if (routeState.kind !== "ready" || mode !== "source") {
      return;
    }
    const editor = editorRef.current?.getEditor();
    if (!editor) {
      return;
    }
    const currentBody = editor.state.doc.toString();
    if (currentBody === routeState.body) {
      return;
    }
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: routeState.body },
      annotations: externalChangeAnnotation.of(true),
    });
  }, [mode, routeState]);

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

  const canEdit = projection.canEdit && routeState.bodyReady;
  const canManageSharing =
    projection.canShare && config.hostCapabilities?.canManageSharing !== false;
  const canPublish = projection.canPublish && config.hostCapabilities?.canPublish !== false;
  const connectionCopy = markdownConnectionCopy(routeState.connectionStatus, routeState.bodyReady);
  const publicLink =
    typeof window === "undefined" ? "" : `${window.location.origin}${window.location.pathname}`;
  const publishCopy = publishStatus.message;

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
          {canManageSharing ? (
            <MarkdownSharingControls
              aclEndpoint={config.aclEndpoint}
              authState={authState}
              publicLink={publicLink}
            />
          ) : null}
          {canPublish ? (
            <button
              type="button"
              disabled={publishStatus.kind === "publishing" || !routeState.bodyReady}
              onClick={() => void publishMarkdownDocumentSnapshot()}
            >
              {publishStatus.kind === "publishing" ? (
                <Loader2 aria-hidden="true" />
              ) : (
                <Globe2 aria-hidden="true" />
              )}
              {projection.isPublished ? "Publish update" : "Publish"}
            </button>
          ) : null}
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
      {connectionCopy ? <div className="cloud-markdown-notice">{connectionCopy}</div> : null}
      {publishCopy ? (
        <div className="cloud-markdown-notice" data-kind={publishStatus.kind}>
          {publishCopy}
        </div>
      ) : null}
      <div className="cloud-markdown-workspace">
        <aside className="cloud-markdown-rail">
          <div className="cloud-markdown-rail-title">
            <FileText aria-hidden="true" />
            Outline
          </div>
          <NotebookOutlinePanel
            items={markdownOutlineItems(projection)}
            ariaLabel="Document outline"
            emptyMessage="Add Markdown headings to structure this document. They will appear here."
            getItemHref={(item) => item.href}
            onNavigateItem={(item, href) => {
              if (
                mode === "source" &&
                canEdit &&
                scrollEditorToMarkdownOutlineItem(
                  editorRef.current?.getEditor() ?? null,
                  projection.outlineItems,
                  item.id,
                )
              ) {
                window.history.replaceState(null, "", href);
                return true;
              }
              window.location.hash = href;
              return true;
            }}
          />
        </aside>
        <section className="cloud-markdown-stage">
          {mode === "source" && canEdit ? (
            <CodeMirrorEditor
              ref={editorRef}
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
              {routeState.bodyReady ? "Nothing to render yet." : "Syncing Markdown document body."}
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
    typeof document.updated_at === "string" &&
    (document.latest_revision_id === null || typeof document.latest_revision_id === "string")
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

function scrollEditorToMarkdownOutlineItem(
  editor: EditorView | null,
  outlineItems: readonly MarkdownDocumentProjection["outlineItems"][number][],
  itemId: string,
): boolean {
  const outlineItem = outlineItems.find((candidate) => candidate.id === itemId);
  if (!editor || !outlineItem) {
    return false;
  }
  const [anchor, head] = outlineItem.sourceSpanUtf16;
  editor.focus();
  editor.dispatch({
    selection: { anchor, head },
    scrollIntoView: true,
  });
  return true;
}

function markdownConnectionCopy(status: ConnectionStatus, bodyReady: boolean): string | null {
  if (!bodyReady) {
    return "Syncing Markdown document body.";
  }
  switch (status) {
    case "connecting":
      return "Connecting to the live Markdown document.";
    case "reconnecting":
      return "Reconnecting to the live Markdown document.";
    case "offline":
      return "Markdown document is offline. Local changes will wait for reconnection.";
    case "online":
      return null;
  }
}
