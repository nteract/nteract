import { type ReactNode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CellContainer } from "@/components/cell/CellContainer";
import { ExecutionCount } from "@/components/cell/ExecutionCount";
import { OutputArea } from "@/components/cell/OutputArea";
import type { JupyterOutput } from "@/components/cell/jupyter-output";
import { StaticCodeBlock } from "@/components/editor/static-highlight";
import { IsolatedRendererProvider } from "@/components/isolated/isolated-renderer-context";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import {
  isOutputManifest,
  resolveManifest,
  type OutputManifest,
} from "@/components/isolated/output-manifest";
import { MediaProvider } from "@/components/outputs/media-provider";
import { useColorTheme, useDarkMode } from "@/lib/dark-mode";
import { ErrorBoundary } from "@/lib/error-boundary";
import { createNotebookCloudBlobResolver } from "../src/blob-resolver";
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
  source?: string;
  cells?: unknown;
}

interface RenderCell {
  id?: unknown;
  cell_type?: unknown;
  source?: unknown;
  execution_count?: unknown;
  outputs?: unknown;
  metadata?: unknown;
}

interface ResolvedCell {
  id: string;
  cellType: "code" | "markdown" | "raw";
  source: string;
  executionCount: number | null;
  outputs: JupyterOutput[];
  metadata: Record<string, unknown>;
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
  const [connection, setConnection] = useState("anonymous viewer connecting");
  const [revision, setRevision] = useState("");
  const [cells, setCells] = useState<ResolvedCell[]>([]);

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
        const resolvedCells = await Promise.all(
          rawCells.map((cell, index) => resolveCell(cell, blobResolver, index)),
        );
        if (cancelled) return;

        setRevision(render.heads_hash ? `Revision ${render.heads_hash}` : "");
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

  useEffect(
    () => connectAnonymousViewer(config.syncEndpoint, setConnection),
    [config.syncEndpoint],
  );

