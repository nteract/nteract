import { createNteractOutputEmbed } from "@/components/isolated/output-embed";
import type { NteractEmbeddableOutput } from "@/components/isolated/embeddable-output";
import type { NteractOutputEmbedHandle } from "@/components/isolated/output-embed";
import { createBlobResolver } from "runtimed";

interface CloudViewerConfig {
  notebookId: string;
  headsHash: string | null;
  renderEndpoint: string;
  syncEndpoint: string;
  blobBasePath: string;
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
}

const rendererBundle = () => import("virtual:isolated-renderer");
const handles = new Set<NteractOutputEmbedHandle>();

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
    !parsed.blobBasePath
  ) {
    throw new Error("Cloud viewer config is incomplete");
  }
  return {
    notebookId: parsed.notebookId,
    headsHash: parsed.headsHash ?? null,
    renderEndpoint: parsed.renderEndpoint,
    syncEndpoint: parsed.syncEndpoint,
    blobBasePath: parsed.blobBasePath,
  };
}

const config = loadConfig();
const state = requireElement("#state");
const notebook = requireElement("#notebook");
const revision = requireElement("#revision");
const connection = requireElement("#connection");

const blobResolver = createBlobResolver({
  url(ref) {
    return new URL(`${config.blobBasePath}${encodeURIComponent(ref.blob)}`, location.href).href;
  },
});

connectAnonymousViewer();
void loadNotebook();

window.addEventListener("beforeunload", () => {
  for (const handle of handles) {
    handle.dispose();
  }
  handles.clear();
});

async function loadNotebook(): Promise<void> {
  try {
    const response = await fetch(config.renderEndpoint, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      showState(
        response.status === 404
          ? "No published snapshot is available for this notebook yet."
          : `Unable to load notebook render: ${response.status}`,
        response.status === 404 ? "empty" : "error",
      );
      return;
    }
    renderNotebook((await response.json()) as SnapshotRender);
  } catch (error) {
    showState(`Unable to load notebook: ${String(error)}`, "error");
  }
}

function renderNotebook(render: SnapshotRender): void {
  const cells = Array.isArray(render.cells) ? (render.cells as RenderCell[]) : [];
  revision.textContent = render.heads_hash ? `Revision ${render.heads_hash}` : "";
  for (const handle of handles) {
    handle.dispose();
  }
  handles.clear();
  notebook.replaceChildren();

  if (cells.length === 0) {
    showState("This published notebook has no cells.", "empty");
    return;
  }

  const source = render.source === "snapshot-pair" ? "snapshot pair" : "render cache";
  showState(`Rendering ${cells.length} cells from a persisted ${source}.`, "ready");
  for (const cell of cells) {
    notebook.append(renderCell(cell));
  }
}

function renderCell(cell: RenderCell): HTMLElement {
  const type = typeof cell.cell_type === "string" ? cell.cell_type : "code";
  const id = typeof cell.id === "string" ? cell.id : "cell";
  const source = typeof cell.source === "string" ? cell.source : "";
  const section = document.createElement("article");
  section.className = "cell";
  section.dataset.type = type;
  section.dataset.rendering = "pending";

  const label = document.createElement("div");
  label.className = "cell-label";
  label.textContent = labelText(type, id, cell.execution_count);
  section.append(label);

  if (type === "markdown") {
    const markdown = document.createElement("div");
    markdown.className = "markdown-embed";
    section.append(markdown);
    mountOutputEmbed(markdown, markdownOutput(source), section);
  } else {
    const pre = document.createElement("pre");
    pre.className = "source";
    const code = document.createElement("code");
    code.textContent = source;
    pre.append(code);
    section.append(pre);
  }

  const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
  if (outputs.length > 0) {
    const outputContainer = document.createElement("div");
    outputContainer.className = "outputs";
    section.append(outputContainer);
    mountOutputEmbed(outputContainer, outputs, section);
  } else if (type !== "markdown") {
    section.dataset.rendering = "complete";
  }

  return section;
}

function labelText(type: string, id: string, executionCount: unknown): string {
  const count =
    typeof executionCount === "number" ||
    (typeof executionCount === "string" && executionCount !== "null")
      ? ` [${executionCount}]`
      : "";
  return `${type}${count} - ${id}`;
}

function markdownOutput(source: string): unknown {
  return {
    output_type: "display_data",
    data: {
      "text/markdown": source,
    },
    metadata: {},
  };
}

function mountOutputEmbed(target: HTMLElement, output: unknown, section: HTMLElement): void {
  const embeddableOutput = output as NteractEmbeddableOutput | readonly NteractEmbeddableOutput[];
  const handle = createNteractOutputEmbed({
    target,
    output: embeddableOutput,
    rendererBundle,
    blobResolver,
    maxHeight: 760,
    hostContext: hostContext(),
    onDiagnostic(phase, details, level) {
      if (phase === "render-complete") {
        section.dataset.rendering = "complete";
      }
      if (level === "error") {
        showRenderError(target, `${phase}: ${JSON.stringify(details ?? {})}`);
      }
    },
    onError(error) {
      showRenderError(target, error.message);
      section.dataset.rendering = "error";
    },
  });
  handles.add(handle);
}

function hostContext() {
  const language = navigator.language || "en-US";
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    locale: language,
    timeZone,
    userAgent: navigator.userAgent,
    platform: "web",
    nteract: {
      rendererAssetsBaseUrl: new URL("/api/plugins/", location.href).href,
    },
  } as const;
}

function showRenderError(target: HTMLElement, message: string): void {
  if (target.querySelector(".render-error")) return;
  const error = document.createElement("div");
  error.className = "render-error";
  error.textContent = message;
  target.append(error);
}

function connectAnonymousViewer(): void {
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
  const url = new URL(config.syncEndpoint, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("viewer_session", sessionId);

  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    connection.textContent = "anonymous viewer connected";
  });
  socket.addEventListener("close", () => {
    connection.textContent = "anonymous viewer disconnected";
  });
  socket.addEventListener("message", async (event) => {
    const bytes = new Uint8Array(event.data);
    if (bytes[0] !== 0x07) {
      return;
    }
    const message = JSON.parse(new TextDecoder().decode(bytes.slice(1))) as Record<string, unknown>;
    if (message.type === "cloud_room_ready") {
      connection.textContent = `${message.actor_label} (${message.connection_scope})`;
    }
  });
}

function showState(message: string, kind: string): void {
  state.textContent = message;
  state.setAttribute("data-kind", kind);
}
