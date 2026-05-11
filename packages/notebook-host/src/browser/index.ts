/**
 * Browser/dev implementation of `NotebookHost`.
 *
 * This host talks to a local Vite-only relay over WebSocket. The relay owns the
 * daemon Unix-socket connection and exposes the same typed notebook frames that
 * the Tauri host receives through `notebook:frame`.
 */

import {
  FrameType,
  type FrameListener,
  type NotebookRequest,
  type NotebookRequestOptions,
  type NotebookResponse,
  type NotebookTransport,
} from "runtimed";
import { createCommandRegistry } from "../commands";
import type {
  DaemonInfo,
  DaemonProgressPayload,
  DaemonReadyPayload,
  DaemonUnavailablePayload,
  GitInfo,
  HostBlobRef,
  HostBlobResolver,
  HostBlobs,
  HostUpdaterState,
  NotebookHost,
  TyposquatWarning,
  Unlisten,
} from "../types";

const DEFAULT_CONFIG_URL = "/__nteract_dev_relay/config";
const FRAME_TYPE_REQUEST = 0x01;
const FRAME_TYPE_RESPONSE = 0x02;

interface BrowserRelayConfig {
  websocket_url: string;
  token: string;
  blob_port: number | null;
  daemon: DaemonInfo | null;
}

type BrowserRelayControl =
  | {
      type: "ready";
      payload: DaemonReadyPayload;
      blob_port?: number | null;
      daemon?: DaemonInfo | null;
    }
  | { type: "progress"; payload: DaemonProgressPayload }
  | { type: "disconnected" }
  | { type: "unavailable"; payload: DaemonUnavailablePayload };

export interface CreateBrowserHostOptions {
  /** Relay config endpoint. Defaults to the Vite dev relay path. */
  configUrl?: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Test seam. */
  WebSocketImpl?: typeof WebSocket;
}

interface PendingEntry {
  resolve: (response: NotebookResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function requestTimeoutMs(request: NotebookRequest): number {
  switch (request.type) {
    case "launch_kernel":
    case "sync_environment":
      return 300_000;
    case "complete":
      return 7_000;
    default:
      return 30_000;
  }
}

function createHttpBlobResolver(port: number, fetchImpl: typeof fetch): HostBlobResolver {
  const url = (ref: HostBlobRef) => `http://127.0.0.1:${port}/blob/${ref.blob}`;
  return {
    port,
    url,
    fetch(ref) {
      return fetchImpl(url(ref));
    },
  };
}

function addToken(url: string, token: string): string {
  const resolved = normalizeRelayWebSocketUrl(new URL(url, window.location.href));
  resolved.searchParams.set("token", token);

  // Convenience for manual local debugging:
  //   /?path=/tmp/foo.ipynb
  //   /?notebook_id=<uuid>
  //   /?runtime=deno
  const pageParams = new URLSearchParams(window.location.search);
  for (const key of ["path", "notebook_id", "runtime", "working_dir"]) {
    const value = pageParams.get(key);
    if (value) resolved.searchParams.set(key, value);
  }

  return resolved.toString();
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeRelayWebSocketUrl(url: URL): URL {
  if (!url.pathname.startsWith("/__nteract_dev_relay/")) return url;
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return url;
  if (!isLoopbackHost(url.hostname)) return url;
  if (isLoopbackHost(window.location.hostname)) return url;

  const normalized = new URL(url.pathname + url.search + url.hash, window.location.href);
  normalized.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return normalized;
}

async function loadConfig(configUrl: string, fetchImpl: typeof fetch): Promise<BrowserRelayConfig> {
  const response = await fetchImpl(configUrl, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`browser relay config failed: ${response.status}`);
  }
  return (await response.json()) as BrowserRelayConfig;
}

function makeUnavailable(message: string): DaemonUnavailablePayload {
  return {
    reason: "browser_relay_unavailable",
    message,
    guidance: "Start the dev daemon with `cargo xtask dev-daemon`, then run `cargo xtask vite`.",
  };
}

class BrowserDevTransport implements NotebookTransport {
  private readonly url: string;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly onControl: (control: BrowserRelayControl) => void;
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private subscribers = new Set<FrameListener>();
  private pending = new Map<string, PendingEntry>();
  private queuedFrames: number[][] = [];
  private framesReleased = false;
  private _connected = false;

  constructor(
    config: BrowserRelayConfig,
    WebSocketImpl: typeof WebSocket,
    onControl: (control: BrowserRelayControl) => void,
  ) {
    this.url = addToken(config.websocket_url, config.token);
    this.WebSocketImpl = WebSocketImpl;
    this.onControl = onControl;
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): Promise<void> {
    if (
      this.connectPromise &&
      this.ws &&
      (this.ws.readyState === this.WebSocketImpl.CONNECTING ||
        this.ws.readyState === this.WebSocketImpl.OPEN)
    ) {
      return this.connectPromise;
    }

    this.framesReleased = false;
    this.queuedFrames = [];
    this.connectPromise = new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        this._connected = true;
        resolve();
      };
      ws.onerror = () => {
        const err = new Error("browser relay WebSocket failed");
        this.rejectPending(err);
        reject(err);
      };
      ws.onclose = () => {
        const wasConnected = this._connected;
        this._connected = false;
        this.connectPromise = null;
        this.rejectPending(new Error("browser relay disconnected"));
        if (wasConnected) this.onControl({ type: "disconnected" });
      };
      ws.onmessage = (event) => {
        void this.handleMessage(event.data).catch((err) => {
          console.error("[browser-transport] message handling failed:", err);
        });
      };
    });

