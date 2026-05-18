/**
 * IsolatedFrameController — framework-agnostic orchestrator for the
 * sandboxed output iframe.
 *
 * Owns:
 *   - the lifecycle state machine (booting → bootstrapped → installing → ready,
 *     with reload transitions back to bootstrapped)
 *   - the JSON-RPC transport lifecycle (creation on bootstrap, teardown on
 *     reload/dispose)
 *   - the renderer-bundle injection sequence (CSS + JS via legacy `eval`
 *     messages, guarded by the iframe-side `__ISOLATED_*_LOADED__` flags)
 *   - the outbound send queue (render/theme/clear calls before the renderer
 *     bundle finishes installing get queued and flushed on `ready`)
 *   - message routing from the iframe (legacy `{ type, payload }` from the
 *     bootstrap script, JSON-RPC from the renderer bundle) into typed RxJS
 *     observables
 *   - wheel-boundary forwarding (so wheel events that hit a scroll boundary
 *     inside the iframe scroll the nearest parent)
 *
 * Does NOT own:
 *   - the iframe element itself — the caller creates it (so React, Vue, or
 *     anything else picks its own rendering primitive) and passes the
 *     `HTMLIFrameElement` in
 *   - the src/srcDoc choice for Tauri vs browser hosts — see
 *     `resolveFrameSource()` below for the helper, but the caller actually
 *     applies it to the iframe element
 *   - min/max/auto height clamping — the controller emits raw measured
 *     heights, the adapter applies any visual policy
 *
 * The iframe security model (sandbox flags, CSP, custom URI scheme) lives in
 * `src/components/isolated/AGENTS.md` and `frame.html`. This controller does
 * not weaken those guarantees.
 */

import { BehaviorSubject, Observable, Subject } from "rxjs";
import type { CommBridgeManager } from "./comm-bridge-manager";
import type { IframeToParentMessage, ParentToIframeMessage, RenderPayload } from "./frame-bridge";
import { isIframeMessage } from "./frame-bridge";
import { generateFrameHtml } from "./frame-html";
import { JsonRpcTransport } from "./jsonrpc-transport";
import {
  NTERACT_BRIDGE_READY,
  NTERACT_CLEAR_OUTPUTS,
  NTERACT_COMM_CLOSE,
  NTERACT_COMM_MSG,
  NTERACT_COMM_OPEN,
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
  NTERACT_WHEEL_BOUNDARY,
  NTERACT_WIDGET_COMM_CLOSE,
  NTERACT_WIDGET_COMM_MSG,
  NTERACT_WIDGET_READY,
  NTERACT_WIDGET_SNAPSHOT,
  NTERACT_WIDGET_STATE,
  NTERACT_WIDGET_UPDATE,
} from "./rpc-methods";
import { scrollFrameWheelBoundary } from "./scroll-boundary";

/**
 * Maps legacy `ParentToIframeMessage.type` values to canonical JSON-RPC
 * method names. Kept here so any caller using `send()` gets the same
 * routing the React shell used to perform inline.
 */
