import { createCommandRegistry, type NotebookHost, type Unlisten } from "@nteract/notebook-host";
import type {
  BlobResolver,
  FrameListener,
  FrameTypeValue,
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
    return this.requireTransport("send request").sendRequest(request, options);
  }

  onFrame(callback: FrameListener): Unlisten {
    return this.getRuntime()?.transport.onFrame(callback) ?? unlisten;
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
