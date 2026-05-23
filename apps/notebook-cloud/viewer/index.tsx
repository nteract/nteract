import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Code2, Eye, EyeOff, UsersRound } from "lucide-react";
import {
  ReadOnlyNotebook,
  type ReadOnlyNotebookCellData,
} from "@/components/cell/ReadOnlyNotebook";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { MediaProvider } from "@/components/outputs/media-provider";
import type { TracebackCellTarget } from "@/components/outputs/traceback-output";
import { ErrorBoundary } from "@/lib/error-boundary";
import { createNotebookCloudBlobResolver } from "../src/blob-resolver";
import type { SessionControlMessage } from "../src/protocol";
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
    !parsed.rendererAssetsBasePath
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

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(config.renderEndpoint, {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          if (!cancelled) {
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
        const resolvedCells = await Promise.all(
          rawCells.map((cell, index) => resolveCell(cell, blobResolver, index, notebookLanguage)),
        );
        if (cancelled) return;

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
          setStatus({ kind: "error", message: `Unable to load notebook: ${String(error)}` });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [blobResolver, config.renderEndpoint]);

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

  return (
    <main className="flex min-h-screen w-full flex-col py-6">
      <h1 className="sr-only">nteract cloud notebook {config.notebookId}</h1>

      <div className="cloud-report-toolbar" aria-label="Notebook view status and controls">
        <CloudPresenceStatus syncEndpoint={config.syncEndpoint} />

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
        ) : (
          <span aria-hidden="true" />
        )}
      </div>

      {status.kind === "ready" ? null : (
        <div className="cloud-state mx-8 mr-4" data-kind={status.kind}>
          {status.message}
        </div>
      )}

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
    </main>
  );
}

function findCellElement(cellId: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>("[data-cell-id]")) {
    if (element.dataset.cellId === cellId) return element;
  }
  return null;
}

function CloudPresenceStatus({ syncEndpoint }: { syncEndpoint: string }) {
  const [presence, setPresence] = useState(initialCloudViewerPresence);

  useEffect(
    () =>
      connectAnonymousViewer(syncEndpoint, (update) => {
        setPresence(update);
      }),
    [syncEndpoint],
  );

  const presenceDisplay = cloudViewerPresenceDisplay(presence);

  return (
    <div
      className="cloud-presence"
      data-connected={String(presenceDisplay.connected)}
      title={presenceDisplay.title}
      aria-label={presenceDisplay.title}
      aria-live="polite"
    >
      <UsersRound aria-hidden="true" />
      <span>{presenceDisplay.label}</span>
    </div>
  );
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

function connectAnonymousViewer(
  syncEndpoint: string,
  updatePresence: (update: (state: CloudViewerPresenceState) => CloudViewerPresenceState) => void,
): () => void {
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  const url = new URL(syncEndpoint, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("viewer_session", sessionId);

  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let closed = false;
  const updatePresenceIfActive = (
    update: (state: CloudViewerPresenceState) => CloudViewerPresenceState,
  ) => {
    if (!closed) {
      updatePresence(update);
    }
  };
  socket.addEventListener("open", () => {
    updatePresenceIfActive((state) => reduceCloudViewerConnection(state, "connected"));
  });
  socket.addEventListener("error", () => {
    updatePresenceIfActive((state) => reduceCloudViewerConnection(state, "disconnected"));
  });
  socket.addEventListener("close", () => {
    updatePresenceIfActive((state) => reduceCloudViewerConnection(state, "disconnected"));
  });
  socket.addEventListener("message", async (event) => {
    if (closed) return;
    const bytes = new Uint8Array(event.data);
    if (bytes[0] !== 0x07) {
      return;
    }
    const message = JSON.parse(new TextDecoder().decode(bytes.slice(1))) as SessionControlMessage;
    if (
      message.type === "cloud_room_ready" ||
      message.type === "cloud_peer_joined" ||
      message.type === "cloud_peer_left"
    ) {
      updatePresenceIfActive((state) => reduceCloudViewerPresenceMessage(state, message));
    }
  });

  return () => {
    closed = true;
    socket.close();
  };
}

function languageFromNotebookMetadata(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const languageInfo = (metadata as Record<string, unknown>).language_info;
  if (typeof languageInfo !== "object" || languageInfo === null) return null;
  const name = (languageInfo as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
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
