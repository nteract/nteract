import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Code2, Eye, EyeOff, KeyRound, RotateCcw, UsersRound } from "lucide-react";
import {
  ReadOnlyNotebook,
  type ReadOnlyNotebookCellData,
} from "@/components/cell/ReadOnlyNotebook";
import { ReadOnlyNotebookCell } from "@/components/cell/ReadOnlyNotebookCell";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { MediaProvider } from "@/components/outputs/media-provider";
import type { TracebackCellTarget } from "@/components/outputs/traceback-output";
import { ErrorBoundary } from "@/lib/error-boundary";
import { createNotebookCloudBlobResolver } from "../src/blob-resolver";
import { EditableMarkdownCell } from "./editable-markdown-cell";
import type { RemoteCellPresence } from "@/components/editor/presence-state";
import {
  clearCloudPrototypeDevAuth,
  cloudPrototypeAuthFromWindow,
  cloudSyncAuthFromPrototypeAuthState,
  prototypeAuthSummary,
  storeCloudPrototypeDevAuth,
  validatePrototypeToken,
  type CloudPrototypeAuthState,
} from "./collaborator-auth";
import { connectCloudSyncRuntime, type CloudSyncRuntime } from "./live-sync";
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
import { installDocumentThemeSync } from "./theme";
import "./index.css";

interface CloudViewerConfig {
  notebookId: string;
  headsHash: string | null;
  renderEndpoint: string;
  syncEndpoint: string;
  blobBasePath: string;
  rendererAssetsBasePath: string;
  runtimedWasmModulePath: string;
  runtimedWasmPath: string;
}

interface SnapshotRender {
  heads_hash?: string;
  metadata?: unknown;
  source?: string;
  cells?: unknown;
}

type ViewerStatus =
  | { kind: "loading"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "ready"; message: string }
  | { kind: "error"; message: string };

interface ViewerRuntime {
  config: CloudViewerConfig;
  blobResolver: ReturnType<typeof createNotebookCloudBlobResolver>;
  outputHostContext: NteractEmbedHostContextPatch;
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
    runtimedWasmModulePath: parsed.runtimedWasmModulePath,
    runtimedWasmPath: parsed.runtimedWasmPath,
  };
}

function loadViewerRuntime(): ViewerRuntimeState {
  try {
    const config = loadConfig();
    return {
      kind: "ready",
      runtime: {
        config,
        blobResolver: createNotebookCloudBlobResolver({
          baseUrl: location.href,
          blobBasePath: config.blobBasePath,
        }),
        outputHostContext: {
          nteract: {
            rendererAssetsBaseUrl: new URL(config.rendererAssetsBasePath, location.href).href,
          },
        },
      },
    };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function App() {
  const [runtimeState] = useState<ViewerRuntimeState>(() => loadViewerRuntime());

  if (runtimeState.kind === "error") {
    return <ViewerStartupError message={`Unable to start cloud viewer: ${runtimeState.message}`} />;
  }

  return <NotebookViewer runtime={runtimeState.runtime} />;
}

function NotebookViewer({ runtime }: { runtime: ViewerRuntime }) {
  const { config, blobResolver, outputHostContext } = runtime;
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
  const [presence, setPresence] = useState(initialCloudViewerPresence);
  const [livePresence, setLivePresence] = useState(emptyCloudLivePresenceSnapshot);
  const [connectionScope, setConnectionScope] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const [authState, setAuthState] = useState<CloudPrototypeAuthState>(() =>
    cloudPrototypeAuthFromWindow(),
  );

  useEffect(() => {
    cellsRef.current = cells;
  }, [cells]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(config.renderEndpoint, {
          headers: { Accept: "application/json" },
        });
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
        const notebookLanguage = languageFromNotebookMetadata(render.metadata) ?? "python";
        notebookLanguageRef.current = notebookLanguage;
        const resolvedCells = await Promise.all(
          rawCells.map((cell, index) => resolveCell(cell, blobResolver, index, notebookLanguage)),
        );
        if (cancelled || liveMaterializedRef.current) return;

        snapshotResolvedRef.current = true;
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
  }, [blobResolver, config.renderEndpoint]);

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
      const metadata = parseJsonOrNull(liveRuntime.handle.get_metadata_snapshot_json?.());
      const notebookLanguage =
        languageFromNotebookMetadata(metadata) ?? notebookLanguageRef.current ?? "python";
      notebookLanguageRef.current = notebookLanguage;
      const resolvedCells = await Promise.all(
        rawCells.map((cell, index) => resolveCell(cell, blobResolver, index, notebookLanguage)),
      );
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

    setPresence(initialCloudViewerPresence());
    setLivePresence(emptyCloudLivePresenceSnapshot());
    setConnectionError(null);
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
        livePresenceStore = new CloudLivePresenceStore(liveRuntime.peerId);
        setLivePresence(livePresenceStore.snapshot());
        subscriptions = [
          liveRuntime.engine.presence$.subscribe((payload) => {
            const snapshot = livePresenceStore?.handlePresence(payload);
            if (snapshot) {
              setLivePresence(snapshot);
            }
          }),
          liveRuntime.engine.cellChanges$.subscribe(() => {
            void materializeLiveCells(liveRuntime);
          }),
          liveRuntime.engine.runtimeState$.subscribe(() => {
            void materializeLiveCells(liveRuntime);
          }),
        ];
        void materializeLiveCells(liveRuntime);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setPresence((state) => reduceCloudViewerConnection(state, "disconnected"));
        setConnectionScope(null);
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
  }, [authState, blobResolver, config.syncEndpoint, connectAttempt]);

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
          <CloudAuthControls
            authState={authState}
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
          focusOutputs
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
  authState,
  connectionScope,
  onAuthStateChange,
}: {
  authState: CloudPrototypeAuthState;
  connectionScope: string | null;
  onAuthStateChange: () => void;
}) {
  const [token, setToken] = useState("");
  const [user, setUser] = useState(authState.user ?? "alice");
  const [scope, setScope] = useState<ConnectionScope>(authState.requestedScope ?? "editor");
  const [formError, setFormError] = useState<string | null>(null);
  const summary =
    authState.mode === "dev"
      ? `Dev ${authState.user ?? "browser-editor"}`
      : authState.mode === "invalid"
        ? "Auth needs attention"
        : "Anonymous";

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

  const resetAuth = () => {
    clearCloudPrototypeDevAuth(window.localStorage);
    setToken("");
    setFormError(null);
    onAuthStateChange();
  };

  return (
    <details className="cloud-auth-menu">
      <summary title="Prototype collaborator identity">
        <KeyRound aria-hidden="true" />
        <span>{summary}</span>
      </summary>
      <form onSubmit={applyDevAuth}>
        <p>{prototypeAuthSummary(authState)}</p>
        {connectionScope ? <p>Connected as {connectionScope}.</p> : <p>Live room not connected.</p>}
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
          <button type="submit">
            <KeyRound aria-hidden="true" />
            Use dev identity
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
              focusOutputs
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

createRoot(requireElement("#root")).render(
  <ErrorBoundary
    fallback={(error) => <ViewerStartupError message={`Cloud viewer crashed: ${error.message}`} />}
  >
    <IsolatedRendererProvider loader={rendererBundle}>
      <MediaProvider priority={CLOUD_VIEWER_PRIORITY}>
        <App />
      </MediaProvider>
    </IsolatedRendererProvider>
  </ErrorBoundary>,
);
