import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Globe2, House, ListTree, Loader2 } from "lucide-react";
import type { EditorView } from "@codemirror/view";
import type { ConnectionStatus, NotebookOutlineItem } from "runtimed";
import {
  CodeMirrorEditor,
  externalChangeAnnotation,
  type CodeMirrorEditorRef,
} from "@/components/editor/codemirror-editor";
import { ProjectedMarkdownView } from "@/components/markdown/ProjectedMarkdownView";
import {
  NotebookDocumentShell,
  NotebookDocumentToolbar,
  NotebookNotice,
  NotebookNoticeStack,
  projectNotebookShellCapabilities,
  type NotebookShellCapabilities,
} from "@/components/notebook";
import { NotebookOutlinePanel } from "@/components/notebook-rail/NotebookRail";
import { Rail, RAIL_TAKEOVER_STAGE_CLASS_NAME } from "@/components/rail";
import { MarkdownDocumentModeToggle } from "@/components/markdown/MarkdownDocumentModeToggle";
import {
  projectMarkdownDocument,
  type MarkdownDocumentMode,
  type MarkdownDocumentProjection,
} from "@/lib/markdown-document";
import { cn } from "@/lib/utils";
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

type MarkdownDocumentAccessLevel = "owner" | "editor" | "viewer";

type MarkdownRailPanelId = "outline";

