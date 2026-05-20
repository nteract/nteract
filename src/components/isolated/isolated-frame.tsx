import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { IframeToParentMessage, ParentToIframeMessage, RenderPayload } from "./frame-bridge";
import { logIsolatedDiagnostic } from "./diagnostics";
import {
  createIsolatedFrameDocument,
  ISOLATED_FRAME_ALLOW_ATTR,
  ISOLATED_FRAME_SANDBOX_ATTRS,
  type IsolatedFrameDocument,
} from "./frame-config";
import type { NteractEmbedContainerDimensions, NteractEmbedHostContextPatch } from "./host-context";
import { createNteractEmbedHostContext, mergeNteractEmbedHostContext } from "./host-context";
import { IsolatedFrameRuntime } from "./isolated-frame-runtime";
import { useIsolatedRenderer } from "./isolated-renderer-context";
import { scrollFrameWheelBoundary } from "./scroll-boundary";

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
   * Additional host context to expose to the iframe. Shape intentionally
   * mirrors MCP Apps HostContext so external hosts can embed nteract with
   * minimal theming and sizing glue.
   */
  hostContext?: NteractEmbedHostContextPatch;

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
   * Send a message to the iframe.
   */
  send: (message: ParentToIframeMessage) => void;

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
   * Update theme settings in the iframe.
   */
  setTheme: (isDark: boolean, colorTheme?: string | null) => void;

  /**
   * Merge host-context fields into the iframe's current embed context.
   */
  setHostContext: (hostContext: NteractEmbedHostContextPatch) => void;

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

function iframeContainerDimensions(
  iframe: HTMLIFrameElement | null,
  autoHeight: boolean,
  maxHeight: number,
): NteractEmbedContainerDimensions | undefined {
  const dimensions: NteractEmbedContainerDimensions = {};
  const width = iframe ? Math.round(iframe.getBoundingClientRect().width) : 0;
  if (width > 0) {
    dimensions.width = width;
  }
  if (!autoHeight && Number.isFinite(maxHeight)) {
    dimensions.maxHeight = maxHeight;
  }
  return Object.keys(dimensions).length > 0 ? dimensions : undefined;
}

function sameContainerDimensions(
  a: NteractEmbedContainerDimensions | undefined,
  b: NteractEmbedContainerDimensions | undefined,
): boolean {
  return (
    (a?.width ?? null) === (b?.width ?? null) &&
    (a?.maxWidth ?? null) === (b?.maxWidth ?? null) &&
    (a?.height ?? null) === (b?.height ?? null) &&
    (a?.maxHeight ?? null) === (b?.maxHeight ?? null)
  );
}

/**
 * IsolatedFrame component - Renders untrusted content in a secure iframe.
 *
 * Uses sandbox restrictions to ensure the iframe content cannot access Tauri
 * APIs or the parent DOM. Tauri loads the iframe from the nteract-frame custom
 * scheme so the frame receives its own CSP. Communication happens via postMessage.
 *
 * **Requires** `IsolatedRendererProvider` to be present in the component tree.
 *
 * @example
 * ```tsx
 * // In your app root or layout:
 * <IsolatedRendererProvider basePath="/isolated">
 *   <App />
 * </IsolatedRendererProvider>
 *
 * // Then use IsolatedFrame anywhere:
 * const frameRef = useRef<IsolatedFrameHandle>(null);
 *
 * <IsolatedFrame
 *   ref={frameRef}
 *   darkMode={true}
 *   onReady={() => {
 *     frameRef.current?.render({
 *       mimeType: "text/html",
 *       data: "<h1>Hello from isolated frame!</h1>"
 *     });
 *   }}
 *   onResize={(height) => console.log("New height:", height)}
 * />
 * ```
 */
