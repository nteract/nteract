import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { House, ListTree } from "lucide-react";
import type { EditorView } from "@codemirror/view";
import type { ConnectionStatus, NotebookOutlineItem } from "runtimed";
import { notebookRouteSegmentTitle } from "../src/notebook-route-title";
import type { CodeMirrorEditorRef } from "@/components/editor/codemirror-editor";
import { ProjectedMarkdownView } from "@/components/markdown/ProjectedMarkdownView";
import { DocumentTitle } from "@/components/notebook/DocumentTitle";
import { NotebookDocumentShell } from "@/components/notebook/NotebookDocumentShell";
import { NotebookDocumentToolbar } from "@/components/notebook/NotebookDocumentToolbar";
import { NotebookNotice, NotebookNoticeStack } from "@/components/notebook/NotebookNotice";
import {
  projectNotebookShellCapabilities,
  type NotebookShellCapabilities,
} from "@/components/notebook/capabilities";
import { NotebookOutlinePanel } from "@/components/notebook-rail/NotebookRail";
import { Rail, RAIL_TAKEOVER_STAGE_CLASS_NAME } from "@/components/rail";
import { MarkdownDocumentModeToggle } from "@/components/markdown/MarkdownDocumentModeToggle";
import { MarkdownDocumentRepresentationToolbar } from "@/components/markdown/MarkdownDocumentModeToggle";
import {
  projectMarkdownDocument,
  type MarkdownDocumentMode,
  type MarkdownDocumentProjection,
  type MarkdownDocumentRepresentation,
} from "@/lib/markdown-document";
import type { MarkdownProjectionPlan } from "@/lib/markdown-projection";
import { cn } from "@/lib/utils";
import { cloudResponseError } from "./cloud-response";
import {
  cloudDocumentUrlAfterRename,
  type CloudNotebookTitleDisplay,
} from "./cloud-notebook-title-state";
import {
  cloudNotebookModeFromSearch,
  replaceCloudNotebookModeInCurrentUrl,
} from "./cloud-notebook-mode";
import { cloudNotebookTitleClassNames } from "./cloud-notebook-title";
import { markdownConnectionCopy } from "./markdown-document-connection-copy";
import type { CloudMarkdownDocumentConfig, CloudViewerAuthConfig } from "./cloud-viewer-types";
import { fetchWithCloudPrototypeAuth, type CloudPrototypeAuthState } from "./collaborator-auth";
import type { MarkdownDocumentLiveSyncController } from "./markdown-document-live-sync";
import { MarkdownSharingControls } from "./markdown-sharing-controls";
import {
  useCloudAppSessionBridge,
  useCloudAppSessionStatus,
  useCloudPrototypeAuth,
} from "./use-cloud-auth";
import { loadSupplementalViewerCss } from "./supplemental-css";

type MarkdownEditorModule = typeof import("@/components/editor/codemirror-editor");
type MarkdownDocumentLiveSyncModule = typeof import("./markdown-document-live-sync");

const MarkdownCodeMirrorEditor = lazy(() =>
  loadMarkdownEditorModule().then((module) => ({ default: module.CodeMirrorEditor })),
);

let markdownEditorModulePromise: Promise<MarkdownEditorModule> | null = null;
let markdownDocumentLiveSyncModulePromise: Promise<MarkdownDocumentLiveSyncModule> | null = null;

function loadMarkdownEditorModule(): Promise<MarkdownEditorModule> {
  markdownEditorModulePromise ??= import("@/components/editor/codemirror-editor");
  return markdownEditorModulePromise;
}

function loadMarkdownDocumentLiveSyncModule(): Promise<MarkdownDocumentLiveSyncModule> {
  markdownDocumentLiveSyncModulePromise ??= import("./markdown-document-live-sync");
  return markdownDocumentLiveSyncModulePromise;
}

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

interface MarkdownDocumentMetadataUpdateResponse {
  ok: true;
  document_id: string;
  title: string | null;
  updated_at: string;
  viewer_url?: string;
}

type MarkdownDocumentAccessLevel = "owner" | "editor" | "viewer";

