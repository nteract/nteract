import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { IframeToParentMessage } from "./frame-bridge";
import {
  ISOLATED_FRAME_SANDBOX,
  IsolatedFrameController,
  type RenderPayload,
  resolveFrameSource,
} from "./isolated-frame-controller";
import type { FrameSource } from "./isolated-frame-controller";
import { useIsolatedRenderer } from "./isolated-renderer-context";
import type {
  NteractCommCloseParams,
  NteractCommMsgParams,
  NteractCommOpenParams,
  NteractHostToIframeMethod,
  NteractHostToIframeParams,
  NteractWidgetSnapshotParams,
} from "./rpc-methods";

export interface IsolatedFrameProps {
  /**
   * Unique ID for this frame (used for message routing).
   */
  id?: string;

  /**
   * Human-readable frame name. Surfaces in dev-tools frame pickers and
   * `window.frames` lookups. Not rendered visually - `title` is a
   * separate attribute that we always leave empty.
   */
  name?: string;

  /**
   * Initial content to render when the frame is ready.
   */
  initialContent?: RenderPayload;

  /**
   * Whether to use dark mode styling.
   */
  darkMode?: boolean;

  /**
   * Color theme name (e.g., "classic", "cream").
   * Passed to the iframe as `data-color-theme` attribute.
   */
  colorTheme?: string;

  /**
   * Minimum height of the iframe in pixels.
   * @default 24
   */
  minHeight?: number;

  /**
   * Maximum height of the iframe in pixels.
   * Ignored when `autoHeight` is `true`.
   * @default 2000
   */
  maxHeight?: number;

  /**
   * When true, iframe grows to fit content without maxHeight cap.
   * Use for content that should render fully (e.g., markdown cells).
   * Takes precedence over maxHeight when enabled.
   * @default false
   */
  autoHeight?: boolean;

  /**
   * Additional CSS classes for the iframe container.
   */
  className?: string;

  /**
   * When true, wheel events that reach a scroll boundary inside the iframe
   * are forwarded to the nearest scrollable parent.
   * @default true
   */
  allowWheelBoundaryScroll?: boolean;

  /**
   * When true, the iframe is transparent to pointer hit-testing so wheel
   * gestures stay on the parent document's native scroll path. Use for
   * full-height static/document-like frames that should not trap scrolling.
   * @default false
   */
  scrollPassthrough?: boolean;

  /**
   * Callback when the iframe is ready to receive messages.
   */
  onReady?: () => void;

  /**
   * Callback when the iframe content resizes.
   */
  onResize?: (height: number) => void;

  /**
   * Callback when a link is clicked in the iframe.
   */
  onLinkClick?: (url: string, newTab: boolean) => void;

  /**
   * Callback when the user clicks (mousedown) inside the iframe.
   * Fires before any other click handling — does not interfere
   * with text selection, links, or widget interactions.
   */
  onMouseDown?: () => void;

  /**
   * Callback when the user double-clicks in the iframe.
   */
  onDoubleClick?: () => void;

  /**
   * Callback when a widget state update is sent from the iframe.
   */
  onWidgetUpdate?: (commId: string, state: Record<string, unknown>) => void;

  /**
   * Callback when an error occurs in the iframe.
   */
  onError?: (error: { message: string; stack?: string }) => void;

  /**
   * Callback for all messages from the iframe (for debugging or custom handling).
   */
  onMessage?: (message: IframeToParentMessage) => void;

  /**
   * When true, iframe starts hidden (0 height, 0 opacity) and reveals
   * with animation after content is rendered. Use for markdown cells
   * to prevent flash of empty/unstyled content during bootstrap.
   * @default false
   */
  revealOnRender?: boolean;
}

export interface IsolatedFrameHandle {
  /**
   * Send a JSON-RPC notification to the iframe.
   */
  notify: <M extends NteractHostToIframeMethod>(
    method: M,
    params?: NteractHostToIframeParams[M],
  ) => void;

  /**
   * Send content to render in the iframe.
   */
  render: (payload: RenderPayload) => void;