export const IsolatedFrame = forwardRef<IsolatedFrameHandle, IsolatedFrameProps>(
  function IsolatedFrame(
    {
      id,
      name,
      initialContent,
      darkMode = true,
      colorTheme,
      hostContext,
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
    // Get renderer bundle from context (provided by IsolatedRendererProvider)
    const {
      rendererCode,
      rendererCss,
      isLoading: providerLoading,
      error: providerError,
    } = useIsolatedRenderer();
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const runtimeRef = useRef<IsolatedFrameRuntime | null>(null);
    const initialContentRef = useRef(initialContent);
    const applyMeasuredHeightRef = useRef<(contentHeight: number) => void>(() => {});
    const [frameDocument, setFrameDocument] = useState<IsolatedFrameDocument | null>(null);
    // Track iframe ready (bootstrap HTML loaded)
    const [isIframeReady, setIsIframeReady] = useState(false);
    // Track renderer ready (React bundle initialized)
    const [isReady, setIsReady] = useState(false);
    const [height, setHeight] = useState(minHeight);
    const displayHeightRef = useRef(minHeight);
    const measuredHeightRef = useRef(minHeight);
    const [containerDimensions, setContainerDimensions] = useState<
      NteractEmbedContainerDimensions | undefined
    >(undefined);
    const [imperativeHostContext, setImperativeHostContext] =
      useState<NteractEmbedHostContextPatch>({});
    // Track if content has been rendered (for revealOnRender mode)
    const [isContentRendered, setIsContentRendered] = useState(false);
    // Track if the iframe is reloading (DOM move caused browser to tear down)
    // Used to hide the iframe during reload to prevent white flash
    const [isReloading, setIsReloading] = useState(false);

    // Stable refs for callback props — avoids tearing down the message
    // handler when callers pass unstable (inline) callbacks.
    const onReadyRef = useRef(onReady);
    const onResizeRef = useRef(onResize);
    const onLinkClickRef = useRef(onLinkClick);
    const onMouseDownRef = useRef(onMouseDown);
    const onDoubleClickRef = useRef(onDoubleClick);
    const onWidgetUpdateRef = useRef(onWidgetUpdate);
    const onErrorRef = useRef(onError);
    const onMessageRef = useRef(onMessage);
    const allowWheelBoundaryScrollRef = useRef(allowWheelBoundaryScroll);

    const logFrameDiagnostic = useCallback(
      (
        phase: string,
        details: Record<string, unknown> = {},
        level: "debug" | "info" | "warn" | "error" = "debug",
        source: "isolated-frame" | "isolated-renderer" | "iframe-libraries" = "isolated-frame",
      ) => {
        logIsolatedDiagnostic({
          source,
          phase,
          level,
          details: {
            frameId: id ?? null,
            frameName: name ?? null,
            generation: runtimeRef.current?.generation ?? 0,
            ...details,
          },
        });
      },
      [id, name],
    );
    const logFrameDiagnosticRef = useRef(logFrameDiagnostic);

    // Sync refs during render so effects always see the latest callbacks.
    onReadyRef.current = onReady;
    onResizeRef.current = onResize;
    onLinkClickRef.current = onLinkClick;
    onMouseDownRef.current = onMouseDown;
    onDoubleClickRef.current = onDoubleClick;
    onWidgetUpdateRef.current = onWidgetUpdate;
    onErrorRef.current = onError;
    onMessageRef.current = onMessage;
    allowWheelBoundaryScrollRef.current = allowWheelBoundaryScroll;
    initialContentRef.current = initialContent;
    logFrameDiagnosticRef.current = logFrameDiagnostic;

    const applyMeasuredHeight = useCallback(
      (contentHeight: number) => {
        measuredHeightRef.current = contentHeight;
        const newHeight = autoHeight
          ? Math.max(minHeight, contentHeight)
          : Math.max(minHeight, Math.min(maxHeight, contentHeight));
        if (displayHeightRef.current === newHeight) {
          return;
        }
        displayHeightRef.current = newHeight;
        setHeight(newHeight);
        onResizeRef.current?.(newHeight);
      },
      [autoHeight, maxHeight, minHeight],
    );
    applyMeasuredHeightRef.current = applyMeasuredHeight;

    if (!runtimeRef.current) {
      runtimeRef.current = new IsolatedFrameRuntime({
        getFrameWindow: () => iframeRef.current?.contentWindow,
        getInitialContent: () => initialContentRef.current,
        // Seed the runtime before passive effects so an early iframe bootstrap
        // message can report the current bundle state.
        rendererBundle: { rendererCode, rendererCss },
        callbacks: {
          onBootstrapReady: ({ isReload }) => {
            if (isReload) {
              setIsReady(false);
              setIsContentRendered(false);
              setIsReloading(true);
              setIsIframeReady(false);
              window.setTimeout(() => {
                setIsIframeReady(true);
              }, 0);
            } else {
              setIsIframeReady(true);
            }
          },
          onRendererReady: () => {
            setIsReady(true);
            setIsReloading(false);
            onReadyRef.current?.();
          },
          onResize: (contentHeight) => {
            applyMeasuredHeightRef.current(contentHeight);
          },
          onRenderComplete: (contentHeight) => {
            setIsContentRendered(true);
            applyMeasuredHeightRef.current(contentHeight);
          },
          onLinkClick: (url, newTab) => {
            onLinkClickRef.current?.(url, newTab);
          },
          onMouseDown: () => {
            onMouseDownRef.current?.();
          },
          onDoubleClick: () => {
            onDoubleClickRef.current?.();
          },
          onWheelBoundary: (params) => {
            if (!allowWheelBoundaryScrollRef.current) {
              return;
            }
            scrollFrameWheelBoundary(iframeRef.current, params);
          },
          onWidgetUpdate: (commId, state) => {
            onWidgetUpdateRef.current?.(commId, state);
          },
          onError: (error) => {
            onErrorRef.current?.(error);
          },
          onMessage: (message) => {
            onMessageRef.current?.(message);
          },
          onDiagnostic: (phase, details = {}, level = "debug", source = "isolated-frame") => {
            logFrameDiagnosticRef.current(phase, details, level, source);
          },
        },
      });
    }

    useEffect(() => {
      applyMeasuredHeight(measuredHeightRef.current);
    }, [applyMeasuredHeight]);

    // Create frame document on mount. The shared config keeps React, future
    // non-React adapters, and tests on the same source/sandbox contract.
    useEffect(() => {
      setFrameDocument(createIsolatedFrameDocument());
    }, []);

    useEffect(() => {
      const iframe = iframeRef.current;
      if (!iframe) return;

      const updateContainerDimensions = () => {
        const next = iframeContainerDimensions(iframe, autoHeight, maxHeight);
        setContainerDimensions((prev) => (sameContainerDimensions(prev, next) ? prev : next));
      };

      updateContainerDimensions();
      const observer =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(updateContainerDimensions);
      observer?.observe(iframe);
      window.addEventListener("resize", updateContainerDimensions);
      return () => {
        observer?.disconnect();
        window.removeEventListener("resize", updateContainerDimensions);
      };
    }, [autoHeight, frameDocument, maxHeight]);

    const resolvedHostContext = useMemo(
      () =>
        mergeNteractEmbedHostContext(
          createNteractEmbedHostContext({
            isDark: darkMode,
            colorTheme: colorTheme ?? null,
            containerDimensions,
          }),
          hostContext,
          imperativeHostContext,
        ),
      [colorTheme, containerDimensions, darkMode, hostContext, imperativeHostContext],
    );

    // Send theme and host context as soon as iframe bootstrap is ready. The
    // bootstrap document already handles theme over JSON-RPC; host context moves
    // from the legacy path to JSON-RPC once the React renderer is ready.
    useEffect(() => {
      if (isIframeReady && iframeRef.current?.contentWindow) {
        const runtime = runtimeRef.current;
        runtime?.setTheme(darkMode, colorTheme ?? null);
        runtime?.notifyHostContext(resolvedHostContext);
      }
    }, [darkMode, colorTheme, isIframeReady, isReady, resolvedHostContext]);

    // Surface provider errors to consumers
    useEffect(() => {
      if (providerError && !providerLoading) {
        logFrameDiagnostic(
          "renderer-bundle-provider-error",
          { message: providerError.message, stack: providerError.stack },
          "error",
        );
        onErrorRef.current?.({
          message: providerError.message,
          stack: providerError.stack,
        });
      }
    }, [logFrameDiagnostic, providerError, providerLoading]);

    const send = useCallback((message: ParentToIframeMessage) => {
      runtimeRef.current?.send(message);
    }, []);

    useEffect(() => {
      runtimeRef.current?.setRendererBundle({ rendererCode, rendererCss });
    }, [rendererCode, rendererCss]);

    // Handle messages from iframe
    useEffect(() => {
      const handleMessage = (event: MessageEvent) => {
        runtimeRef.current?.handleWindowMessage(event);
      };

      window.addEventListener("message", handleMessage);
      return () => window.removeEventListener("message", handleMessage);
    }, []);

    // Clean up JSON-RPC transport on unmount
    useEffect(() => {
      runtimeRef.current?.activate();
      return () => {
        runtimeRef.current?.dispose();
      };
    }, []);

    useEffect(() => {
      if (!isIframeReady) return;
      const runtime = runtimeRef.current;
      if (!runtime?.waitingForRendererBundle()) return;
      const timer = window.setTimeout(() => {
        runtime.reportRendererBundlePending({
          providerLoading,
          providerError,
        });
      }, 1500);

      return () => window.clearTimeout(timer);
    }, [isIframeReady, isReady, rendererCode, rendererCss, providerLoading, providerError]);

    // Inject renderer when iframe is ready. The runtime returns false until
    // both bundle parts are available.
    useEffect(() => {
      if (!isIframeReady) return;
      runtimeRef.current?.injectRendererBundle();
    }, [isIframeReady, isReady, rendererCode, rendererCss]);

    // Expose imperative API
    useImperativeHandle(
      ref,
      () => ({
        send,
        render: (payload: RenderPayload) => runtimeRef.current?.render(payload),
        renderBatch: (outputs: RenderPayload[]) => runtimeRef.current?.renderBatch(outputs),
        eval: (code: string) => runtimeRef.current?.eval(code),
        installRenderer: (code: string, css?: string) =>
          runtimeRef.current?.installRenderer(code, css),
        setTheme: (isDark: boolean, colorTheme?: string | null) =>
          runtimeRef.current?.setTheme(isDark, colorTheme),
        setHostContext: (nextHostContext: NteractEmbedHostContextPatch) => {
          setImperativeHostContext((prev) => mergeNteractEmbedHostContext(prev, nextHostContext));
        },
        clear: () => runtimeRef.current?.clear(),
        search: (query: string, caseSensitive?: boolean) =>
          runtimeRef.current?.search(query, caseSensitive),
        searchNavigate: (matchIndex: number) => runtimeRef.current?.searchNavigate(matchIndex),
        isReady,
        isIframeReady,
      }),
      [send, isReady, isIframeReady],
    );

    if (!frameDocument) {
      return null;
    }

    // Compute display values for revealOnRender mode
    const displayHeight = revealOnRender && !isContentRendered ? 0 : height;
    const displayOpacity = revealOnRender && !isContentRendered ? 0 : 1;

    return (
      <iframe
        ref={iframeRef}
        id={id}
        name={name}
        src={frameDocument.kind === "src" ? frameDocument.url : undefined}
        srcDoc={frameDocument.kind === "srcdoc" ? frameDocument.html : undefined}
        sandbox={ISOLATED_FRAME_SANDBOX_ATTRS}
        allowFullScreen
        allow={ISOLATED_FRAME_ALLOW_ATTR}
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
          // Hide iframe during reload to prevent white flash from blank document.
          // visibility:hidden preserves layout (keeps height) while hiding content.
          visibility: isReloading ? "hidden" : "visible",
          transition: revealOnRender ? "height 150ms ease-out, opacity 150ms ease-out" : undefined,
        }}
        title=""
      />
    );
  },
);