const TYPE_TO_METHOD: Record<string, string> = {
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

// ── Public types ─────────────────────────────────────────────────────

/**
 * Lifecycle states the controller transitions through. Adapters can derive
 * `isIframeReady` (any state past `booting`) and `isReady` (`ready`) from
 * this.
 *
 * Reload path: when the iframe receives a fresh `ready` after already being
 * in `ready`, the controller transitions through `reloading` → `bootstrapped`
 * → `installing` → `ready` again, discarding queued messages and tearing
 * down the previous transport on the way.
 */
export type FrameLifecycleState =
  | "booting"
  | "bootstrapped"
  | "installing"
  | "ready"
  | "reloading"
  | "error";

export interface FrameResizeEvent {
  height: number;
}

export interface FrameLinkClickEvent {
  url: string;
  newTab: boolean;
}

export interface FrameError {
  message: string;
  stack?: string;
}

export interface FrameRenderCompleteEvent {
  outputId?: string;
  cellId?: string;
  outputIndex?: number;
  height?: number;
}

export interface FrameWidgetUpdateEvent {
  commId: string;
  state: Record<string, unknown>;
}

export interface FrameThemePayload {
  isDark: boolean;
  colorTheme?: string | null;
}

export type FrameSource = { kind: "src"; url: string } | { kind: "srcdoc"; html: string };

export interface IsolatedFrameControllerOptions {
  /** The host iframe element. Must be attached to the document. */
  iframe: HTMLIFrameElement;
  /**
   * Renderer bundle code injected after the iframe bootstrap is ready.
   * Optional at construction; set later via `setRendererBundle()` if the
   * bundle resolves asynchronously.
   */
  rendererCode?: string;
  /**
   * Renderer bundle CSS injected before the JS bundle. Optional at
   * construction; pair with `rendererCode` in `setRendererBundle()`.
   */
  rendererCss?: string;
  /**
   * Optional render payload sent once the renderer reports
   * `nteract/rendererReady`.
   */
  initialContent?: RenderPayload;
  /**
   * Initial theme. Sent on the first transition into `bootstrapped` and
   * again whenever `setTheme()` is called.
   */
  initialTheme?: FrameThemePayload;
  /**
   * When true, the controller forwards wheel events that the iframe reports
   * hitting a scroll boundary to the nearest scrollable parent. Defaults to
   * true; toggle via `setWheelBoundaryForwarding(false)`.
   */
  forwardWheelBoundary?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────

const TAURI_FRAME_URL = "nteract-frame://localhost/";

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return "__TAURI_INTERNALS__" in win || "__TAURI__" in win;
}

/**
 * Resolve the right frame source for the current runtime. Tauri loads the
 * iframe through a custom URI scheme so the frame gets its own CSP; plain
 * browser hosts use `srcdoc`.
 */
export function resolveFrameSource(): FrameSource {
  if (isTauriRuntime()) {
    return { kind: "src", url: TAURI_FRAME_URL };
  }
  return { kind: "srcdoc", html: generateFrameHtml() };
}

/**
 * Sandbox attributes the iframe element must carry. Exposed so adapters
 * apply the exact same list and a CI test can keep this string honest.
 *
 * CRITICAL: must NOT contain `allow-same-origin`. See
 * `src/components/isolated/AGENTS.md` for the security rationale.
 */
export const ISOLATED_FRAME_SANDBOX =
  "allow-scripts allow-downloads allow-forms allow-pointer-lock";

// ── Controller ───────────────────────────────────────────────────────

/**
 * Internal queued message. JSON-RPC sends carry a `method`/`params` pair
 * and are flushed via `rpc.notify()`. Legacy sends carry a `raw` message
 * (any `ParentToIframeMessage` that has no canonical JSON-RPC method,
 * e.g. `interaction_state`) and are flushed via raw postMessage so the
 * iframe-side legacy handler picks them up.
 */
type QueuedSend =
  | { kind: "rpc"; method: string; params?: unknown }
  | { kind: "raw"; message: ParentToIframeMessage };

export class IsolatedFrameController {
  private readonly iframe: HTMLIFrameElement;
  private rendererCode: string | undefined;
  private rendererCss: string | undefined;
  private readonly initialContent?: RenderPayload;

  private theme: FrameThemePayload = { isDark: true, colorTheme: null };
  private forwardWheel: boolean;

  private rpc: JsonRpcTransport | null = null;
  private hasReceivedReady = false;
  private bootstrapping = false;
  private pending: QueuedSend[] = [];

  // Reserved for future routing of comm_open/comm_msg/comm_close through the
  // controller. The bridge currently wires legacy events from IsolatedFrame.tsx
  // directly; this slot lets a caller register one for the migration.
  // @ts-expect-error - intentionally held without read access yet.
  private commBridge: CommBridgeManager | null = null;

  private readonly _state$ = new BehaviorSubject<FrameLifecycleState>("booting");
  private readonly _resize$ = new Subject<FrameResizeEvent>();
  private readonly _renderComplete$ = new Subject<FrameRenderCompleteEvent>();
  private readonly _errors$ = new Subject<FrameError>();
  private readonly _linkClicks$ = new Subject<FrameLinkClickEvent>();
  private readonly _mouseDowns$ = new Subject<void>();
  private readonly _doubleClicks$ = new Subject<void>();
  private readonly _widgetUpdates$ = new Subject<FrameWidgetUpdateEvent>();
  private readonly _searchResults$ = new Subject<{ count: number }>();
  private readonly _messages$ = new Subject<IframeToParentMessage>();

  readonly state$: Observable<FrameLifecycleState> = this._state$.asObservable();
  readonly resize$: Observable<FrameResizeEvent> = this._resize$.asObservable();
  readonly renderComplete$: Observable<FrameRenderCompleteEvent> =
    this._renderComplete$.asObservable();
  readonly errors$: Observable<FrameError> = this._errors$.asObservable();
  readonly linkClicks$: Observable<FrameLinkClickEvent> = this._linkClicks$.asObservable();
  readonly mouseDowns$: Observable<void> = this._mouseDowns$.asObservable();
  readonly doubleClicks$: Observable<void> = this._doubleClicks$.asObservable();
  readonly widgetUpdates$: Observable<FrameWidgetUpdateEvent> = this._widgetUpdates$.asObservable();
  readonly searchResults$: Observable<{ count: number }> = this._searchResults$.asObservable();
  readonly messages$: Observable<IframeToParentMessage> = this._messages$.asObservable();

  private readonly windowMessageListener: (event: MessageEvent) => void;
  private disposed = false;

  constructor(options: IsolatedFrameControllerOptions) {
    this.iframe = options.iframe;
    this.rendererCode = options.rendererCode;
    this.rendererCss = options.rendererCss;
    this.initialContent = options.initialContent;
    this.forwardWheel = options.forwardWheelBoundary ?? true;
    if (options.initialTheme) {
      this.theme = options.initialTheme;
    }

    this.windowMessageListener = (event) => this.handleWindowMessage(event);
    window.addEventListener("message", this.windowMessageListener);
  }

  /** Current state without subscribing. */
  get state(): FrameLifecycleState {
    return this._state$.value;
  }

  // ── Public commands ─────────────────────────────────────────────

  /**
   * Generic outbound send. Maps legacy `{ type, payload }` shapes to their
   * canonical JSON-RPC method names. Falls back to a raw postMessage when
   * the renderer transport isn't up yet AND the message type isn't queueable
   * — currently nothing slips through that path, since every type in
   * `TYPE_TO_METHOD` is queueable.
   *
   * Prefer the typed helpers (`render`, `setTheme`, etc.) over this; the
   * generic path exists for adapters that need to forward an
   * already-shaped `ParentToIframeMessage` (e.g., from a comm bridge).
   */
  send(message: ParentToIframeMessage): void {
    const method = TYPE_TO_METHOD[message.type];
    if (method) {
      const params = "payload" in message ? message.payload : undefined;
      this.enqueue(method, params);
      return;
    }
    // No canonical JSON-RPC method (e.g. `interaction_state`). Queue as a
    // legacy postMessage and flush after the renderer is ready so the
    // iframe-side legacy handler picks it up. Without this gate, an early
    // `interaction_state` would land on the bootstrap-only listener and
    // get dropped.
    this.enqueueRaw(message);
  }

  render(payload: RenderPayload): void {
    this.enqueue(NTERACT_RENDER_OUTPUT, payload);
  }

  renderBatch(payloads: RenderPayload[]): void {
    this.enqueue(NTERACT_RENDER_BATCH, { outputs: payloads });
  }

  clear(): void {
    this.enqueue(NTERACT_CLEAR_OUTPUTS, undefined);
  }

  setTheme(theme: FrameThemePayload): void {
    this.theme = theme;
    // Theme can be applied before the renderer bundle is up — the iframe's
    // bootstrap script handles legacy `theme` messages. Once the renderer
    // transport is alive, prefer JSON-RPC so live theme changes follow the
    // same path as everything else.
    if (this.rpc && this.state === "ready") {
      this.rpc.notify(NTERACT_THEME, theme);
    } else if (this.iframe.contentWindow) {
      this.iframe.contentWindow.postMessage({ type: "theme", payload: theme }, "*");
    }
  }

  search(query: string, caseSensitive = false): void {
    // Search is handled by the iframe bootstrap script — bypasses the
    // post-ready queue so it works before the renderer bundle is installed.
    const params = { query, caseSensitive };
    if (this.rpc) {
      this.rpc.notify(NTERACT_SEARCH, params);
    } else if (this.iframe.contentWindow) {
      this.iframe.contentWindow.postMessage({ type: "search", payload: params }, "*");
    }
  }

  searchNavigate(matchIndex: number): void {
    const params = { matchIndex };
    if (this.rpc) {
      this.rpc.notify(NTERACT_SEARCH_NAVIGATE, params);
    } else if (this.iframe.contentWindow) {
      this.iframe.contentWindow.postMessage({ type: "search_navigate", payload: params }, "*");
    }
  }

  /**
   * Provide or replace the renderer bundle. If the iframe is already
   * bootstrapped, this triggers injection immediately; otherwise the
   * bundle is stashed and injected when the bootstrap handler runs.
   */
  setRendererBundle(code: string, css: string): void {
    this.rendererCode = code;
    this.rendererCss = css;
    if (this.state === "bootstrapped" && !this.bootstrapping) {
      this.injectRendererBundle();
    }
  }

  attachCommBridge(manager: CommBridgeManager): void {
    this.commBridge = manager;
    // Future: forward comm_open/comm_msg/comm_close routing here. The bridge
    // currently subscribes to legacy events directly from `IsolatedFrame.tsx`;
    // moving that wiring into the controller is a follow-up.
  }

  setWheelBoundaryForwarding(enabled: boolean): void {
    this.forwardWheel = enabled;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("message", this.windowMessageListener);
    this.rpc?.stop();
    this.rpc = null;
    this.pending.length = 0;
    this._state$.complete();
    this._resize$.complete();
    this._renderComplete$.complete();
    this._errors$.complete();
    this._linkClicks$.complete();
    this._mouseDowns$.complete();
    this._doubleClicks$.complete();
    this._widgetUpdates$.complete();
    this._searchResults$.complete();
    this._messages$.complete();
  }

  // ── Internal: send queue ─────────────────────────────────────────

  private enqueue(method: string, params: unknown): void {
    if (this.state !== "ready" || !this.rpc) {
      this.pending.push({ kind: "rpc", method, params });
      return;
    }
    this.rpc.notify(method, params);
  }

  private enqueueRaw(message: ParentToIframeMessage): void {
    if (this.state !== "ready") {
      this.pending.push({ kind: "raw", message });
      return;
    }
    this.iframe.contentWindow?.postMessage(message, "*");
  }

  private flushPending(): void {
    if (!this.rpc) return;
    const drain = this.pending;
    this.pending = [];
    for (const item of drain) {
      if (item.kind === "rpc") {
        this.rpc.notify(item.method, item.params);
      } else {
        this.iframe.contentWindow?.postMessage(item.message, "*");
      }
    }
  }

  // ── Internal: lifecycle ─────────────────────────────────────────

  private handleWindowMessage(event: MessageEvent): void {
    if (event.source !== this.iframe.contentWindow) return;
    const data = event.data;
    // Skip JSON-RPC envelopes — JsonRpcTransport handles them.
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { jsonrpc?: unknown }).jsonrpc === "2.0"
    ) {
      return;
    }
    if (!isIframeMessage(data)) return;

    this._messages$.next(data);

    switch (data.type) {
      case "ready":
        this.handleBootstrapReady();
        break;
      case "renderer_ready":
        // Legacy path some renderer paths still use; the canonical
        // signal is the JSON-RPC `nteract/rendererReady` registered in
        // attachTransport().
        this.handleRendererReady();
        break;
      case "resize":
        if (data.payload?.height != null) {
          this._resize$.next({ height: data.payload.height });
        }
        break;
      case "render_complete":
        // Legacy RenderCompleteMessage only carries `height`. The richer
        // payload shape (outputId/cellId/outputIndex) arrives through the
        // JSON-RPC path registered in attachTransport().
        if (data.payload?.height != null) {
          this._resize$.next({ height: data.payload.height });
        }
        this._renderComplete$.next({ height: data.payload?.height });
        break;
      case "link_click":
        if (data.payload?.url) {
          this._linkClicks$.next({
            url: data.payload.url,
            newTab: data.payload.newTab ?? false,
          });
        }
        break;
      case "dblclick":
        this._doubleClicks$.next();
        break;
      case "widget_update":
        if (data.payload?.commId && data.payload?.state) {
          this._widgetUpdates$.next({
            commId: data.payload.commId,
            state: data.payload.state,
          });
        }
        break;
      case "error":
        if (data.payload) {
          this._errors$.next(data.payload);
        }
        break;
      case "eval_result":
        if (data.payload?.success === false) {
          this._errors$.next({
            message: `Bundle eval failed: ${data.payload.error ?? "unknown"}`,
          });
        }
        break;
    }
  }

  private handleBootstrapReady(): void {
    const isReload = this.hasReceivedReady;
    this.hasReceivedReady = true;

    if (isReload) {
      // Iframe was reloaded (e.g., DOM move tore it down). Discard any
      // queued sends targeted at the old instance and rebuild state from
      // scratch.
      this.bootstrapping = false;
      this.pending.length = 0;
      this.rpc?.stop();
      this.rpc = null;
      this._state$.next("reloading");
    }

    this._state$.next("bootstrapped");

    // Apply theme as soon as we're bootstrapped, before the renderer bundle
    // takes over (the bootstrap script handles legacy `theme` messages).
    if (this.iframe.contentWindow) {
      this.iframe.contentWindow.postMessage({ type: "theme", payload: this.theme }, "*");
    }

    this.attachTransport();
    this.injectRendererBundle();
  }

  private attachTransport(): void {
    const win = this.iframe.contentWindow;
    if (!win) return;
    const transport = new JsonRpcTransport(win, win);
    transport.onNotification(NTERACT_RENDERER_READY, () => this.handleRendererReady());
    transport.onNotification(NTERACT_RESIZE, (params) => {
      const p = params as { height?: number } | undefined;
      if (p?.height != null) this._resize$.next({ height: p.height });
    });
    transport.onNotification(NTERACT_RENDER_COMPLETE, (params) => {
      const p = params as
        | { outputId?: string; cellId?: string; outputIndex?: number; height?: number }
        | undefined;
      if (p?.height != null) this._resize$.next({ height: p.height });
      this._renderComplete$.next({
        outputId: p?.outputId,
        cellId: p?.cellId,
        outputIndex: p?.outputIndex,
        height: p?.height,
      });
    });
    transport.onNotification(NTERACT_LINK_CLICK, (params) => {
      const p = params as { url?: string; newTab?: boolean } | undefined;
      if (p?.url) this._linkClicks$.next({ url: p.url, newTab: p.newTab ?? false });
    });
    transport.onNotification(NTERACT_MOUSE_DOWN, () => this._mouseDowns$.next());
    transport.onNotification(NTERACT_DOUBLE_CLICK, () => this._doubleClicks$.next());
    transport.onNotification(NTERACT_WHEEL_BOUNDARY, (params) => {
      if (!this.forwardWheel) return;
      scrollFrameWheelBoundary(this.iframe, params as { deltaY?: number });
    });
    transport.onNotification(NTERACT_WIDGET_UPDATE, (params) => {
      const p = params as { commId?: string; state?: Record<string, unknown> } | undefined;
      if (p?.commId && p?.state) {
        this._widgetUpdates$.next({ commId: p.commId, state: p.state });
      }
    });
    transport.onNotification(NTERACT_ERROR, (params) => {
      const p = params as { message?: string; stack?: string } | undefined;
      if (p?.message) this._errors$.next({ message: p.message, stack: p.stack });
    });
    transport.onNotification(NTERACT_EVAL_RESULT, (params) => {
      const p = params as { success?: boolean; error?: string } | undefined;
      if (p?.success === false) {
        this._errors$.next({ message: `Bundle eval failed: ${p.error ?? "unknown"}` });
      }
    });
    transport.onNotification(NTERACT_SEARCH_RESULTS, (params) => {
      const p = params as { count?: number } | undefined;
      if (typeof p?.count === "number") this._searchResults$.next({ count: p.count });
      this._messages$.next({
        type: "search_results",
        payload: p as { count: number },
      } as IframeToParentMessage);
    });
    transport.onNotification(NTERACT_WIDGET_READY, () => {
      this._messages$.next({ type: "widget_ready" } as IframeToParentMessage);
    });
    transport.onNotification(NTERACT_WIDGET_COMM_MSG, (params) => {
      this._messages$.next({
        type: "widget_comm_msg",
        payload: params,
      } as IframeToParentMessage);
    });
    transport.onNotification(NTERACT_WIDGET_COMM_CLOSE, (params) => {
      this._messages$.next({
        type: "widget_comm_close",
        payload: params,
      } as IframeToParentMessage);
    });
    transport.start();
    this.rpc = transport;
  }

  private injectRendererBundle(): void {
    if (this.bootstrapping) return;
    if (!this.iframe.contentWindow) return;
    if (!this.rendererCode || !this.rendererCss) {
      // Bundle not yet available. The transport is up so callers can
      // observe legacy/JSON-RPC messages, but the renderer stays uninstalled
      // until `setRendererBundle()` lands and re-enters this path.
      return;
    }
    this.bootstrapping = true;
    this._state$.next("installing");

    // CSS first; idempotent thanks to the iframe-side guard flag.
    const cssCode =
      "(function() {" +
      "if (window.__ISOLATED_CSS_LOADED__) return;" +
      "window.__ISOLATED_CSS_LOADED__ = true;" +
      "var style = document.createElement('style');" +
      "style.textContent = " +
      JSON.stringify(this.rendererCss) +
      ";" +
      "document.head.appendChild(style);" +
      "})();";
    this.iframe.contentWindow.postMessage({ type: "eval", payload: { code: cssCode } }, "*");

    // Then the JS bundle. String concat (not template literal) avoids
    // accidental backtick / ${} interactions with the renderer source.
    const jsWrapper =
      "(function() {" +
      "if (window.__ISOLATED_RENDERER_LOADED__) return;" +
      "window.__ISOLATED_RENDERER_LOADED__ = true;" +
      this.rendererCode +
      "})();";
    this.iframe.contentWindow.postMessage({ type: "eval", payload: { code: jsWrapper } }, "*");
  }

  private handleRendererReady(): void {
    if (this.state === "ready") return; // Idempotent.
    this._state$.next("ready");
    this.flushPending();
    if (this.initialContent && this.rpc) {
      this.rpc.notify(NTERACT_RENDER_OUTPUT, this.initialContent);
    }
  }
}