    return this.connectPromise;
  }

  releaseFrames(): void {
    this.framesReleased = true;
    const queued = this.queuedFrames;
    this.queuedFrames = [];
    for (const frame of queued) this.deliver(frame);
  }

  async sendFrame(frameType: number, payload: Uint8Array): Promise<void> {
    if (frameType === FrameType.SESSION_CONTROL) {
      throw new Error("SESSION_CONTROL is server-originated only");
    }
    await this.connect();
    if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("browser relay is not connected");
    }
    const frame = new Uint8Array(1 + payload.length);
    frame[0] = frameType;
    frame.set(payload, 1);
    this.ws.send(frame);
  }

  onFrame(callback: FrameListener): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async sendRequest(request: unknown, options?: NotebookRequestOptions): Promise<unknown> {
    const req = request as NotebookRequest;
    const id = crypto.randomUUID();
    const { type, ...rest } = req as { type: string } & Record<string, unknown>;
    const envelope = {
      id,
      ...(options?.required_heads?.length ? { required_heads: options.required_heads } : {}),
      action: type,
      ...rest,
    };
    const payload = new TextEncoder().encode(JSON.stringify(envelope));
    const timeoutMs = requestTimeoutMs(req);

    return new Promise<NotebookResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Request timeout after ${timeoutMs}ms: ${type}`));
        }
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      void this.sendFrame(FRAME_TYPE_REQUEST, payload).catch((err) => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  disconnect(): void {
    this._connected = false;
    this.ws?.close();
    this.ws = null;
    this.subscribers.clear();
    this.queuedFrames = [];
    this.rejectPending(new Error("browser relay disconnected"));
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (typeof data === "string") {
      this.onControl(JSON.parse(data) as BrowserRelayControl);
      return;
    }

    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    } else {
      return;
    }

    const frame = Array.from(bytes);
    this.dispatchResponseFrame(frame);
    if (this.framesReleased) this.deliver(frame);
    else this.queuedFrames.push(frame);
  }

  private deliver(frame: number[]): void {
    for (const cb of this.subscribers) {
      try {
        cb(frame);
      } catch (err) {
        console.error("[browser-transport] frame subscriber failed:", err);
      }
    }
  }

  private dispatchResponseFrame(bytes: number[]): void {
    if (bytes[0] !== FRAME_TYPE_RESPONSE) return;
    const json = new TextDecoder().decode(new Uint8Array(bytes.slice(1)));
    let envelope: { id?: string } & Record<string, unknown>;
    try {
      envelope = JSON.parse(json);
    } catch {
      return;
    }
    const id = envelope.id;
    if (typeof id !== "string") return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const { id: _id, ...response } = envelope;
    entry.resolve(response as NotebookResponse);
  }

  private rejectPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

export async function createBrowserHost(
  opts: CreateBrowserHostOptions = {},
): Promise<NotebookHost> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
  let config = await loadConfig(opts.configUrl ?? DEFAULT_CONFIG_URL, fetchImpl);
  let lastReady: DaemonReadyPayload | null = null;
  let blobPort = config.blob_port;
  let blobResolver: HostBlobResolver | null =
    blobPort === null ? null : createHttpBlobResolver(blobPort, fetchImpl);
  let daemonInfo = config.daemon;

  const readySubscribers = new Set<(payload: DaemonReadyPayload) => void>();
  const progressSubscribers = new Set<(payload: DaemonProgressPayload) => void>();
  const disconnectedSubscribers = new Set<() => void>();
  const unavailableSubscribers = new Set<(payload: DaemonUnavailablePayload) => void>();

  const emit = <T>(subscribers: Set<(payload: T) => void>, payload: T) => {
    for (const cb of subscribers) cb(payload);
  };

  const transport = new BrowserDevTransport(config, WebSocketImpl, (control) => {
    switch (control.type) {
      case "ready":
        lastReady = control.payload;
        blobPort = control.blob_port ?? blobPort;
        blobResolver = blobPort === null ? null : createHttpBlobResolver(blobPort, fetchImpl);
        daemonInfo = control.daemon ?? daemonInfo;
        emit(readySubscribers, control.payload);
        break;
      case "progress":
        emit(progressSubscribers, control.payload);
        break;
      case "disconnected":
        for (const cb of disconnectedSubscribers) cb();
        break;
      case "unavailable":
        emit(unavailableSubscribers, control.payload);
        break;
    }
  });

  const reconnect = async () => {
    try {
      await transport.connect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit(unavailableSubscribers, makeUnavailable(message));
      throw err;
    }
  };

  void reconnect();

  const idleUpdaterState: HostUpdaterState = { status: "idle", version: null, error: null };
  const commands = createCommandRegistry();

  const browserBlobHost: HostBlobs = {
    async port() {
      const resolver = await browserBlobHost.resolver();
      if (resolver.port === undefined) throw new Error("Blob server not available");
      return resolver.port;
    },
    async resolver() {
      if (blobResolver) return blobResolver;
      config = await loadConfig(opts.configUrl ?? DEFAULT_CONFIG_URL, fetchImpl);
      blobPort = config.blob_port;
      daemonInfo = config.daemon;
      if (blobPort === null) throw new Error("Blob server not available");
      blobResolver = createHttpBlobResolver(blobPort, fetchImpl);
      return blobResolver;
    },
  };

  return {
    name: "browser",
    transport,
    daemon: {
      async isConnected() {
        return transport.connected;
      },
      reconnect,
      async getInfo() {
        return daemonInfo;
      },
      async getReadyInfo() {
        return lastReady;
      },
    },
    daemonEvents: {
      onReadyLive(cb) {
        readySubscribers.add(cb);
        return () => readySubscribers.delete(cb);
      },
      onReady(cb) {
        readySubscribers.add(cb);
        if (lastReady) queueMicrotask(() => cb(lastReady as DaemonReadyPayload));
        return () => readySubscribers.delete(cb);
      },
      onProgress(cb) {
        progressSubscribers.add(cb);
        return () => progressSubscribers.delete(cb);
      },
      onDisconnected(cb) {
        disconnectedSubscribers.add(cb);
        return () => disconnectedSubscribers.delete(cb);
      },
      onUnavailable(cb) {
        unavailableSubscribers.add(cb);
        return () => unavailableSubscribers.delete(cb);
      },
    },
    relay: {
      async notifySyncReady() {
        transport.releaseFrames();
      },
    },
    blobs: browserBlobHost,
    trust: {
      async approve(options) {
        const response = (await transport.sendRequest({
          type: "approve_trust",
          ...(options?.observedHeads !== undefined
            ? { observed_heads: options.observedHeads }
            : {}),
        })) as NotebookResponse;
        if (response.result === "ok") return;
        if (response.result === "guard_rejected") throw new Error(response.reason);
        if (response.result === "error") throw new Error(response.error);
        throw new Error(`Unexpected approve_trust response: ${JSON.stringify(response)}`);
      },
    },
    deps: {
      async checkTyposquats(_packages: string[]): Promise<TyposquatWarning[]> {
        return [];
      },
    },
    notebook: {
      async applyPathChanged() {},
      async getDefaultSaveDirectory() {
        return "";
      },
      async saveAs() {
        throw new Error("Save As is not available in the browser dev host");
      },
      async openInNewWindow() {
        throw new Error("Open in new window is not available in the browser dev host");
      },
      async cloneToEphemeral() {
        throw new Error("Clone is not available in the browser dev host");
      },
    },
    window: {
      async getTitle() {
        return document.title;
      },
      async setTitle(title) {
        document.title = title;
      },
      onFocusChange(cb) {
        const onFocus = () => cb(true);
        const onBlur = () => cb(false);
        window.addEventListener("focus", onFocus);
        window.addEventListener("blur", onBlur);
        return () => {
          window.removeEventListener("focus", onFocus);
          window.removeEventListener("blur", onBlur);
        };
      },
    },
    system: {
      async getGitInfo(): Promise<GitInfo | null> {
        return null;
      },
      async getUsername() {
        return "browser";
      },
    },
    dialog: {
      async openFile() {
        return null;
      },
      async saveFile() {
        return null;
      },
    },
    externalLinks: {
      async open(url) {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    updater: {
      getSnapshot() {
        return idleUpdaterState;
      },
      subscribe(_cb) {
        return (() => {}) satisfies Unlisten;
      },
      async check() {
        return idleUpdaterState;
      },
      async beginUpgrade() {
        window.location.reload();
      },
    },
    settings: {
      async openWindow() {
        window.open("/settings/", "_blank", "noopener,noreferrer");
      },
    },
    commands,
    log: {
      debug(message) {
        console.debug(message);
      },
      info(message) {
        console.info(message);
      },
      warn(message) {
        console.warn(message);
      },
      error(message) {
        console.error(message);
      },
    },
  };
}
