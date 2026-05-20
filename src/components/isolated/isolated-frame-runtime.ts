import type { IframeToParentMessage, ParentToIframeMessage, RenderPayload } from "./frame-bridge";
import { isIframeMessage } from "./frame-bridge";
import { rendererBundleDetails } from "./diagnostics";
import type { NteractEmbedHostContext } from "./host-context";
import { JsonRpcTransport } from "./jsonrpc-transport";
import {
  MCP_NOTIFICATIONS_MESSAGE,
  MCP_UI_HOST_CONTEXT_CHANGED,
  MCP_UI_RESOURCE_TEARDOWN,
  MCP_UI_SIZE_CHANGED,
  NTERACT_BRIDGE_READY,
  NTERACT_CLEAR_OUTPUTS,
  NTERACT_COMM_CLOSE,
  NTERACT_COMM_MSG,
  NTERACT_COMM_OPEN,
  NTERACT_DIAGNOSTIC,
  NTERACT_DOUBLE_CLICK,
  NTERACT_ERROR,
  NTERACT_EVAL,
  NTERACT_EVAL_RESULT,
  NTERACT_INSTALL_RENDERER,
  NTERACT_LINK_CLICK,
  NTERACT_MOUSE_DOWN,
  NTERACT_PING,
  NTERACT_RENDER_BATCH,
  NTERACT_RENDER_COMPLETE,
  NTERACT_RENDER_OUTPUT,
  NTERACT_RENDERER_READY,
  NTERACT_RESIZE,
  NTERACT_SEARCH,
  NTERACT_SEARCH_NAVIGATE,
  NTERACT_SEARCH_RESULTS,
  NTERACT_THEME,
  NTERACT_WIDGET_COMM_CLOSE,
  NTERACT_WIDGET_COMM_MSG,
  NTERACT_WIDGET_READY,
  NTERACT_WIDGET_SNAPSHOT,
  NTERACT_WIDGET_STATE,
  NTERACT_WIDGET_UPDATE,
  NTERACT_WHEEL_BOUNDARY,
} from "./rpc-methods";

export const TYPE_TO_METHOD: Record<string, string> = {
  render: NTERACT_RENDER_OUTPUT,
  render_batch: NTERACT_RENDER_BATCH,
  theme: NTERACT_THEME,
  clear: NTERACT_CLEAR_OUTPUTS,
  eval: NTERACT_EVAL,
  install_renderer: NTERACT_INSTALL_RENDERER,
  ping: NTERACT_PING,
  search: NTERACT_SEARCH,
  search_navigate: NTERACT_SEARCH_NAVIGATE,
  comm_open: NTERACT_COMM_OPEN,
  comm_msg: NTERACT_COMM_MSG,
  comm_close: NTERACT_COMM_CLOSE,
  widget_snapshot: NTERACT_WIDGET_SNAPSHOT,
  bridge_ready: NTERACT_BRIDGE_READY,
  widget_state: NTERACT_WIDGET_STATE,
};

export type IsolatedFrameRuntimeDiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface IsolatedFrameRuntimeCallbacks {
  onBootstrapReady: (event: { isReload: boolean; generation: number }) => void;
  onRendererReady: () => void;
  onResize: (height: number) => void;
  onRenderComplete: (height: number) => void;
  onLinkClick: (url: string, newTab: boolean) => void;
  onMouseDown: () => void;
  onDoubleClick: () => void;
  onWheelBoundary: (params: { deltaY?: number }) => void;
  onWidgetUpdate: (commId: string, state: Record<string, unknown>) => void;
  onError: (error: { message: string; stack?: string }) => void;
  onMessage: (message: IframeToParentMessage) => void;
  onDiagnostic: (
    phase: string,
    details?: Record<string, unknown>,
    level?: IsolatedFrameRuntimeDiagnosticLevel,
    source?: "isolated-frame" | "isolated-renderer" | "iframe-libraries",
  ) => void;
}

export interface IsolatedFrameRuntimeOptions {
  getFrameWindow: () => Window | null | undefined;
  getInitialContent?: () => RenderPayload | undefined;
  callbacks: IsolatedFrameRuntimeCallbacks;
}

export interface IsolatedFrameRendererBundle {
  rendererCode?: string;
  rendererCss?: string;
}

function diagnosticLevelFromMcpLog(level: string | undefined): IsolatedFrameRuntimeDiagnosticLevel {
  if (level === "error" || level === "critical" || level === "alert" || level === "emergency") {
    return "error";
  }
  if (level === "warning") {
    return "warn";
  }
  if (level === "notice" || level === "info") {
    return "info";
  }
  return "debug";
}

function stableHostContextKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableHostContextKey).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableHostContextKey(entryValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isJsonRpcMessage(data: unknown): boolean {
  return (
    typeof data === "object" && data !== null && (data as { jsonrpc?: unknown }).jsonrpc === "2.0"
  );
}

export class IsolatedFrameRuntime {
  private readonly getFrameWindow: () => Window | null | undefined;
  private readonly getInitialContent: () => RenderPayload | undefined;
  private readonly callbacks: IsolatedFrameRuntimeCallbacks;
  private transport: JsonRpcTransport | null = null;
  private pendingMessages: ParentToIframeMessage[] = [];
  private bootstrapping = false;
  private hasReceivedReady = false;
  private ready = false;
  private iframeReady = false;
  private lastHostContextDelivery: { channel: "legacy" | "rpc"; key: string } | null = null;

  generation = 0;

  constructor(options: IsolatedFrameRuntimeOptions) {
    this.getFrameWindow = options.getFrameWindow;
    this.getInitialContent = options.getInitialContent ?? (() => undefined);
    this.callbacks = options.callbacks;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isIframeReady(): boolean {
    return this.iframeReady;
  }

  send(message: ParentToIframeMessage): void {
    if (!this.ready) {
      this.pendingMessages.push(message);
      return;
    }
    this.deliver(message);
  }

  render(payload: RenderPayload): void {
    this.callbacks.onDiagnostic("render-dispatched", { mimeType: payload.mimeType });
    this.send({ type: "render", payload });
  }

  renderBatch(outputs: RenderPayload[]): void {
    this.callbacks.onDiagnostic("render-batch-dispatched", {
      outputCount: outputs.length,
      mimes: outputs.map((output) => output.mimeType),
    });
    this.send({ type: "render_batch", payload: { outputs } });
  }

  eval(code: string): void {
    this.send({ type: "eval", payload: { code } });
  }

  installRenderer(code: string, css?: string): void {
    this.callbacks.onDiagnostic("renderer-plugin-dispatched", {
      codeLength: code.length,
      hasCss: css !== undefined,
      cssLength: css?.length ?? 0,
    });
    this.send({ type: "install_renderer", payload: { code, css } });
  }

  setTheme(isDark: boolean, colorTheme?: string | null): void {
    this.deliver({ type: "theme", payload: { isDark, colorTheme } });
  }

  notifyHostContext(context: NteractEmbedHostContext): void {
    const channel = this.transport && this.ready ? "rpc" : "legacy";
    const key = stableHostContextKey(context);
    const lastDelivery = this.lastHostContextDelivery;
    if (lastDelivery?.channel === channel && lastDelivery.key === key) {
      return;
    }
    this.lastHostContextDelivery = { channel, key };

    if (this.transport && this.ready) {
      this.transport.notify(MCP_UI_HOST_CONTEXT_CHANGED, context);
    } else {
      this.postLegacy({ type: "host_context", payload: context });
    }
  }

  clear(): void {
    this.send({ type: "clear" });
  }

  search(query: string, caseSensitive?: boolean): void {
    this.deliver({ type: "search", payload: { query, caseSensitive } });
  }

  searchNavigate(matchIndex: number): void {
    this.deliver({ type: "search_navigate", payload: { matchIndex } });
  }

  handleWindowMessage(event: MessageEvent, bundle: IsolatedFrameRendererBundle): boolean {
    if (event.source !== this.getFrameWindow()) {
      return false;
    }

    const data = event.data;
    if (isJsonRpcMessage(data)) {
      return false;
    }
    if (!isIframeMessage(data)) {
      return false;
    }

    this.callbacks.onMessage(data);
    this.handleLegacyMessage(data, bundle);
    return true;
  }

  waitingForRendererBundle(bundle: IsolatedFrameRendererBundle): boolean {
    return (
      this.iframeReady &&
      !this.ready &&
      !this.bootstrapping &&
      (bundle.rendererCode === undefined || bundle.rendererCss === undefined)
    );
  }

  reportRendererBundlePending(
    bundle: IsolatedFrameRendererBundle,
    provider: { providerLoading: boolean; providerError?: Error | null },
  ): void {
    if (!this.waitingForRendererBundle(bundle)) {
      return;
    }
    this.callbacks.onDiagnostic("renderer-bundle-pending", {
      providerLoading: provider.providerLoading,
      providerError: provider.providerError?.message ?? null,
      ...rendererBundleDetails(bundle.rendererCode, bundle.rendererCss),
    });
  }

  injectRendererBundle(bundle: Required<IsolatedFrameRendererBundle>): boolean {
    const frameWindow = this.getFrameWindow();
    if (!this.iframeReady || this.ready || this.bootstrapping || !frameWindow) {
      return false;
    }

    this.bootstrapping = true;
    this.callbacks.onDiagnostic(
      "renderer-bundle-injecting",
      rendererBundleDetails(bundle.rendererCode, bundle.rendererCss),
    );

    const cssCode = `
        (function() {
          if (window.__ISOLATED_CSS_LOADED__) return;
          window.__ISOLATED_CSS_LOADED__ = true;
          var style = document.createElement('style');
          style.textContent = ${JSON.stringify(bundle.rendererCss)};
          document.head.appendChild(style);
        })();
      `;
    frameWindow.postMessage({ type: "eval", payload: { code: cssCode } }, "*");

    const jsWrapper =
      "(function() {" +
      "if (window.__ISOLATED_RENDERER_LOADED__) return;" +
      "window.__ISOLATED_RENDERER_LOADED__ = true;" +
      bundle.rendererCode +
      "})();";
    frameWindow.postMessage({ type: "eval", payload: { code: jsWrapper } }, "*");
    this.callbacks.onDiagnostic(
      "renderer-bundle-injected",
      rendererBundleDetails(bundle.rendererCode, bundle.rendererCss),
    );
    return true;
  }

  dispose(): void {
    const transport = this.transport;
    this.transport = null;
    this.ready = false;
    this.iframeReady = false;
    this.pendingMessages.length = 0;
    if (!transport) return;

    let stopped = false;
    const stopTransport = () => {
      if (stopped) return;
      stopped = true;
      transport.stop();
    };

    transport
      .request(MCP_UI_RESOURCE_TEARDOWN, { reason: "unmount" })
      .catch((err) => {
        this.callbacks.onDiagnostic(
          "resource-teardown-failed",
          { message: err instanceof Error ? err.message : String(err) },
          "debug",
        );
      })
      .finally(stopTransport);
    window.setTimeout(stopTransport, 100);
  }

  private deliver(message: ParentToIframeMessage): void {
    const method = TYPE_TO_METHOD[message.type];
    if (method && this.transport) {
      const params = "payload" in message ? message.payload : undefined;
      this.transport.notify(method, params);
      return;
    }
    this.postLegacy(message);
  }

  private postLegacy(message: ParentToIframeMessage): void {
    this.getFrameWindow()?.postMessage(message, "*");
  }

  private flushPending(): void {
    if (this.pendingMessages.length === 0) {
      return;
    }
    const pending = this.pendingMessages;
    this.pendingMessages = [];
    pending.forEach((message) => this.deliver(message));
  }

  private handleLegacyMessage(
    data: IframeToParentMessage,
    bundle: IsolatedFrameRendererBundle,
  ): void {
    switch (data.type) {
      case "ready":
        this.handleBootstrapReady(bundle);
        break;

      case "renderer_ready":
        this.handleRendererReady("legacy");
        break;

      case "resize":
        if (data.payload?.height != null) {
          this.callbacks.onResize(data.payload.height);
        }
        break;

      case "render_complete":
        if (data.payload?.height != null) {
          this.callbacks.onDiagnostic("render-complete", { height: data.payload.height });
          this.callbacks.onRenderComplete(data.payload.height);
        }
        break;

      case "link_click":
        if (data.payload?.url) {
          this.callbacks.onLinkClick(data.payload.url, data.payload.newTab ?? false);
        }
        break;

      case "dblclick":
        this.callbacks.onDoubleClick();
        break;

      case "widget_update":
        if (data.payload?.commId && data.payload?.state) {
          this.callbacks.onWidgetUpdate(data.payload.commId, data.payload.state);
        }
        break;

      case "error":
        if (data.payload) {
          this.callbacks.onError(data.payload);
        }
        break;

      case "eval_result":
        if (data.payload?.success === false) {
          console.error("[IsolatedFrame] Bundle eval failed:", data.payload.error);
          this.callbacks.onDiagnostic(
            "renderer-bundle-eval-failed",
            { error: data.payload.error },
            "error",
          );
          this.callbacks.onError({
            message: `Bundle eval failed: ${data.payload.error}`,
          });
        }
        break;
    }
  }

  private handleBootstrapReady(bundle: IsolatedFrameRendererBundle): void {
    const isReload = this.hasReceivedReady;
    this.hasReceivedReady = true;
    this.generation += 1;
    this.iframeReady = true;
    this.lastHostContextDelivery = null;
    this.callbacks.onDiagnostic("bootstrap-ready", {
      isReload,
      ...rendererBundleDetails(bundle.rendererCode, bundle.rendererCss),
    });

    if (isReload) {
      this.bootstrapping = false;
      this.ready = false;
      this.pendingMessages.length = 0;
    }

    this.callbacks.onBootstrapReady({ isReload, generation: this.generation });
    this.createTransport();
  }

  private createTransport(): void {
    const frameWindow = this.getFrameWindow();
    if (!frameWindow) {
      return;
    }

    this.transport?.stop();
    const transport = new JsonRpcTransport(frameWindow, frameWindow);
    this.registerTransportHandlers(transport);
    transport.start();
    this.transport = transport;
  }

  private registerTransportHandlers(transport: JsonRpcTransport): void {
    transport.onNotification(NTERACT_RENDERER_READY, () => {
      this.handleRendererReady("rpc", transport);
    });
    transport.onNotification(NTERACT_RESIZE, (params) => {
      const p = params as { height?: number };
      if (p.height != null) {
        this.callbacks.onResize(p.height);
      }
    });
    transport.onNotification(MCP_UI_SIZE_CHANGED, (params) => {
      const p = params as { height?: number; width?: number };
      this.callbacks.onDiagnostic("size-changed", {
        height: p.height ?? null,
        width: p.width ?? null,
        protocol: "mcp-ui",
      });
      if (p.height != null) {
        this.callbacks.onResize(p.height);
      }
    });
    transport.onNotification(NTERACT_RENDER_COMPLETE, (params) => {
      const p = params as { height?: number };
      this.callbacks.onDiagnostic("render-complete", { height: p.height ?? null });
      if (p.height != null) {
        this.callbacks.onRenderComplete(p.height);
      }
    });
    transport.onNotification(NTERACT_LINK_CLICK, (params) => {
      const p = params as { url: string; newTab?: boolean };
      if (p.url) {
        this.callbacks.onLinkClick(p.url, p.newTab ?? false);
      }
    });
    transport.onNotification(NTERACT_MOUSE_DOWN, () => {
      this.callbacks.onMouseDown();
    });
    transport.onNotification(NTERACT_WHEEL_BOUNDARY, (params) => {
      this.callbacks.onWheelBoundary(params as { deltaY?: number });
    });
    transport.onNotification(NTERACT_DOUBLE_CLICK, () => {
      this.callbacks.onDoubleClick();
    });
    transport.onNotification(NTERACT_WIDGET_UPDATE, (params) => {
      const p = params as { commId: string; state: Record<string, unknown> };
      if (p.commId && p.state) {
        this.callbacks.onWidgetUpdate(p.commId, p.state);
      }
    });
    transport.onNotification(NTERACT_ERROR, (params) => {
      const p = params as { message: string; stack?: string };
      if (p.message) {
        this.callbacks.onDiagnostic("renderer-error", p, "error");
        this.callbacks.onError(p);
      }
    });
    transport.onNotification(NTERACT_EVAL_RESULT, (params) => {
      const p = params as { success: boolean; error?: string };
      if (p.success === false) {
        console.error("[IsolatedFrame] Bundle eval failed:", p.error);
        this.callbacks.onError({ message: `Bundle eval failed: ${p.error}` });
      }
    });
    transport.onNotification(NTERACT_SEARCH_RESULTS, (params) => {
      this.callbacks.onMessage({
        type: "search_results",
        payload: params as { count: number },
      } as IframeToParentMessage);
    });
    transport.onNotification(NTERACT_WIDGET_READY, () => {
      this.callbacks.onMessage({ type: "widget_ready" } as IframeToParentMessage);
    });
    transport.onNotification(NTERACT_WIDGET_COMM_MSG, (params) => {
      this.callbacks.onMessage({
        type: "widget_comm_msg",
        payload: params,
      } as IframeToParentMessage);
    });
    transport.onNotification(NTERACT_WIDGET_COMM_CLOSE, (params) => {
      this.callbacks.onMessage({
        type: "widget_comm_close",
        payload: params,
      } as IframeToParentMessage);
    });
    transport.onNotification(NTERACT_DIAGNOSTIC, (params) => {
      const p = params as {
        source?: "isolated-frame" | "isolated-renderer" | "iframe-libraries";
        phase?: string;
        level?: IsolatedFrameRuntimeDiagnosticLevel;
        details?: Record<string, unknown>;
      };
      if (!p.phase) return;
      this.callbacks.onDiagnostic(p.phase, p.details, p.level, p.source ?? "isolated-renderer");
    });
    transport.onNotification(MCP_NOTIFICATIONS_MESSAGE, (params) => {
      const p = params as {
        level?: string;
        logger?: string;
        data?: unknown;
      };
      this.callbacks.onDiagnostic(
        "iframe-log-message",
        {
          logger: p.logger ?? null,
          data: p.data ?? null,
          protocol: "mcp-ui",
        },
        diagnosticLevelFromMcpLog(p.level),
      );
    });
  }

  private handleRendererReady(channel: "legacy" | "rpc", transport = this.transport): void {
    this.callbacks.onDiagnostic("renderer-ready");
    this.ready = true;
    this.callbacks.onRendererReady();
    const initialContent = this.getInitialContent();
    if (initialContent) {
      if (channel === "rpc" && transport) {
        transport.notify(NTERACT_RENDER_OUTPUT, initialContent);
      } else {
        this.postLegacy({ type: "render", payload: initialContent });
      }
    }
    this.flushPending();
  }
}
