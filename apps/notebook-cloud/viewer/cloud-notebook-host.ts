import { createCommandRegistry, type NotebookHost, type Unlisten } from "@nteract/notebook-host";
import { EMPTY, type Observable } from "rxjs";
import type {
  BlobResolver,
  ConnectionStatus,
  FrameListener,
  FrameTypeValue,
  HistoryEntry,
  NotebookRequest,
  NotebookRequestOptions,
  NotebookResponse,
  NotebookTransport,
} from "runtimed";
import type { CloudSyncRuntime } from "./live-sync";

const noop = () => {};
const asyncNoop = async () => {};
const unlisten: Unlisten = () => {};

export interface CreateCloudNotebookHostOptions {
  blobResolver: BlobResolver;
  getRuntime: () => CloudSyncRuntime | null;
  openExternalUrl?: (url: string) => void | Promise<void>;
}

class CloudNotebookHostTransport implements NotebookTransport {
  constructor(private readonly getRuntime: () => CloudSyncRuntime | null) {}

  get connected(): boolean {
    return this.getRuntime()?.transport.connected ?? false;
  }

  async sendFrame(frameType: number, payload: Uint8Array): Promise<void> {
    return this.requireTransport("send frame").sendFrame(frameType, payload);
  }

  async sendTypedRequest(
    frameType: FrameTypeValue,
    payload: Uint8Array,
    id: string,
    timeoutMs: number,
    timeoutLabel?: string,
  ): Promise<NotebookResponse> {
    return this.requireTransport("send typed request").sendTypedRequest(
      frameType,
      payload,
      id,
      timeoutMs,
      timeoutLabel,
    );
  }

  async sendRequest(request: unknown, options?: NotebookRequestOptions): Promise<unknown> {
    if (isNotebookRequest(request)) {
      if (request.type === "get_history") {
        return historyResultFromLiveNotebook(this.getRuntime(), request);
      }
      if (request.type === "complete") {
        return emptyCompletionResult(request);
      }
    }
    return this.requireTransport("send request").sendRequest(request, options);
  }

  onFrame(callback: FrameListener): Unlisten {
    return this.getRuntime()?.transport.onFrame(callback) ?? unlisten;
  }

  // Delegates to the underlying transport's observable. EMPTY when no runtime
  // is active — the facade is a request router, not a lifecycle owner.
  get connectionStatus$(): Observable<ConnectionStatus> {
    return this.getRuntime()?.transport.connectionStatus$ ?? EMPTY;
  }

  disconnect(): void {
    // The cloud viewer session owns the live WebSocket lifecycle. The host
    // transport is a request facade for shared notebook helpers.
  }

  private requireTransport(action: string): CloudSyncRuntime["transport"] {
    const runtime = this.getRuntime();
    if (!runtime) {
      throw new Error(`Cannot ${action}: hosted notebook is not connected to a live room`);
    }
    return runtime.transport;
  }
}

function isNotebookRequest(request: unknown): request is NotebookRequest {
  return typeof request === "object" && request !== null && "type" in request;
}

function historyResultFromLiveNotebook(
  runtime: CloudSyncRuntime | null,
  request: Extract<NotebookRequest, { type: "get_history" }>,
): Extract<NotebookResponse, { result: "history_result" }> {
  if (!runtime) {
    return { result: "history_result", entries: [] };
  }

  const unique = request.unique;
  const limit = Math.max(0, Math.min(500, Math.floor(request.n)));
  const seenSources = new Set<string>();
  const entries: HistoryEntry[] = [];
  let line = 0;
  for (const cellId of runtime.handle.get_cell_ids()) {
    if (runtime.handle.get_cell_type(cellId) !== "code") continue;
    const source = runtime.handle.get_cell_source(cellId)?.trim();
    if (!source || !matchesHistoryPattern(source, request.pattern)) continue;
    if (unique && seenSources.has(source)) continue;
    seenSources.add(source);
    entries.push({ session: 0, line: ++line, source });
  }

  return {
    result: "history_result",
    entries: entries.slice(Math.max(0, entries.length - limit)),
  };
}

function matchesHistoryPattern(source: string, pattern: string | null): boolean {
  const trimmed = pattern?.trim();
  if (!trimmed) return true;
  if (!/[*?]/.test(trimmed)) {
    return source.toLocaleLowerCase().includes(trimmed.toLocaleLowerCase());
  }
  const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const globPattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(globPattern, "iu").test(source);
}

function emptyCompletionResult(
  request: Extract<NotebookRequest, { type: "complete" }>,
): Extract<NotebookResponse, { result: "completion_result" }> {
  return {
    result: "completion_result",
    items: [],
    cursor_start: request.cursor_pos,
    cursor_end: request.cursor_pos,
  };
}

export function createCloudNotebookHost({
  blobResolver,
  getRuntime,
  openExternalUrl,
}: CreateCloudNotebookHostOptions): NotebookHost {
  const transport = new CloudNotebookHostTransport(getRuntime);
  const openUrl =
    openExternalUrl ??
    ((url: string) => {
      window.open(url, "_blank", "noopener,noreferrer");
    });

  return {
    name: "notebook-cloud",
    transport,
    daemon: {
      isConnected: async () => transport.connected,
      reconnect: asyncNoop,
      getInfo: async () => null,
      getReadyInfo: async () => null,
    },
    daemonEvents: {
      onReadyLive: () => unlisten,
      onReady: () => unlisten,
      onProgress: () => unlisten,
      onDisconnected: () => unlisten,
      onUnavailable: () => unlisten,
    },
    relay: {
      requiresReadyGeneration: false,
      notifySyncReady: asyncNoop,
    },
    blobs: {
      port: async () => {
        throw new Error("Hosted notebooks resolve blobs by URL, not by local daemon port.");
      },
      resolver: async () => blobResolver,
    },
    trust: {
      approve: async () => {
        throw new Error("Hosted notebook trust approval is not available from this client.");
      },
    },
    deps: {
      checkTyposquats: async () => [],
    },
    notebook: {
      applyPathChanged: asyncNoop,
      getDefaultSaveDirectory: async () => "",
      saveAs: async () => {
        throw new Error("Hosted notebooks cannot save to a local path.");
      },
      openInNewWindow: async () => {
        throw new Error("Hosted notebooks cannot open local files.");
      },
      cloneToEphemeral: async () => {
        throw new Error("Hosted notebooks cannot clone to a local ephemeral room.");
      },
    },
    window: {
      getTitle: async () => document.title,
      setTitle: async (title) => {
        document.title = title;
      },
      onFocusChange: (callback) => {
        const onFocus = () => callback(true);
        const onBlur = () => callback(false);
        window.addEventListener("focus", onFocus);
        window.addEventListener("blur", onBlur);
        return () => {
          window.removeEventListener("focus", onFocus);
          window.removeEventListener("blur", onBlur);
        };
      },
    },
    system: {
      getGitInfo: async () => null,
      getUsername: async () => "notebook-cloud",
    },
    dialog: {
      openFile: async () => null,
      saveFile: async () => null,
    },
    externalLinks: {
      open: async (url) => openUrl(url),
    },
    updater: {
      getSnapshot: () => ({ status: "idle", version: null, error: null }),
      subscribe: () => unlisten,
      check: async () => ({ status: "idle", version: null, error: null }),
      beginUpgrade: asyncNoop,
    },
    settings: {
      openWindow: asyncNoop,
    },
    commands: createCommandRegistry(),
    log: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    },
  };
}