  /**
   * Atomically replace all outputs with a batch.
   * Uses stable IDs from cellId + outputIndex for smooth React reconciliation.
   */
  renderBatch: (outputs: RenderPayload[]) => void;

  /**
   * Evaluate code in the iframe (for bootstrap/injection).
   */
  eval: (code: string) => void;

  /**
   * Install a renderer plugin in the iframe.
   * The plugin is a CJS module that exports an install(ctx) function.
   * The iframe loads it with a custom require shim providing React,
   * then calls install() with a registration API for MIME types.
   */
  installRenderer: (code: string, css?: string) => void;

  /**
   * Notify the iframe that the parent widget bridge is ready.
   */
  bridgeReady: () => void;

  /**
   * Forward widget comm traffic to the iframe.
   */
  commOpen: (params: NteractCommOpenParams) => void;
  commMsg: (params: NteractCommMsgParams) => void;
  commClose: (params: NteractCommCloseParams) => void;

  /**
   * Sync the current widget model snapshot into the iframe.
   */
  widgetSnapshot: (params: NteractWidgetSnapshotParams) => void;

  /**
   * Tell the iframe whether parent-side interaction has been handed off.
   */
  setInteractionState: (active: boolean) => void;

  /**
   * Update theme settings in the iframe.
   */
  setTheme: (isDark: boolean, colorTheme?: string | null) => void;

  /**
   * Clear all content in the iframe.
   */
  clear: () => void;

  /**
   * Search for text within the iframe's rendered content.
   * Pass empty string to clear search highlights.
   */
  search: (query: string, caseSensitive?: boolean) => void;

  /**
   * Navigate to a specific search match by index.
   */
  searchNavigate: (matchIndex: number) => void;

  /**
   * Whether the iframe is ready to receive messages.
   * True after the React renderer bundle is initialized.
   */
  isReady: boolean;

  /**
   * Whether the iframe bootstrap HTML is loaded.
   * True before the React renderer bundle is loaded.
   */
  isIframeReady: boolean;
}

/**
 * IsolatedFrame - thin React shell over IsolatedFrameController.
 *
 * The component owns nothing but the iframe element, the height/visibility
 * state, and the imperative-handle bridge. All lifecycle, transport, and
 * message routing live in `IsolatedFrameController` so the same orchestration
 * can be reused from Vue, vanilla JS, or any other host.
 *
 * Requires `IsolatedRendererProvider` to be present in the component tree.
 */
