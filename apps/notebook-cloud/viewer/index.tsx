import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  Code2,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LogIn,
  LogOut,
  RotateCcw,
  UsersRound,
} from "lucide-react";
import {
  ReadOnlyNotebook,
  type ReadOnlyNotebookCellData,
} from "@/components/cell/ReadOnlyNotebook";
import { ReadOnlyNotebookCell } from "@/components/cell/ReadOnlyNotebookCell";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { MediaProvider } from "@/components/outputs/media-provider";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import type { TracebackCellTarget } from "@/components/outputs/traceback-output";
import { useWidgetStoreRequired } from "@/components/widgets/widget-store-context";
import { useTheme } from "@/hooks/useTheme";
import { ErrorBoundary } from "@/lib/error-boundary";
import { isTextAttributionEvent } from "runtimed";
import { createNotebookCloudBlobResolver } from "../src/blob-resolver";
import {
  normalizeSnapshotWidgetComms,
  snapshotWidgetCommsFromRuntimeState,
} from "../src/widget-comms";
import { EditableMarkdownCell, type CloudTextAttributionQueue } from "./editable-markdown-cell";
import type { RemoteCellPresence } from "@/components/editor/presence-state";
import {
  clearCloudPrototypeDevAuth,
  cloudPrototypeAuthFromWindow,
  cloudSyncAuthFromPrototypeAuthState,
  fetchWithCloudPrototypeAuth,
  NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY,
  prototypeAuthDiagnostics,
  prototypeAuthSummary,
  storeCloudAccessAuth,
  storeCloudPrototypeDevAuth,
  validatePrototypeToken,
  withCloudPrototypeAuthHeaders,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { connectCloudSyncRuntime, type CloudSyncRuntime } from "./live-sync";
import {
  beginOidcLogin,
  clearCloudOidcAuth,
  completeOidcRedirect,
  normalizeOidcAuthConfig,
  type CloudOidcAuthConfig,
} from "./oidc-auth";
import type { ConnectionScope } from "../src/auth-shared";
import {
  CloudLivePresenceStore,
  emptyCloudLivePresenceSnapshot,
  type CloudLivePresenceSnapshot,
} from "./live-presence";
import { CLOUD_VIEWER_PRIORITY } from "./mime-policy";
import {
  cloudViewerPresenceDisplay,
  type CloudViewerPresenceState,
  initialCloudViewerPresence,
  reduceCloudViewerConnection,
  reduceCloudViewerPresenceMessage,
} from "./presence";
import { resolveCell, type RenderCell, type ResolvedCell } from "./render-resolution";
import { preloadSiftWasmForCells } from "./sift-preload";
import { cloudSourceLanguage } from "./source-language";
import {
  applyDocumentTheme,
  CLOUD_VIEWER_THEME_STORAGE_KEY,
  installDocumentThemeSync,
} from "./theme";
import {
  CLOUD_WIDGET_RENDERERS,
  CloudWidgetStoreProvider,
  projectCloudWidgetComms,
} from "./widget-runtime";
import "./index.css";

interface CloudViewerConfig {
  notebookId: string;
  headsHash: string | null;
  renderEndpoint: string;
  syncEndpoint: string;
  blobBasePath: string;
  rendererAssetsBasePath: string;
  outputDocumentBaseUrl: string | null;
  runtimedWasmModulePath: string;
  runtimedWasmPath: string;
}

interface CloudViewerAuthConfig {
  oidc: CloudOidcAuthConfig | null;
}

interface SnapshotRender {
  heads_hash?: string;
  metadata?: unknown;
  source?: string;
  cells?: unknown;
  widget_comms?: unknown;
}

type ViewerStatus =
  | { kind: "loading"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "ready"; message: string }
  | { kind: "error"; message: string };

interface ViewerRuntime {
  config: CloudViewerConfig;
}

type ViewerRuntimeState =
  | { kind: "ready"; runtime: ViewerRuntime }
  | { kind: "error"; message: string };

const rendererBundle = () => import("virtual:isolated-renderer");

installDocumentThemeSync();

function requireElement<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing cloud viewer element ${selector}`);
  }
  return element;
}

function loadConfig(): CloudViewerConfig {
  const element = requireElement<HTMLScriptElement>("#nteract-cloud-viewer-config");
  const parsed = JSON.parse(element.textContent ?? "{}") as Partial<CloudViewerConfig>;
  if (
    !parsed.notebookId ||
    !parsed.renderEndpoint ||
    !parsed.syncEndpoint ||
    !parsed.blobBasePath ||
    !parsed.rendererAssetsBasePath ||
    !parsed.runtimedWasmModulePath ||
    !parsed.runtimedWasmPath
  ) {
    throw new Error("Cloud viewer config is incomplete");
  }
  return {
    notebookId: parsed.notebookId,
    headsHash: parsed.headsHash ?? null,
    renderEndpoint: parsed.renderEndpoint,
    syncEndpoint: parsed.syncEndpoint,
    blobBasePath: parsed.blobBasePath,
    rendererAssetsBasePath: parsed.rendererAssetsBasePath,
    outputDocumentBaseUrl: parsed.outputDocumentBaseUrl ?? null,
    runtimedWasmModulePath: parsed.runtimedWasmModulePath,
    runtimedWasmPath: parsed.runtimedWasmPath,
  };
}

function loadViewerRuntime(): ViewerRuntimeState {
  try {
    const config = loadConfig();
    return {
      kind: "ready",
      runtime: { config },
    };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function loadAuthConfig(): CloudViewerAuthConfig {
  const element = document.querySelector<HTMLScriptElement>("#nteract-cloud-auth-config");
  if (!element) {
    return { oidc: null };
  }
  try {
    const parsed = JSON.parse(element.textContent ?? "{}") as {
      oidc?: Partial<CloudOidcAuthConfig> | null;
    };
    return { oidc: normalizeOidcAuthConfig(parsed.oidc) };
  } catch {
    return { oidc: null };
  }
}

function isOidcCallbackPath(): boolean {
  return window.location.pathname.replace(/\/+$/, "") === "/oidc";
}

function App() {
  const [authConfig] = useState<CloudViewerAuthConfig>(() => loadAuthConfig());
  const [runtimeState] = useState<ViewerRuntimeState | null>(() =>
    isOidcCallbackPath() ? null : loadViewerRuntime(),
  );

  if (isOidcCallbackPath()) {
    return <OidcCallbackView authConfig={authConfig} />;
  }

  if (!runtimeState) {
    return <ViewerStartupError message="Unable to start cloud viewer: missing runtime state" />;
  }
  if (runtimeState.kind === "error") {
    return <ViewerStartupError message={`Unable to start cloud viewer: ${runtimeState.message}`} />;
  }

  return <NotebookViewer runtime={runtimeState.runtime} authConfig={authConfig} />;
}

function OidcCallbackView({ authConfig }: { authConfig: CloudViewerAuthConfig }) {
  const { theme, setTheme, resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const [status, setStatus] = useState<ViewerStatus>({
    kind: "loading",
    message: "Completing sign-in...",
  });

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const oidc = authConfig.oidc;
    if (!oidc) {
      setStatus({ kind: "error", message: "OIDC sign-in is not configured for this host." });
      return;
    }

    const params = new URLSearchParams(window.location.search);
    if (!params.has("code") || !params.has("state")) {
      setStatus({ kind: "empty", message: "No sign-in callback is pending." });
      return;
    }

    let cancelled = false;
    void completeOidcRedirect(oidc, {
      callbackUrl: window.location.href,
      storage: window.localStorage,
    })
      .then(({ returnUrl }) => {
        if (cancelled) return;
        setStatus({ kind: "ready", message: "Signed in. Returning to the notebook..." });
        window.location.replace(returnUrl);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [authConfig.oidc]);

  return (
    <main className="flex min-h-screen w-full flex-col px-8 py-4 pr-4">
      <div className="cloud-report-toolbar" aria-label="Sign-in status and controls">
        <h1 className="text-xl font-semibold tracking-normal">nteract cloud notebook</h1>
        <ThemeToggle theme={theme} onThemeChange={setTheme} className="cloud-theme-toggle" />
      </div>
      <div className="cloud-state" data-kind={status.kind}>
        {status.message}
      </div>
    </main>
  );
}

function NotebookViewer({
  runtime,
  authConfig,
}: {
  runtime: ViewerRuntime;
  authConfig: CloudViewerAuthConfig;
}) {
  const { config } = runtime;
  const { theme, setTheme, resolvedTheme } = useTheme(CLOUD_VIEWER_THEME_STORAGE_KEY);
  const { store: widgetStore } = useWidgetStoreRequired();
  const [status, setStatus] = useState<ViewerStatus>({
    kind: "loading",
    message: "Loading notebook snapshot...",
  });
  const [cells, setCells] = useState<ResolvedCell[]>([]);
  const [showCode, setShowCode] = useState(true);
  const cellsRef = useRef<ResolvedCell[]>([]);
  const notebookLanguageRef = useRef("python");
  const liveRuntimeRef = useRef<CloudSyncRuntime | null>(null);
  const liveMaterializedRef = useRef(false);
  const snapshotResolvedRef = useRef(false);
  const projectedWidgetCommIdsRef = useRef(new Set<string>());
  const [presence, setPresence] = useState(initialCloudViewerPresence);
  const [livePresence, setLivePresence] = useState(emptyCloudLivePresenceSnapshot);
  const [connectionScope, setConnectionScope] = useState<string | null>(null);
  const [connectionActorLabel, setConnectionActorLabel] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [textAttributionQueue, setTextAttributionQueue] = useState<CloudTextAttributionQueue>(
    () => ({ batches: [] }),
  );
  const [connectAttempt, setConnectAttempt] = useState(0);
  const [authState, setAuthState] = useState<CloudPrototypeAuthState>(() =>
    cloudPrototypeAuthFromWindow(),
  );
  const textAttributionSequenceRef = useRef(0);
  const blobResolver = useMemo(
    () =>
      createNotebookCloudBlobResolver({
        baseUrl: location.href,
        blobBasePath: config.blobBasePath,
        fetchImpl: (input, init) => fetchWithCloudPrototypeAuth(input, init, authState),
      }),
    [authState, config.blobBasePath],
  );
  const outputHostContext = useMemo<NteractEmbedHostContextPatch>(
    () => ({
      nteract: {
        rendererAssetsBaseUrl: new URL(config.rendererAssetsBasePath, location.href).href,
        outputDocumentUrl: config.outputDocumentBaseUrl
          ? new URL(config.outputDocumentBaseUrl, location.href).href
          : undefined,
      },
    }),
    [config.outputDocumentBaseUrl, config.rendererAssetsBasePath],
  );

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    cellsRef.current = cells;
  }, [cells]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(
          config.renderEndpoint,
          withCloudPrototypeAuthHeaders({ headers: { Accept: "application/json" } }, authState),
        );
        if (!response.ok) {
          if (!cancelled) {
            snapshotResolvedRef.current = true;
            setStatus({
              kind: response.status === 404 ? "empty" : "error",
              message:
                response.status === 404
                  ? "No published snapshot is available for this notebook yet."
                  : `Unable to load notebook render: ${response.status}`,
            });
          }
          return;
        }

        const render = (await response.json()) as SnapshotRender;
        const rawCells = Array.isArray(render.cells) ? (render.cells as RenderCell[]) : [];
        const widgetComms = normalizeSnapshotWidgetComms(render.widget_comms);
        const notebookLanguage = languageFromNotebookMetadata(render.metadata) ?? "python";
        notebookLanguageRef.current = notebookLanguage;
        const resolvedCells = await Promise.all(
          rawCells.map((cell, index) => resolveCell(cell, blobResolver, index, notebookLanguage)),
        );
        if (cancelled || liveMaterializedRef.current) return;

        snapshotResolvedRef.current = true;
        await projectCloudWidgetComms(widgetStore, widgetComms, projectedWidgetCommIdsRef, {
          isAllowedBlobUrl: (url) => isConfiguredBlobUrl(url, config.blobBasePath),
          shouldContinue: () => !cancelled && !liveMaterializedRef.current,
        });
        if (cancelled || liveMaterializedRef.current) return;
        preloadSiftWasmForCells(resolvedCells, {
          blobBasePath: config.blobBasePath,
          rendererAssetsBasePath: config.rendererAssetsBasePath,
          pageUrl: location.href,
        });
        setCells(resolvedCells);
        if (resolvedCells.length === 0) {
          setStatus({ kind: "empty", message: "This published notebook has no cells." });
          return;
        }

        const source = render.source === "snapshot-pair" ? "snapshot pair" : "render cache";
        setStatus({
          kind: "ready",
          message: `Rendering ${resolvedCells.length} cells from a persisted ${source}.`,
        });
      } catch (error) {
        if (!cancelled) {
          snapshotResolvedRef.current = true;
          setStatus({ kind: "error", message: `Unable to load notebook: ${String(error)}` });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authState, blobResolver, config.renderEndpoint, widgetStore]);

  useEffect(() => {
    let disposed = false;
    let subscriptions: Array<{ unsubscribe: () => void }> = [];
    let materializeSequence = 0;
    let livePresenceStore: CloudLivePresenceStore | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    const disposeCurrentRuntime = () => {
      const liveRuntime = liveRuntimeRef.current;
      if (!liveRuntime) return;
      liveRuntimeRef.current = null;
      disposeCloudSyncRuntime(liveRuntime);
    };
    const scheduleReconnect = (reason: Error) => {
      if (disposed) return;
      console.warn("[notebook-cloud] live room connection closed", reason);
      setPresence((state) => reduceCloudViewerConnection(state, "disconnected"));
      setConnectionScope(null);
      setConnectionActorLabel(null);
      setConnectionError(reason.message);
      disposeCurrentRuntime();
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!disposed) {
          setConnectAttempt((attempt) => attempt + 1);
        }
      }, 1_000);
    };

    const materializeLiveCells = async (liveRuntime: CloudSyncRuntime) => {
      const sequence = ++materializeSequence;
      const rawCells = JSON.parse(liveRuntime.handle.get_cells_json()) as RenderCell[];
      if (rawCells.length === 0) {
        if (!snapshotResolvedRef.current || cellsRef.current.length > 0) {
          return;
        }
      }
      const widgetComms = snapshotWidgetCommsFromRuntimeState(
        liveRuntime.handle.get_runtime_state(),
        blobResolver,
      );
      const metadata = parseJsonOrNull(liveRuntime.handle.get_metadata_snapshot_json?.());
      const notebookLanguage =
        languageFromNotebookMetadata(metadata) ?? notebookLanguageRef.current ?? "python";
      notebookLanguageRef.current = notebookLanguage;
      const resolvedCells = await Promise.all(
        rawCells.map((cell, index) => resolveCell(cell, blobResolver, index, notebookLanguage)),
      );
      if (disposed || sequence !== materializeSequence) return;

      await projectCloudWidgetComms(widgetStore, widgetComms, projectedWidgetCommIdsRef, {
        isAllowedBlobUrl: (url) => isConfiguredBlobUrl(url, config.blobBasePath),
        shouldContinue: () => !disposed && sequence === materializeSequence,
      });
      if (disposed || sequence !== materializeSequence) return;
      liveMaterializedRef.current = true;
      setCells(resolvedCells);
      setStatus(
        resolvedCells.length === 0
          ? { kind: "empty", message: "This notebook room has no cells yet." }
          : {
              kind: "ready",
              message: `Rendering ${resolvedCells.length} cells from the live notebook room.`,
            },
      );
    };

    const materializeLiveCellsSafely = (liveRuntime: CloudSyncRuntime) => {
      void materializeLiveCells(liveRuntime).catch((error: unknown) => {
        if (disposed) return;
        console.warn("[notebook-cloud] live room materialization failed", error);
      });
    };

    setPresence(initialCloudViewerPresence());
    setLivePresence(emptyCloudLivePresenceSnapshot());
    setConnectionError(null);
    setConnectionActorLabel(null);
    setTextAttributionQueue({ batches: [] });
    void connectCloudSyncRuntime({
      syncEndpoint: config.syncEndpoint,
      runtimedWasmModulePath: config.runtimedWasmModulePath,
      runtimedWasmPath: config.runtimedWasmPath,
      sessionId,
      auth: cloudSyncAuthFromPrototypeAuthState(authState),
      onDisconnect: scheduleReconnect,
      onControl: (message) => {
        if (disposed) return;
        if (
          message.type === "cloud_room_ready" ||
          message.type === "cloud_peer_joined" ||
          message.type === "cloud_peer_left"
        ) {
          setPresence((state) => reduceCloudViewerPresenceMessage(state, message));
        }
        if (message.type === "cloud_room_ready") {
          setConnectionError(null);
          setConnectionScope(message.connection_scope);
          setConnectionActorLabel(message.actor_label);
        }
        if (message.type === "cloud_frame_rejected") {
          setStatus({ kind: "error", message: `Room rejected a frame: ${message.reason}` });
        }
      },
    })
      .then((liveRuntime) => {
        if (disposed) {
          disposeCloudSyncRuntime(liveRuntime);
          return;
        }
        liveRuntimeRef.current = liveRuntime;
        setConnectionScope(liveRuntime.connectionScope);
        setConnectionActorLabel(liveRuntime.actorLabel);
        livePresenceStore = new CloudLivePresenceStore(liveRuntime.peerId);
        setLivePresence(livePresenceStore.snapshot());
        subscriptions = [
          liveRuntime.engine.broadcasts$.subscribe((payload) => {
            if (!isTextAttributionEvent(payload)) return;
            const sequence = ++textAttributionSequenceRef.current;
            setTextAttributionQueue((queue) => {
              const nextBatch = { sequence, attributions: payload.attributions };
              return {
                batches: [...queue.batches.slice(-63), nextBatch],
              };
            });
          }),
          liveRuntime.engine.presence$.subscribe((payload) => {
            const snapshot = livePresenceStore?.handlePresence(payload);
            if (snapshot) {
              setLivePresence(snapshot);
            }
          }),
          liveRuntime.engine.cellChanges$.subscribe(() => {
            materializeLiveCellsSafely(liveRuntime);
          }),
          liveRuntime.engine.runtimeState$.subscribe(() => {
            materializeLiveCellsSafely(liveRuntime);
          }),
        ];
        materializeLiveCellsSafely(liveRuntime);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setPresence((state) => reduceCloudViewerConnection(state, "disconnected"));
        setConnectionScope(null);
        setConnectionActorLabel(null);
        setConnectionError(error instanceof Error ? error.message : String(error));
        console.warn("[notebook-cloud] live room connection failed", error);
      });

    return () => {
      disposed = true;
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      disposeCurrentRuntime();
      livePresenceStore = null;
      setPresence((state) => reduceCloudViewerConnection(state, "disconnected"));
      setLivePresence(emptyCloudLivePresenceSnapshot());
    };
  }, [authState, blobResolver, config.syncEndpoint, connectAttempt, widgetStore]);

  const readOnlyCells = useMemo(
    () =>
      cells.map(
        (cell): ReadOnlyNotebookCellData => ({
          id: cell.id,
          cellType: cell.cellType,
          source: cell.source,
          language: cloudSourceLanguage(cell.language),
          outputs: cell.outputs,
          executionId: cell.executionId,
          executionCount: cell.executionCount,
        }),
      ),
    [cells],
  );
  const codeCellCount = useMemo(
    () => readOnlyCells.filter((cell) => cell.cellType === "code").length,
    [readOnlyCells],
  );
  const tracebackTargets = useMemo(() => {
    const targets = new Map<string, TracebackCellTarget>();
    for (const cell of cells) {
      if (!cell.executionId) continue;
      targets.set(cell.executionId, {
        cellId: cell.id,
      });
    }
    return targets;
  }, [cells]);
  const resolveTracebackExecutionTarget = useCallback(
    (executionId: string) => tracebackTargets.get(executionId) ?? null,
    [tracebackTargets],
  );
  const handleTracebackCellNavigate = useCallback((target: TracebackCellTarget) => {
    findCellElement(target.cellId)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, []);
  const canEditMarkdown = canEditLiveNotebook(connectionScope);
  const getLiveNotebookHandle = useCallback(() => liveRuntimeRef.current?.handle ?? null, []);
  const handleMarkdownSourceChange = useCallback(
    (cellId: string, source: string) => {
      if (!canEditMarkdown) return;
      const currentCell = cellsRef.current.find((cell) => cell.id === cellId);
      if (currentCell?.cellType !== "markdown") return;

      setCells((current) =>
        current.map((cell) => (cell.id === cellId ? { ...cell, source } : cell)),
      );
    },
    [canEditMarkdown],
  );
  const handleMarkdownSyncNeeded = useCallback(() => {
    if (!canEditMarkdown) return;
    liveRuntimeRef.current?.engine.scheduleFlush();
  }, [canEditMarkdown]);
  const handlePresenceCursor = useCallback((cellId: string, line: number, column: number) => {
    liveRuntimeRef.current?.sendCursorPresence(cellId, line, column);
  }, []);
  const handlePresenceSelection = useCallback(
    (cellId: string, anchorLine: number, anchorCol: number, headLine: number, headCol: number) => {
      liveRuntimeRef.current?.sendSelectionPresence(
        cellId,
        anchorLine,
        anchorCol,
        headLine,
        headCol,
      );
    },
    [],
  );
  const resetPrototypeAuth = useCallback(() => {
    clearCloudPrototypeDevAuth(window.localStorage);
    setAuthState(cloudPrototypeAuthFromWindow());
  }, []);

  return (
    <main className="flex min-h-screen w-full flex-col py-6">
      <h1 className="sr-only">nteract cloud notebook {config.notebookId}</h1>

      <div className="cloud-report-toolbar" aria-label="Notebook view status and controls">
        <CloudPresenceStatus presence={presence} connectionScope={connectionScope} />

        <div className="cloud-toolbar-actions">
          <ThemeToggle theme={theme} onThemeChange={setTheme} className="cloud-theme-toggle" />

          <CloudAuthControls
            authConfig={authConfig}
            authState={authState}
            connectionActorLabel={connectionActorLabel}
            connectionError={connectionError}
            connectionScope={connectionScope}
            onAuthStateChange={() => setAuthState(cloudPrototypeAuthFromWindow())}
          />

          {status.kind === "ready" && codeCellCount > 0 ? (
            <button
              type="button"
              className="cloud-code-toggle"
              aria-pressed={showCode}
              aria-label={showCode ? "Hide code cells" : "Show code cells"}
              title={showCode ? "Hide code cells" : "Show code cells"}
              onClick={() => setShowCode((current) => !current)}
            >
              {showCode ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              <Code2 aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      {authState.mode === "invalid" ? (
        <div className="cloud-state cloud-auth-state mx-8 mr-4" data-kind="error">
          <span>{prototypeAuthSummary(authState)}</span>
          <button type="button" onClick={resetPrototypeAuth}>
            <RotateCcw aria-hidden="true" />
            Reset to anonymous
          </button>
        </div>
      ) : null}

      {connectionError ? (
        <div className="cloud-state cloud-auth-state mx-8 mr-4" data-kind="error">
          <span>Live room connection failed: {connectionError}</span>
          <button type="button" onClick={resetPrototypeAuth}>
            <RotateCcw aria-hidden="true" />
            Reset to anonymous
          </button>
        </div>
      ) : null}

      {status.kind === "ready" ? null : (
        <div className="cloud-state mx-8 mr-4" data-kind={status.kind}>
          {status.message}
        </div>
      )}

      {canEditMarkdown ? (
        <CloudLiveNotebook
          cells={cells}
          priority={CLOUD_VIEWER_PRIORITY}
          hostContext={outputHostContext}
          showCode={showCode}
          livePresence={livePresence}
          getHandle={getLiveNotebookHandle}
          localActorLabel={connectionActorLabel}
          textAttributionQueue={textAttributionQueue}
          onMarkdownSourceChange={handleMarkdownSourceChange}
          onMarkdownSyncNeeded={handleMarkdownSyncNeeded}
          onPresenceCursor={handlePresenceCursor}
          onPresenceSelection={handlePresenceSelection}
          resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
          onNavigateToTracebackCell={handleTracebackCellNavigate}
        />
      ) : (
        <ReadOnlyNotebook
          cells={readOnlyCells}
          priority={CLOUD_VIEWER_PRIORITY}
          hostContext={outputHostContext}
          displayMode="report"
          showCode={showCode}
          className="cloud-report-notebook"
          cellClassName="cloud-cell"
          sourceClassName="cloud-source-block"
          outputClassName="cloud-output-block"
          resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
          onNavigateToTracebackCell={handleTracebackCellNavigate}
          renderCellError={(error, _cell, index) => (
            <div className="cloud-state" data-kind="error">
              Unable to render cell {index + 1}: {error.message}
            </div>
          )}
        />
      )}
    </main>
  );
}

function CloudAuthControls({
  authConfig,
  authState,
  connectionActorLabel,
  connectionError,
  connectionScope,
  onAuthStateChange,
}: {
  authConfig: CloudViewerAuthConfig;
  authState: CloudPrototypeAuthState;
  connectionActorLabel: string | null;
  connectionError: string | null;
  connectionScope: string | null;
  onAuthStateChange: () => void;
}) {
  const [token, setToken] = useState("");
  const [user, setUser] = useState(authState.user ?? "alice");
  const [scope, setScope] = useState<ConnectionScope>(authState.requestedScope ?? "editor");
  const [formError, setFormError] = useState<string | null>(null);
  const [authAction, setAuthAction] = useState<"idle" | "starting">("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const summary =
    authState.mode === "dev"
      ? `Dev ${authState.user ?? "browser-editor"}`
      : authState.mode === "oidc"
        ? (authState.user ?? "Signed in")
        : authState.mode === "access"
          ? "Browser session"
          : authState.mode === "invalid"
            ? "Auth needs attention"
            : "Anonymous";
  const diagnostics = prototypeAuthDiagnostics(authState, {
    actorLabel: connectionActorLabel,
    connectionError,
    connectionScope,
  });
  useEffect(() => {
    setCopyState("idle");
  }, [authState, connectionActorLabel, connectionError, connectionScope]);

  const applyDevAuth = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = validatePrototypeToken(token);
    if (problem) {
      setFormError(problem);
      return;
    }
    storeCloudPrototypeDevAuth(window.localStorage, { token, user, scope });
    setToken("");
    setFormError(null);
    onAuthStateChange();
  };

  const beginOidcAuth = async () => {
    if (!authConfig.oidc) {
      setFormError("OIDC sign-in is not configured for this host.");
      return;
    }
    try {
      setAuthAction("starting");
      window.localStorage.setItem(NOTEBOOK_CLOUD_SCOPE_STORAGE_KEY, scope);
      const url = await beginOidcLogin(authConfig.oidc, {
        currentUrl: window.location.href,
        storage: window.localStorage,
      });
      window.location.assign(url.href);
    } catch (error) {
      setAuthAction("idle");
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const resetAuth = () => {
    clearCloudPrototypeDevAuth(window.localStorage);
    setToken("");
    setFormError(null);
    onAuthStateChange();
  };

  const applyAccessAuth = () => {
    storeCloudAccessAuth(window.localStorage, { scope });
    setToken("");
    setFormError(null);
    onAuthStateChange();
  };

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics.copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <details className="cloud-auth-menu">
      <summary title="Prototype collaborator identity">
        <KeyRound aria-hidden="true" />
        <span>{summary}</span>
      </summary>
      <form onSubmit={applyDevAuth}>
        <p>{prototypeAuthSummary(authState)}</p>
        <dl className="cloud-auth-diagnostics" aria-label="Prototype auth diagnostics">
          {diagnostics.rows.map((row) => (
            <div key={row.label} data-tone={row.tone ?? "default"}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        <label>
          <span>Dev token</span>
          <input
            type="password"
            value={token}
            placeholder="Worker dev token"
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <label>
          <span>User</span>
          <input
            type="text"
            value={user}
            autoComplete="off"
            onChange={(event) => setUser(event.target.value)}
          />
        </label>
        <label>
          <span>Scope</span>
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value as ConnectionScope)}
          >
            <option value="editor">editor</option>
            <option value="owner">owner</option>
            <option value="runtime_peer">runtime_peer</option>
            <option value="viewer">viewer</option>
          </select>
        </label>
        {formError ? (
          <div className="cloud-auth-form-error" role="alert">
            {formError}
          </div>
        ) : null}
        <div className="cloud-auth-actions">
          {authState.mode === "oidc" ? (
            <button
              type="button"
              onClick={() => {
                clearCloudOidcAuth(window.localStorage);
                onAuthStateChange();
              }}
            >
              <LogOut aria-hidden="true" />
              Sign out
            </button>
          ) : authConfig.oidc ? (
            <button type="button" disabled={authAction === "starting"} onClick={beginOidcAuth}>
              <LogIn aria-hidden="true" />
              {authAction === "starting" ? "Starting sign-in" : "Sign in"}
            </button>
          ) : null}
          <button type="submit">
            <KeyRound aria-hidden="true" />
            Use dev identity
          </button>
          <button type="button" onClick={applyAccessAuth}>
            <KeyRound aria-hidden="true" />
            Use browser session
          </button>
          <button type="button" onClick={() => void copyDiagnostics()}>
            <Copy aria-hidden="true" />
            {copyState === "copied"
              ? "Copied"
              : copyState === "failed"
                ? "Copy failed"
                : "Copy diagnostics"}
          </button>
          <button type="button" onClick={resetAuth}>
            <RotateCcw aria-hidden="true" />
            Anonymous
          </button>
        </div>
      </form>
    </details>
  );
}

function disposeCloudSyncRuntime(liveRuntime: CloudSyncRuntime): void {
  liveRuntime.engine.stop();
  liveRuntime.transport.disconnect();
  liveRuntime.handle.free();
}

function findCellElement(cellId: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>("[data-cell-id]")) {
    if (element.dataset.cellId === cellId) return element;
  }
  return null;
}

function CloudLiveNotebook({
  cells,
  priority,
  hostContext,
  showCode,
  getHandle,
  localActorLabel,
  textAttributionQueue,
  onMarkdownSourceChange,
  onMarkdownSyncNeeded,
  livePresence,
  onPresenceCursor,
  onPresenceSelection,
  resolveTracebackExecutionTarget,
  onNavigateToTracebackCell,
}: {
  cells: ResolvedCell[];
  priority: readonly string[];
  hostContext: NteractEmbedHostContextPatch;
  showCode: boolean;
  getHandle: () => CloudSyncRuntime["handle"] | null;
  localActorLabel: string | null;
  textAttributionQueue: CloudTextAttributionQueue;
  livePresence: CloudLivePresenceSnapshot;
  onMarkdownSourceChange: (cellId: string, source: string) => void;
  onMarkdownSyncNeeded: () => void;
  onPresenceCursor: (cellId: string, line: number, column: number) => void;
  onPresenceSelection: (
    cellId: string,
    anchorLine: number,
    anchorCol: number,
    headLine: number,
    headCol: number,
  ) => void;
  resolveTracebackExecutionTarget: (executionId: string) => TracebackCellTarget | null;
  onNavigateToTracebackCell: (target: TracebackCellTarget) => void;
}) {
  return (
    <section
      aria-label="Notebook cells"
      className="cloud-report-notebook flex min-h-0 flex-1 flex-col overflow-x-clip overscroll-x-contain"
      data-cell-count={cells.length}
      data-slot="cloud-live-notebook"
    >
      {cells.map((cell, index) => (
        <ErrorBoundary
          key={cell.id}
          resetKeys={[
            cell.id,
            cell.cellType,
            cell.source,
            cell.language,
            cell.executionCount,
            cell.outputs.length,
          ]}
          fallback={(error) => (
            <div className="cloud-state" data-kind="error">
              Unable to render cell {index + 1}: {error.message}
            </div>
          )}
        >
          {cell.cellType === "markdown" ? (
            <EditableMarkdownCell
              cell={cell}
              className="cloud-cell cloud-editable-markdown-cell"
              sourceClassName="cloud-source-block"
              onSourceChange={onMarkdownSourceChange}
              onSyncNeeded={onMarkdownSyncNeeded}
              getHandle={getHandle}
              localActorLabel={localActorLabel}
              textAttributionQueue={textAttributionQueue}
              remotePresence={presenceForCell(livePresence, cell.id)}
              onPresenceCursor={onPresenceCursor}
              onPresenceSelection={onPresenceSelection}
            />
          ) : (
            <ReadOnlyNotebookCell
              id={cell.id}
              cellType={cell.cellType}
              source={cell.source}
              language={cloudSourceLanguage(cell.language)}
              outputs={cell.outputs}
              executionCount={cell.executionCount}
              priority={priority}
              hostContext={hostContext}
              displayMode="report"
              showSource={cell.cellType !== "code" || showCode}
              className="cloud-cell"
              sourceClassName="cloud-source-block"
              outputClassName="cloud-output-block"
              resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
              onNavigateToTracebackCell={onNavigateToTracebackCell}
            />
          )}
        </ErrorBoundary>
      ))}
    </section>
  );
}

function CloudPresenceStatus({
  presence,
  connectionScope,
}: {
  presence: CloudViewerPresenceState;
  connectionScope: string | null;
}) {
  const presenceDisplay = cloudViewerPresenceDisplay(presence);
  const scopeLabel =
    connectionScope === "editor" || connectionScope === "owner"
      ? "editing"
      : connectionScope === "viewer"
        ? "viewing"
        : null;

  return (
    <div
      className="cloud-presence"
      data-connected={String(presenceDisplay.connected)}
      title={scopeLabel ? `${presenceDisplay.title}; ${scopeLabel}` : presenceDisplay.title}
      aria-label={presenceDisplay.title}
      aria-live="polite"
    >
      <UsersRound aria-hidden="true" />
      <span>{scopeLabel ? `${presenceDisplay.label} · ${scopeLabel}` : presenceDisplay.label}</span>
    </div>
  );
}

function presenceForCell(
  livePresence: CloudLivePresenceSnapshot,
  cellId: string,
): RemoteCellPresence {
  return livePresence.cells.get(cellId) ?? EMPTY_REMOTE_CELL_PRESENCE;
}

const EMPTY_REMOTE_CELL_PRESENCE: RemoteCellPresence = {
  cursors: [],
  selections: [],
};

function canEditLiveNotebook(connectionScope: string | null): boolean {
  return connectionScope === "editor" || connectionScope === "owner";
}

function ViewerStartupError({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen w-full flex-col px-8 py-4 pr-4">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-normal">nteract cloud notebook</h1>
      </header>
      <div className="cloud-state" data-kind="error">
        {message}
      </div>
    </main>
  );
}

function languageFromNotebookMetadata(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const languageInfo = (metadata as Record<string, unknown>).language_info;
  if (typeof languageInfo !== "object" || languageInfo === null) return null;
  const name = (languageInfo as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

function parseJsonOrNull(value: string | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isConfiguredBlobUrl(value: string, blobBasePath: string): boolean {
  try {
    const url = new URL(value, location.href);
    const base = new URL(blobBasePath, location.href);
    const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    return url.origin === base.origin && url.pathname.startsWith(basePath);
  } catch {
    return false;
  }
}

createRoot(requireElement("#root")).render(
  <ErrorBoundary
    fallback={(error) => <ViewerStartupError message={`Cloud viewer crashed: ${error.message}`} />}
  >
    <IsolatedRendererProvider loader={rendererBundle}>
      <CloudWidgetStoreProvider>
        <MediaProvider priority={CLOUD_VIEWER_PRIORITY} renderers={CLOUD_WIDGET_RENDERERS}>
          <App />
        </MediaProvider>
      </CloudWidgetStoreProvider>
    </IsolatedRendererProvider>
  </ErrorBoundary>,
);