  return (
    <main className="flex min-h-screen w-full flex-col py-4">
      <header className="mb-4 flex flex-col gap-3 px-8 pr-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">nteract cloud notebook</h1>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>
              Notebook <code className="text-foreground">{config.notebookId}</code>
            </span>
            {revision ? <span>{revision}</span> : null}
            <span>{connection}</span>
          </div>
        </div>
        <nav className="flex flex-wrap gap-2" aria-label="Notebook links">
          <a
            className="cloud-link-button"
            href={`/n/${encodeURIComponent(config.notebookId)}/debug`}
          >
            Debug
          </a>
          <a className="cloud-link-button" href={`/api/n/${encodeURIComponent(config.notebookId)}`}>
            Catalog JSON
          </a>
        </nav>
      </header>

      <div className="cloud-state mx-8 mr-4" data-kind={status.kind}>
        {status.message}
      </div>

      <section
        className="mt-4 flex min-h-0 flex-1 flex-col overflow-x-clip overscroll-x-contain pl-8 pr-2"
        aria-label="Notebook cells"
      >
        {cells.map((cell, index) => (
          <ErrorBoundary
            key={`${cell.id}:${index}`}
            resetKeys={[cell]}
            fallback={(error) => (
              <div className="cloud-state" data-kind="error">
                Unable to render cell {index + 1}: {error.message}
              </div>
            )}
          >
            <ReadonlyNotebookCell cell={cell} outputHostContext={outputHostContext} />
          </ErrorBoundary>
        ))}
      </section>
    </main>
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

function ReadonlyNotebookCell({
  cell,
  outputHostContext,
}: {
  cell: ResolvedCell;
  outputHostContext: NteractEmbedHostContextPatch;
}) {
  const codeContent = useMemo(
    () => renderCellSource(cell, outputHostContext),
    [cell, outputHostContext],
  );
  const outputContent =
    cell.outputs.length > 0 ? (
      <OutputArea
        cellId={cell.id}
        executionCount={cell.executionCount}
        outputs={cell.outputs}
        isolated="auto"
        hostContext={outputHostContext}
      />
    ) : null;

  return (
    <CellContainer
      id={cell.id}
      cellType={cell.cellType}
      codeContent={codeContent}
      outputContent={outputContent}
      gutterContent={
        cell.cellType === "code" ? <ExecutionCount count={cell.executionCount} /> : null
      }
      className="cloud-cell"
    />
  );
}

function renderCellSource(
  cell: ResolvedCell,
  outputHostContext: NteractEmbedHostContextPatch,
): ReactNode {
  if (cell.cellType === "markdown") {
    return (
      <OutputArea
        cellId={cell.id}
        outputs={[
          {
            output_type: "display_data",
            data: { "text/markdown": cell.source },
            metadata: {},
          },
        ]}
        isolated="auto"
        hostContext={outputHostContext}
      />
    );
  }

  return (
    <ReadonlySource source={cell.source} language={cell.cellType === "code" ? "python" : ""} />
  );
}

function ReadonlySource({ source, language }: { source: string; language: string }) {
  const isDark = useDarkMode();
  const colorTheme = (useColorTheme() ?? "classic") as "classic" | "cream";

  return (
    <StaticCodeBlock
      code={source}
      language={language}
      isDark={isDark}
      colorTheme={colorTheme}
      className="cloud-source-block"
    />
  );
}

async function resolveCell(
  cell: RenderCell,
  blobResolver: ViewerRuntime["blobResolver"],
  index: number,
): Promise<ResolvedCell> {
  const cellType = normalizeCellType(cell.cell_type);
  return {
    id: typeof cell.id === "string" ? cell.id : `cell-${index + 1}`,
    cellType,
    source: typeof cell.source === "string" ? cell.source : "",
    executionCount: normalizeExecutionCount(cell.execution_count),
    outputs: Array.isArray(cell.outputs) ? await resolveOutputs(cell.outputs, blobResolver) : [],
    metadata: normalizeMetadata(cell.metadata),
  };
}

async function resolveOutputs(
  outputs: unknown[],
  blobResolver: ViewerRuntime["blobResolver"],
): Promise<JupyterOutput[]> {
  const resolved = await Promise.all(outputs.map((output) => resolveOutput(output, blobResolver)));
  return resolved.filter((output): output is JupyterOutput => output !== null);
}

async function resolveOutput(
  output: unknown,
  blobResolver: ViewerRuntime["blobResolver"],
): Promise<JupyterOutput | null> {
  if (typeof output === "string") {
    try {
      return resolveOutput(JSON.parse(output) as unknown, blobResolver);
    } catch {
      return null;
    }
  }

  if (isOutputManifest(output)) {
    return resolveManifest(output as OutputManifest, blobResolver) as Promise<JupyterOutput>;
  }

  if (isJupyterOutput(output)) {
    return output;
  }

  return null;
}

function isJupyterOutput(value: unknown): value is JupyterOutput {
  return typeof value === "object" && value !== null && "output_type" in value;
}

function normalizeCellType(value: unknown): ResolvedCell["cellType"] {
  return value === "markdown" || value === "raw" ? value : "code";
}

function normalizeExecutionCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value === "null") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function connectAnonymousViewer(
  syncEndpoint: string,
  setConnection: (value: string) => void,
): () => void {
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  const url = new URL(syncEndpoint, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("viewer_session", sessionId);

  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let closed = false;
  const setConnectionIfActive = (value: string) => {
    if (!closed) {
      setConnection(value);
    }
  };
  socket.addEventListener("open", () => {
    setConnectionIfActive("anonymous viewer connected");
  });
  socket.addEventListener("close", () => {
    setConnectionIfActive("anonymous viewer disconnected");
  });
  socket.addEventListener("message", async (event) => {
    if (closed) return;
    const bytes = new Uint8Array(event.data);
    if (bytes[0] !== 0x07) {
      return;
    }
    const message = JSON.parse(new TextDecoder().decode(bytes.slice(1))) as Record<string, unknown>;
    if (message.type === "cloud_room_ready") {
      setConnectionIfActive(`${message.actor_label} (${message.connection_scope})`);
    }
  });

  return () => {
    closed = true;
    socket.close();
  };
}

createRoot(requireElement("#root")).render(
  <ErrorBoundary
    fallback={(error) => <ViewerStartupError message={`Cloud viewer crashed: ${error.message}`} />}
  >
    <IsolatedRendererProvider loader={rendererBundle}>
      <MediaProvider>
        <App />
      </MediaProvider>
    </IsolatedRendererProvider>
  </ErrorBoundary>,
);