export const IsolatedFrame = forwardRef<IsolatedFrameHandle, IsolatedFrameProps>(
  function IsolatedFrame(
    {
      id,
      name,
      initialContent,
      darkMode = true,
      colorTheme,
      minHeight = 24,
      maxHeight = 2000,
      autoHeight = false,
      className = "",
      allowWheelBoundaryScroll = true,
      scrollPassthrough = false,
      onReady,
      onResize,
      onLinkClick,
      onMouseDown,
      onDoubleClick,
      onWidgetUpdate,
      onError,
      onMessage,
      revealOnRender = false,
    },
    ref,
  ) {
    const {
      rendererCode,
      rendererCss,
      isLoading: providerLoading,
      error: providerError,
    } = useIsolatedRenderer();

    const iframeRef = useRef<HTMLIFrameElement>(null);
    const controllerRef = useRef<IsolatedFrameController | null>(null);
    const [frameDocument, setFrameDocument] = useState<FrameSource | null>(null);

    const [isIframeReady, setIsIframeReady] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const [isReloading, setIsReloading] = useState(false);
    const [isContentRendered, setIsContentRendered] = useState(false);
    const [height, setHeight] = useState(minHeight);
    const measuredHeightRef = useRef(minHeight);

    // Stable refs for callback props — survive controller re-subscription.
    const onReadyRef = useRef(onReady);
    const onResizeRef = useRef(onResize);
    const onLinkClickRef = useRef(onLinkClick);
    const onMouseDownRef = useRef(onMouseDown);
    const onDoubleClickRef = useRef(onDoubleClick);
    const onWidgetUpdateRef = useRef(onWidgetUpdate);
    const onErrorRef = useRef(onError);
    const onMessageRef = useRef(onMessage);

    onReadyRef.current = onReady;
    onResizeRef.current = onResize;
    onLinkClickRef.current = onLinkClick;
    onMouseDownRef.current = onMouseDown;
    onDoubleClickRef.current = onDoubleClick;
    onWidgetUpdateRef.current = onWidgetUpdate;
    onErrorRef.current = onError;
    onMessageRef.current = onMessage;

    const applyMeasuredHeight = useCallback(
      (contentHeight: number) => {
        measuredHeightRef.current = contentHeight;
        const clamped = autoHeight
          ? Math.max(minHeight, contentHeight)
          : Math.max(minHeight, Math.min(maxHeight, contentHeight));
        setHeight(clamped);
        onResizeRef.current?.(clamped);
      },
      [autoHeight, maxHeight, minHeight],
    );

    // Mirror the latest clamping callback into a ref so the controller
    // subscriptions can call it without forcing the controller-creation
    // effect to re-run on height-policy prop changes. If the controller
    // tore down whenever `autoHeight`/`maxHeight`/`minHeight` changed,
    // the new instance would never see another `ready` from the
    // already-loaded iframe and stay stuck in `booting`.
    const applyMeasuredHeightRef = useRef(applyMeasuredHeight);
    applyMeasuredHeightRef.current = applyMeasuredHeight;

    // Re-apply height when clamping props change.
    useEffect(() => {
      applyMeasuredHeight(measuredHeightRef.current);
    }, [applyMeasuredHeight]);

    // Resolve frame source once on mount.
    useEffect(() => {
      setFrameDocument(resolveFrameSource());
    }, []);

    // Surface provider errors to consumers.
    useEffect(() => {
      if (providerError && !providerLoading) {
        onErrorRef.current?.({
          message: providerError.message,
          stack: providerError.stack,
        });
      }
    }, [providerError, providerLoading]);

    // Instantiate the controller once the iframe is mounted. The bundle is
    // fed in via `setRendererBundle` once the provider resolves; until then
    // the controller's transport is up (so `ready` etc. land) but the
    // renderer injection is deferred.
    useEffect(() => {
      const iframe = iframeRef.current;
      if (!iframe || !frameDocument) return;

      const controller = new IsolatedFrameController({
        iframe,
        initialContent,
        initialTheme: { isDark: darkMode, colorTheme: colorTheme ?? null },
        forwardWheelBoundary: allowWheelBoundaryScroll,
      });
      controllerRef.current = controller;

      const subs = [
        controller.state$.subscribe((state) => {
          // `bootstrapped` and later means the iframe HTML is loaded.
          const iframeReady = state !== "booting";
          setIsIframeReady(iframeReady);

          const ready = state === "ready";
          setIsReady((prev) => {
            if (prev === ready) return prev;
            if (ready) onReadyRef.current?.();
            return ready;
          });

          if (state === "reloading") {
            setIsReloading(true);
            setIsContentRendered(false);
          } else if (state === "ready") {
            setIsReloading(false);
          }
        }),
        controller.resize$.subscribe(({ height: h }) => {
          applyMeasuredHeightRef.current(h);
        }),
        controller.renderComplete$.subscribe(({ height: h }) => {
          if (h != null) {
            setIsContentRendered(true);
            applyMeasuredHeightRef.current(h);
          } else {
            setIsContentRendered(true);
          }
        }),
        controller.linkClicks$.subscribe(({ url, newTab }) => {
          onLinkClickRef.current?.(url, newTab);
        }),
        controller.mouseDowns$.subscribe(() => {
          onMouseDownRef.current?.();
        }),
        controller.doubleClicks$.subscribe(() => {
          onDoubleClickRef.current?.();
        }),
        controller.widgetUpdates$.subscribe(({ commId, state }) => {
          onWidgetUpdateRef.current?.(commId, state);
        }),
        controller.errors$.subscribe((err) => {
          onErrorRef.current?.(err);
        }),
        controller.messages$.subscribe((msg) => {
          onMessageRef.current?.(msg);
        }),
      ];

      return () => {
        for (const sub of subs) sub.unsubscribe();
        controller.dispose();
        controllerRef.current = null;
      };
      // Effect is keyed to `frameDocument` only — the controller is one
      // per iframe element. `initialContent`, `darkMode`, `colorTheme`,
      // `allowWheelBoundaryScroll` are read at construction; live changes
      // propagate through the dedicated effects below, not by recreating
      // the controller (which would orphan the loaded iframe).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [frameDocument]);

    // Hand the renderer bundle to the controller as soon as it resolves.
    useEffect(() => {
      if (rendererCode && rendererCss) {
        controllerRef.current?.setRendererBundle(rendererCode, rendererCss);
      }
    }, [rendererCode, rendererCss]);

    // Live theme updates.
    useEffect(() => {
      controllerRef.current?.setTheme({
        isDark: darkMode,
        colorTheme: colorTheme ?? null,
      });
    }, [darkMode, colorTheme]);

    // Live wheel-boundary forwarding toggle.
    useEffect(() => {
      controllerRef.current?.setWheelBoundaryForwarding(allowWheelBoundaryScroll);
    }, [allowWheelBoundaryScroll]);

    useImperativeHandle(
      ref,
      () => ({
        notify: (method, params) => controllerRef.current?.notify(method, params),
        render: (payload: RenderPayload) => controllerRef.current?.render(payload),
        renderBatch: (outputs: RenderPayload[]) => controllerRef.current?.renderBatch(outputs),
        eval: (code: string) => controllerRef.current?.eval(code),
        installRenderer: (code: string, css?: string) =>
          controllerRef.current?.installRenderer(code, css),
        bridgeReady: () => controllerRef.current?.bridgeReady(),
        commOpen: (params: NteractCommOpenParams) => controllerRef.current?.commOpen(params),
        commMsg: (params: NteractCommMsgParams) => controllerRef.current?.commMsg(params),
        commClose: (params: NteractCommCloseParams) => controllerRef.current?.commClose(params),
        widgetSnapshot: (params: NteractWidgetSnapshotParams) =>
          controllerRef.current?.widgetSnapshot(params),
        setInteractionState: (active: boolean) =>
          controllerRef.current?.setInteractionState(active),
        setTheme: (isDark: boolean, theme?: string | null) =>
          controllerRef.current?.setTheme({ isDark, colorTheme: theme ?? null }),
        clear: () => controllerRef.current?.clear(),
        search: (query: string, caseSensitive?: boolean) =>
          controllerRef.current?.search(query, caseSensitive),
        searchNavigate: (matchIndex: number) => controllerRef.current?.searchNavigate(matchIndex),
        isReady,
        isIframeReady,
      }),
      [isReady, isIframeReady],
    );

    if (!frameDocument) return null;

    const displayHeight = revealOnRender && !isContentRendered ? 0 : height;
    const displayOpacity = revealOnRender && !isContentRendered ? 0 : 1;

    return (
      <iframe
        ref={iframeRef}
        id={id}
        name={name}
        src={frameDocument.kind === "src" ? frameDocument.url : undefined}
        srcDoc={frameDocument.kind === "srcdoc" ? frameDocument.html : undefined}
        sandbox={ISOLATED_FRAME_SANDBOX}
        allowFullScreen
        allow="fullscreen *"
        className={className}
        data-slot="isolated-frame"
        style={{
          width: "100%",
          height: `${displayHeight}px`,
          opacity: displayOpacity,
          border: "none",
          display: "block",
          pointerEvents: scrollPassthrough ? "none" : undefined,
          userSelect: "none",
          WebkitUserSelect: "none",
          background: "transparent",
          colorScheme: darkMode ? "dark" : "light",
          // visibility:hidden during reload preserves layout while hiding the
          // blank iframe document mid-tear-down/re-init.
          visibility: isReloading ? "hidden" : "visible",
          transition: revealOnRender ? "height 150ms ease-out, opacity 150ms ease-out" : undefined,
        }}
        title=""
      />
    );
  },
);
