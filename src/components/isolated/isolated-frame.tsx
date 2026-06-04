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
import type { NteractMeasureElementResult } from "./rpc-methods";
import { logIsolatedDiagnostic, type IsolatedDiagnosticHandler } from "./diagnostics";
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
import {
  DEFAULT_OUTPUT_FRAME_MAX_HEIGHT,
  DEFAULT_OUTPUT_FRAME_MIN_HEIGHT,
  outputFrameContainerDimensions,
  outputFrameDisplayHeight,
  sameOutputFrameContainerDimensions,
  undefinedIfEmptyContainerDimensions,
} from "./output-frame-sizing";
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
   * URL for the isolated output document shell. Hosted deployments can use a
   * separate output-document origin; browser-only local development leaves this
   * unset and uses srcDoc.
   */
  outputDocumentUrl?: string | null;

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
   * This only gates parent-side application of boundary events; the iframe
   * must also opt in through forwardWheelBoundaryScroll before it emits them.
   * @default true
   */
  allowWheelBoundaryScroll?: boolean;

  /**
   * When true, the iframe bootstrap emits wheel-boundary events to the host.
   * Keep false for document-like outputs that should stay on the browser's
   * native scroll path.
   * @default false
   */
  forwardWheelBoundaryScroll?: boolean;

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
   * Callback when the user releases a click inside the iframe.
   * `hasSelection` lets document-like frames stay engaged after text selection
   * while releasing ordinary clicks back to notebook-native scrolling.
   */
  onMouseUp?: (params: { hasSelection?: boolean }) => void;

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
   * Callback for structured renderer diagnostics. Hosts can route this to their
   * own logging transport; when omitted, diagnostics use the console fallback.
   */
  onDiagnostic?: IsolatedDiagnosticHandler;

  /**
   * When true, iframe starts hidden (0 height, 0 opacity) and reveals
   * with animation after content is rendered. Use for markdown cells
   * to prevent flash of empty/unstyled content during bootstrap.
   * @default false
   */
  revealOnRender?: boolean;

  /**
   * When used with `revealOnRender`, keep the current frame height reserved
   * while content is visually hidden. This lets document-like surfaces avoid
   * late layout shifts while still fading in rendered content.
   * @default false
   */
  reserveHeightOnReveal?: boolean;
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
   * Measure a renderer-owned element by deterministic anchor ID.
   */
  measureElement: (anchorId: string) => Promise<NteractMeasureElementResult | null>;

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
 *       data: "<h1>Hello from isolated frame!</h1>",
 *       outputId: "example-output",
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
      outputDocumentUrl,
      minHeight = DEFAULT_OUTPUT_FRAME_MIN_HEIGHT,
      maxHeight = DEFAULT_OUTPUT_FRAME_MAX_HEIGHT,
      autoHeight = false,
      className = "",
      allowWheelBoundaryScroll = true,
      forwardWheelBoundaryScroll = false,
      scrollPassthrough = false,
      onReady,
      onResize,
      onLinkClick,
      onMouseDown,
      onMouseUp,
      onDoubleClick,
      onWidgetUpdate,
      onError,
      onMessage,
      onDiagnostic,
      revealOnRender = false,
      reserveHeightOnReveal = false,
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
    const initialThemeSeedRef = useRef({
      theme: darkMode ? ("dark" as const) : ("light" as const),
      colorTheme: colorTheme ?? null,
    });
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
    const onMouseUpRef = useRef(onMouseUp);
    const onDoubleClickRef = useRef(onDoubleClick);
    const onWidgetUpdateRef = useRef(onWidgetUpdate);
    const onErrorRef = useRef(onError);
    const onMessageRef = useRef(onMessage);
    const onDiagnosticRef = useRef(onDiagnostic);
    const allowWheelBoundaryScrollRef = useRef(allowWheelBoundaryScroll);
    const frameDiagnosticContextRef = useRef({
      frameId: id ?? null,
      frameName: name ?? null,
    });

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
    onMouseUpRef.current = onMouseUp;
    onDoubleClickRef.current = onDoubleClick;
    onWidgetUpdateRef.current = onWidgetUpdate;
    onErrorRef.current = onError;
    onMessageRef.current = onMessage;
    onDiagnosticRef.current = onDiagnostic;
    allowWheelBoundaryScrollRef.current = allowWheelBoundaryScroll;
    initialContentRef.current = initialContent;
    frameDiagnosticContextRef.current = {
      frameId: id ?? null,
      frameName: name ?? null,
    };
    logFrameDiagnosticRef.current = logFrameDiagnostic;

    const applyMeasuredHeight = useCallback(
      (contentHeight: number) => {
        measuredHeightRef.current = contentHeight;
        const newHeight = outputFrameDisplayHeight(contentHeight, {
          autoHeight,
          maxHeight,
          minHeight,
        });
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
          onMouseUp: (params) => {
            onMouseUpRef.current?.(params);
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
            const enrichedDetails = {
              ...frameDiagnosticContextRef.current,
              generation: runtimeRef.current?.generation ?? 0,
              ...details,
            };
            if (onDiagnosticRef.current) {
              onDiagnosticRef.current(phase, enrichedDetails, level, source);
            } else {
              logFrameDiagnosticRef.current(phase, details, level, source);
            }
          },
        },
      });
    }

    useEffect(() => {
      applyMeasuredHeight(measuredHeightRef.current);
    }, [applyMeasuredHeight]);

    const resolvedOutputDocumentUrl = outputDocumentUrl ?? hostContext?.nteract?.outputDocumentUrl;

    // Create frame document on mount. The shared config keeps React, future
    // non-React adapters, and tests on the same source/sandbox contract.
    useEffect(() => {
      setFrameDocument(
        createIsolatedFrameDocument({
          outputDocumentUrl: resolvedOutputDocumentUrl,
          themeSeed: initialThemeSeedRef.current,
        }),
      );
    }, [resolvedOutputDocumentUrl]);

    useEffect(() => {
      const iframe = iframeRef.current;
      if (!iframe) return;

      const updateContainerDimensions = () => {
        const next = undefinedIfEmptyContainerDimensions(
          outputFrameContainerDimensions(iframe, { autoHeight, maxHeight, minHeight }),
        );
        setContainerDimensions((prev) =>
          sameOutputFrameContainerDimensions(prev, next) ? prev : next,
        );
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
    }, [autoHeight, frameDocument, maxHeight, minHeight]);

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

    useEffect(() => {
      if (!isIframeReady) return;
      runtimeRef.current?.send({
        type: "wheel_boundary_policy",
        payload: { enabled: forwardWheelBoundaryScroll },
      });
    }, [forwardWheelBoundaryScroll, isIframeReady]);

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
        measureElement: (anchorId: string) =>
          runtimeRef.current?.measureElement(anchorId) ?? Promise.resolve(null),
        isReady,
        isIframeReady,
      }),
      [send, isReady, isIframeReady],
    );

    if (!frameDocument) {
      return null;
    }

    // Compute display values for revealOnRender mode
    const displayHeight =
      revealOnRender && !isContentRendered && !reserveHeightOnReveal ? 0 : height;
    const displayOpacity = revealOnRender && !isContentRendered ? 0 : 1;

    return (
      <iframe
        ref={iframeRef}
        id={id}
        name={name}
        src={frameDocument.kind === "src" ? frameDocument.url : undefined}
        srcDoc={frameDocument.kind === "srcdoc" ? frameDocument.html : undefined}
        sandbox={ISOLATED_FRAME_SANDBOX_ATTRS}
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
          userSelect: scrollPassthrough ? "none" : undefined,
          WebkitUserSelect: scrollPassthrough ? "none" : undefined,
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