const MARKDOWN_RAIL_ITEMS = [{ id: "outline" as const, label: "Outline", icon: ListTree }];

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
  const [mode, setMode] = useState<MarkdownDocumentMode>("edit");
  const [railCollapsed, setRailCollapsed] = useState(initialMarkdownRailCollapsed);
  const [publishStatus, setPublishStatus] = useState<PublishStatus>({
    kind: "idle",
    message: null,
  });
  const syncControllerRef = useRef<MarkdownDocumentLiveSyncController | null>(null);
  const editorRef = useRef<CodeMirrorEditorRef | null>(null);
  const connectionStatusRef = useRef<ConnectionStatus>("connecting");
  const latestRevisionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const media = window.matchMedia("(max-width: 599.98px)");
    const collapseForNarrowViewport = () => {
      if (media.matches) {
        setRailCollapsed(true);
      }
    };
    collapseForNarrowViewport();
    media.addEventListener("change", collapseForNarrowViewport);
    return () => {
      media.removeEventListener("change", collapseForNarrowViewport);
    };
  }, []);

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
    const hadPublicVersion = latestRevisionIdRef.current !== null;
    setPublishStatus({
      kind: "publishing",
      message: hadPublicVersion ? "Updating public version..." : "Publishing Markdown document...",
    });
    try {
      const snapshot = await controller.publishSnapshot();
      latestRevisionIdRef.current = snapshot.revisionId;
      setRouteState((current) =>
        current.kind === "ready" ? { ...current, latestRevisionId: snapshot.revisionId } : current,
      );
      setPublishStatus({
        kind: "published",
        message: hadPublicVersion ? "Public version updated." : "Public version saved.",
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
    if (routeState.kind !== "ready" || mode !== "edit") {
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
  const activeMode = projection.mode;
  const shellCapabilities = markdownDocumentShellCapabilities({
    access: routeState.scope,
    authState,
    canEdit,
    canManageSharing,
    mode: activeMode,
  });
  const connectionCopy = markdownConnectionCopy(routeState.connectionStatus, routeState.bodyReady);
  const publicLink =
    typeof window === "undefined" ? "" : `${window.location.origin}${window.location.pathname}`;
  const publishCopy = publishStatus.message;
  const markdownOutline = (
    <NotebookOutlinePanel
      items={markdownOutlineItems(projection)}
      ariaLabel="Document outline"
      emptyMessage="Add Markdown headings to structure this document. They will appear here."
      getItemHref={(item) => item.href}
      onNavigateItem={(item, href) => {
        if (
          activeMode === "edit" &&
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
  );
  const rail = (
    <Rail<MarkdownRailPanelId>
      activePanelId="outline"
      collapsed={railCollapsed}
      items={MARKDOWN_RAIL_ITEMS}
      panelEyebrow="Markdown"
      panelTitle="Outline"
      panelClassName="w-[clamp(18rem,22vw,20rem)] min-w-72"
      className="cloud-notebook-rail cloud-markdown-rail"
      dataTestId="markdown-document-rail"
      panelSlot="notebook-rail-panel"
      panelTitleRowSlot="notebook-rail-panel-title-row"
      onActivePanelChange={() => setRailCollapsed(false)}
      onCollapsedChange={setRailCollapsed}
    >
      {markdownOutline}
    </Rail>
  );
  const toolbar = (
    <NotebookDocumentToolbar
      capabilities={shellCapabilities}
      frameClassName="z-20"
      headerClassName="cloud-room-toolbar cloud-markdown-room-toolbar"
      presence={<MarkdownDocumentTitle title={projection.title} access={projection.access} />}
      utilityControls={
        <MarkdownDocumentModeToggle mode={activeMode} canEdit={canEdit} onModeChange={setMode} />
      }
      sharingControls={
        canManageSharing ? (
          <>
            <MarkdownSharingControls
              aclEndpoint={config.aclEndpoint}
              authState={authState}
              publicLink={publicLink}
            />
            {canPublish ? (
              <button
                type="button"
                className="markdown-document-toolbar-action"
                disabled={publishStatus.kind === "publishing" || !routeState.bodyReady}
                onClick={() => void publishMarkdownDocumentSnapshot()}
              >
                {publishStatus.kind === "publishing" ? (
                  <Loader2 aria-hidden="true" />
                ) : (
                  <Globe2 aria-hidden="true" />
                )}
                <span>{projection.isPublished ? "Update public version" : "Publish"}</span>
              </button>
            ) : null}
          </>
        ) : null
      }
    />
  );
  const notices =
    connectionCopy || publishCopy ? (
      <NotebookNoticeStack>
        {connectionCopy ? (
          <NotebookNotice tone="warning" title="Sync">
            {connectionCopy}
          </NotebookNotice>
        ) : null}
        {publishCopy ? (
          <NotebookNotice tone={publishNoticeTone(publishStatus.kind)} title="Markdown">
            {publishCopy}
          </NotebookNotice>
        ) : null}
      </NotebookNoticeStack>
    ) : null;

  return (
    <NotebookDocumentShell
      rootElement="main"
      className="cloud-notebook-shell cloud-markdown-shell"
      toolbar={toolbar}
      rail={rail}
      notices={notices}
      noticesClassName="cloud-notebook-notices cloud-markdown-notices"
      stageClassName={cn(
        "cloud-notebook-stage cloud-markdown-stage",
        !railCollapsed && RAIL_TAKEOVER_STAGE_CLASS_NAME,
      )}
      stageLabel="Markdown document"
      capabilities={shellCapabilities}
    >
      <div className="markdown-document-scroll" data-mode={activeMode}>
        {activeMode === "edit" && canEdit ? (
          <CodeMirrorEditor
            ref={editorRef}
            key={config.documentId}
            initialValue={projection.body}
            language="markdown"
            lineWrapping
            className="markdown-document-editor"
            onValueChange={onEditorValueChange}
          />
        ) : projection.markdownPlan ? (
          <ProjectedMarkdownView
            plan={projection.markdownPlan}
            className="markdown-document-preview"
            headingAnchors={projection.headingAnchors}
          />
        ) : (
          <div className="cloud-state" data-kind="empty">
            {routeState.bodyReady ? "Nothing to render yet." : "Syncing Markdown document body."}
          </div>
        )}
      </div>
    </NotebookDocumentShell>
  );
}

function initialMarkdownRailCollapsed(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 599.98px)").matches;
}

function MarkdownDocumentTitle({
  title,
  access,
}: {
  title: string;
  access: MarkdownDocumentProjection["access"];
}) {
  return (
    <div className="cloud-notebook-title-group cloud-markdown-title-group">
      <a
        className="cloud-notebook-home-link"
        href="/m"
        aria-label="Open Markdown documents"
        title="Markdown documents"
      >
        <House aria-hidden="true" />
      </a>
      <div className="cloud-notebook-title" title={title}>
        <div className="cloud-notebook-title-static">
          <span>{title}</span>
        </div>
        <small>{markdownTitleDetail(access)}</small>
      </div>
    </div>
  );
}

function markdownDocumentShellCapabilities({
  access,
  authState,
  canEdit,
  canManageSharing,
  mode,
}: {
  access: MarkdownDocumentAccessLevel;
  authState: CloudPrototypeAuthState;
  canEdit: boolean;
  canManageSharing: boolean;
  mode: MarkdownDocumentMode;
}): NotebookShellCapabilities {
  const canUseAuthenticatedIdentity = authState.mode === "dev" || authState.mode === "oidc";
  const wantsEditMode = mode === "edit";
  const canEditMarkdown = wantsEditMode && canEdit;
  return projectNotebookShellCapabilities({
    interaction: {
      selectedMode: wantsEditMode ? "edit" : "view",
      activeMode: canEditMarkdown ? "edit" : "view",
      state: wantsEditMode ? (canEditMarkdown ? "editing" : "requested") : "viewing",
      canRequestEdit: false,
      canEditMarkdown,
      canEditCells: false,
      canEditStructure: false,
    },
    access: {
      level: access,
      source: "cloud",
      isPublic: false,
      actorLabel: null,
      identityLabel: null,
    },
    auth: {
      canSignIn: !canUseAuthenticatedIdentity,
      canUseAuthenticatedIdentity,
      needsAttention: authState.mode === "invalid" || authState.mode === "oidc_expired",
    },
    runtime: {
      canWriteRuntimeState: false,
      connected: false,
      executionAvailable: false,
      source: "cloud",
      actorLabel: null,
      identityLabel: null,
      target: null,
    },
    controls: {
      canToggleCode: false,
    },
    execution: {
      available: false,
      canSubmit: false,
    },
    packages: {
      canView: false,
      canManage: false,
    },
    sharing: {
      canManage: canManageSharing,
      requiresAuthenticatedIdentity: true,
      requiredAccessLevels: ["owner"],
      requiredSources: ["cloud"],
    },
  });
}

function markdownTitleDetail(access: MarkdownDocumentProjection["access"]): string {
  if (access === "owner") {
    return "Markdown document";
  }
  if (access === "editor") {
    return "Markdown document · Editor";
  }
  if (access === "viewer") {
    return "Markdown document · Viewer";
  }
  return "Markdown document";
}

function publishNoticeTone(kind: PublishStatus["kind"]) {
  if (kind === "published") {
    return "success";
  }
  if (kind === "error") {
    return "error";
  }
  return "info";
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