type MarkdownRailPanelId = "outline";

const MARKDOWN_RAIL_ITEMS = [{ id: "outline" as const, label: "Outline", icon: ListTree }];

type RouteState =
  | {
      kind: "ready";
      title: string;
      body: string;
      bodyReady: boolean;
      markdownPlan: MarkdownProjectionPlan | null;
      liveReady: boolean;
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
  const [routeState, setRouteState] = useState<RouteState>(() =>
    initialMarkdownDocumentRouteState(config),
  );
  const [mode, setMode] = useState<MarkdownDocumentMode>(initialMarkdownDocumentMode);
  const [requestedRepresentation, setRequestedRepresentation] =
    useState<MarkdownDocumentRepresentation | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(initialMarkdownRailCollapsed);
  const [markdownTitleSaving, setMarkdownTitleSaving] = useState(false);
  const [markdownTitleError, setMarkdownTitleError] = useState<string | null>(null);
  const syncControllerRef = useRef<MarkdownDocumentLiveSyncController | null>(null);
  const editorRef = useRef<CodeMirrorEditorRef | null>(null);
  const connectionStatusRef = useRef<ConnectionStatus>("connecting");
  const liveSnapshotSeenRef = useRef(false);

  useEffect(() => {
    loadSupplementalViewerCss();
  }, []);

  useEffect(() => {
    replaceCloudNotebookModeInCurrentUrl(mode);
  }, [mode]);

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
    liveSnapshotSeenRef.current = false;
    void (async () => {
      try {
        connectionStatusRef.current = "connecting";
        setRouteState((current) =>
          current.kind === "ready"
            ? { ...current, connectionStatus: "connecting" }
            : initialMarkdownDocumentRouteState(config),
        );
        const catalogPromise = Promise.resolve(
          markdownCatalogFromBootstrap(config) ?? fetchMarkdownCatalog(config, authState),
        );
        const [catalog, liveSyncModule] = await Promise.all([
          catalogPromise,
          loadMarkdownDocumentLiveSyncModule(),
        ]);
        if (disposed) return;
        const title = catalog.document.title?.trim() || "Untitled Markdown";
        const latestRevisionId = catalog.document.latest_revision_id;
        void liveSyncModule
          .loadMarkdownDocumentInstantPaintSnapshot({
            authState,
            config,
            appSession: appSessionStatus.session,
            title,
            onError: (error) => {
              console.warn("[notebook-cloud] Markdown instant paint failed", error);
            },
          })
          .then((snapshot) => {
            if (!snapshot || disposed || liveSnapshotSeenRef.current) {
              return;
            }
            setRouteState({
              kind: "ready",
              title: snapshot.title,
              body: snapshot.body,
              bodyReady: snapshot.bodyReady,
              markdownPlan: null,
              scope: catalog.document.scope,
              connectionStatus: connectionStatusRef.current,
              liveReady: false,
              latestRevisionId,
            });
          });
        controller = await liveSyncModule.startMarkdownDocumentLiveSync({
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
            liveSnapshotSeenRef.current = true;
            setRouteState({
              kind: "ready",
              title: snapshot.title,
              body: snapshot.body,
              bodyReady: snapshot.bodyReady,
              markdownPlan: null,
              scope: catalog.document.scope,
              connectionStatus: connectionStatusRef.current,
              liveReady: true,
              latestRevisionId,
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
      markdownPlan: routeState.markdownPlan,
      access: routeState.scope,
      requestedMode: mode,
      requestedRepresentation,
      publishedRevisionId: routeState.latestRevisionId,
      updatedAt: null,
    });
  }, [config.documentId, mode, requestedRepresentation, routeState]);
  const routeTitle = routeState.kind === "ready" ? routeState.title : null;

  useEffect(() => {
    if (!routeTitle || typeof document === "undefined") {
      return;
    }
    document.title = markdownDocumentBrowserTitle(routeTitle);
  }, [routeTitle]);

  const saveMarkdownDocumentTitle = useCallback(
    async (nextTitle: string): Promise<boolean> => {
      if (routeState.kind !== "ready" || routeState.scope === "viewer" || markdownTitleSaving) {
        return false;
      }

      try {
        setMarkdownTitleSaving(true);
        setMarkdownTitleError(null);
        const response = await fetchWithCloudPrototypeAuth(
          new URL(config.catalogEndpoint, window.location.origin).href,
          {
            method: "PATCH",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ title: nextTitle.trim() || null }),
          },
          authState.mode === "dev" ? { ...authState, requestedScope: "editor" } : authState,
        );
        if (!response.ok) {
          throw await cloudResponseError(response, "Unable to rename Markdown document");
        }
        const body = (await response.json()) as MarkdownDocumentMetadataUpdateResponse;
        if (body.ok !== true || body.document_id !== config.documentId) {
          throw new Error("Unable to rename Markdown document: response shape was invalid");
        }
        const displayTitle = body.title?.trim() || "Untitled Markdown";
        syncControllerRef.current?.editTitle(displayTitle);
        setRouteState((current) =>
          current.kind === "ready" ? { ...current, title: displayTitle } : current,
        );
        if (body.viewer_url) {
          const nextHref = cloudDocumentUrlAfterRename({
            currentHref: window.location.href,
            routePrefix: "/m",
            viewerUrl: body.viewer_url,
          });
          if (nextHref !== window.location.href) {
            window.history.replaceState(window.history.state, "", nextHref);
          }
        }
        return true;
      } catch (error) {
        setMarkdownTitleError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setMarkdownTitleSaving(false);
      }
    },
    [authState, config.catalogEndpoint, config.documentId, markdownTitleSaving, routeState],
  );

  const onEditorValueChange = useCallback((nextBody: string) => {
    syncControllerRef.current?.editBody(nextBody);
  }, []);

  const onModeChange = useCallback((nextMode: MarkdownDocumentMode) => {
    setMode(nextMode);
    setRequestedRepresentation(null);
  }, []);

  const onRepresentationChange = useCallback(
    (nextRepresentation: MarkdownDocumentRepresentation) => {
      setRequestedRepresentation(nextRepresentation);
    },
    [],
  );
  const bodyReadyForEditorPreload = routeState.kind === "ready" && routeState.bodyReady;

  useEffect(() => {
    if (!bodyReadyForEditorPreload) {
      return;
    }
    const timeout = window.setTimeout(() => {
      void loadMarkdownEditorModule();
    }, 0);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [bodyReadyForEditorPreload]);

  useEffect(() => {
    if (routeState.kind !== "ready" || projection?.representation.active !== "source") {
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
    let cancelled = false;
    void loadMarkdownEditorModule().then(({ externalChangeAnnotation }) => {
      if (cancelled || editorRef.current?.getEditor() !== editor) {
        return;
      }
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: routeState.body },
        annotations: externalChangeAnnotation.of(true),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [projection?.representation.active, routeState]);

  if (routeState.kind === "error" || !projection) {
    return (
      <main className="cloud-markdown-shell">
        <div className="cloud-state" data-kind="error">
          {routeState.kind === "error" ? routeState.message : "Markdown document did not project"}
        </div>
      </main>
    );
  }

  const canEdit = projection.canEdit && routeState.liveReady;
  const activeRepresentation = projection.representation.active;
  const sourceEditable = canEdit && projection.representation.sourceEditable;
  const canManageSharing =
    projection.canShare && config.hostCapabilities?.canManageSharing !== false;
  const activeMode = projection.mode;
  const markdownTitle = markdownDocumentTitleDisplay(projection.title);
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
      reserveCommandToolbar
      presence={
        <DocumentTitle
          title={markdownTitle}
          renameTitle={projection.title === "Untitled Markdown" ? "" : projection.title}
          canRename={projection.canEdit}
          renameSaving={markdownTitleSaving}
          renameError={markdownTitleError}
          onRename={saveMarkdownDocumentTitle}
          homeHref="/m"
          homeAriaLabel="Open Markdown documents"
          homeTitle="Markdown documents"
          homeIcon={<House aria-hidden="true" />}
          inputAriaLabel="Markdown document title"
          inputName="markdown-document-title"
          placeholder="Untitled Markdown"
          renameButtonTitle="Rename Markdown document"
          classNames={{
            ...cloudNotebookTitleClassNames,
            group: "cloud-notebook-title-group cloud-markdown-title-group",
          }}
        />
      }
      utilityControls={
        <MarkdownDocumentModeToggle
          mode={activeMode}
          canEdit={canEdit}
          onModeChange={onModeChange}
        />
      }
      commandToolbar={{
        leadingControls: (
          <MarkdownDocumentRepresentationToolbar
            active={activeRepresentation}
            options={projection.representation.options}
            onRepresentationChange={onRepresentationChange}
          />
        ),
      }}
      sharingControls={
        canManageSharing ? (
          <MarkdownSharingControls
            aclEndpoint={config.aclEndpoint}
            authState={authState}
            publicLink={publicLink}
          />
        ) : null
      }
    />
  );
  const notices = connectionCopy ? (
    <NotebookNoticeStack>
      <NotebookNotice tone="warning" title="Sync">
        {connectionCopy}
      </NotebookNotice>
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
      <div
        className="markdown-document-scroll"
        data-mode={activeMode}
        data-representation={activeRepresentation}
      >
        {activeRepresentation === "source" ? (
          <Suspense
            fallback={
              <div className="cloud-state markdown-document-editor" data-kind="loading">
                Loading editor.
              </div>
            }
          >
            <MarkdownCodeMirrorEditor
              ref={editorRef}
              key={config.documentId}
              initialValue={projection.body}
              language="markdown"
              lineWrapping
              readOnly={!sourceEditable}
              className="markdown-document-editor"
              onValueChange={sourceEditable ? onEditorValueChange : undefined}
            />
          </Suspense>
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

function initialMarkdownDocumentMode(): MarkdownDocumentMode {
  if (typeof window === "undefined") {
    return "view";
  }
  return cloudNotebookModeFromSearch(window.location.search);
}

function initialMarkdownDocumentRouteState(config: CloudMarkdownDocumentConfig): RouteState {
  const bootstrap = config.bootstrap;
  if (bootstrap) {
    const renderSeed = bootstrap.render_seed ?? null;
    return {
      kind: "ready",
      title: renderSeed?.title?.trim() || bootstrap.title?.trim() || "Untitled Markdown",
      body: renderSeed?.body ?? "",
      bodyReady: typeof renderSeed?.body === "string",
      markdownPlan: renderSeed?.markdown_plan ?? null,
      liveReady: false,
      scope: bootstrap.scope,
      connectionStatus: "connecting",
      latestRevisionId: bootstrap.latest_revision_id,
    };
  }
  return {
    kind: "ready",
    title: markdownDocumentRouteTitle(),
    body: "",
    bodyReady: false,
    markdownPlan: null,
    liveReady: false,
    scope: "viewer",
    connectionStatus: "connecting",
    latestRevisionId: null,
  };
}

function markdownCatalogFromBootstrap(
  config: CloudMarkdownDocumentConfig,
): MarkdownCatalogResponse | null {
  const bootstrap = config.bootstrap;
  if (!bootstrap) {
    return null;
  }
  return {
    document: {
      document_id: config.documentId,
      title: bootstrap.title,
      body_doc_id: bootstrap.body_doc_id,
      scope: bootstrap.scope,
      updated_at: bootstrap.updated_at,
      latest_revision_id: bootstrap.latest_revision_id,
    },
  };
}

function markdownDocumentRouteTitle(): string {
  if (typeof window === "undefined") {
    return "Markdown document";
  }
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const routeSlug = pathParts[0] === "m" ? pathParts[2] : null;
  return notebookRouteSegmentTitle(routeSlug) ?? "Markdown document";
}

function markdownDocumentTitleDisplay(title: string): CloudNotebookTitleDisplay {
  return {
    label: title,
    detail: null,
    title,
  };
}

function markdownDocumentBrowserTitle(title: string): string {
  const displayTitle = title.trim() || "Untitled Markdown";
  return `nteract Markdown: ${displayTitle}`;
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
