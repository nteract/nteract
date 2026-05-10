import { SiftScrollHandoffCue } from "@nteract/sift/handoff";
import "@nteract/sift/handoff.css";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CommBridgeManager,
  type IframeToParentMessage,
  IsolatedFrame,
  type IsolatedFrameHandle,
} from "@/components/isolated";
import { injectPluginsForMimes, needsPlugin } from "@/components/isolated/iframe-libraries";
import { AnsiErrorOutput, AnsiStreamOutput } from "@/components/outputs/ansi-output";
import { isSafeForMainDom } from "@/components/outputs/safe-mime-types";
import { DEFAULT_PRIORITY, MediaRouter } from "@/components/outputs/media-router";
import { TracebackOutput } from "@/components/outputs/traceback-output";
import { useWidgetStore } from "@/components/widgets/widget-store-context";
import { useColorTheme, useDarkMode } from "@/lib/dark-mode";
import { ErrorBoundary } from "@/lib/error-boundary";
import { highlightTextInDom } from "@/lib/highlight-text";
import { OutputErrorFallback } from "@/lib/output-error-fallback";
import { cn } from "@/lib/utils";

const handleIframeError = (err: { message: string; stack?: string }) =>
  console.error("[OutputArea] iframe error:", err);

function formatPluginLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const FOCUSED_OUTPUT_WELL_VIEWPORT_RATIO = 0.8;
const MIN_OUTPUT_WELL_HEIGHT = 360;
const SIFT_VIEWPORT_TOP_INSET_PX = 96;
const SIFT_VIEWPORT_BOTTOM_INSET_PX = 32;

function siftFocusAccent(isDark: boolean, colorTheme?: string): string {
  if (colorTheme === "cream") {
    return isDark ? "#d4896a" : "#955f3b";
  }
  return isDark ? "#60a5fa" : "#3b82f6";
}

function getOutputWellMaxHeight(viewportRatio: number): number {
  if (typeof window === "undefined") return 720;
  return Math.max(MIN_OUTPUT_WELL_HEIGHT, Math.floor(window.innerHeight * viewportRatio));
}

function useOutputWellMaxHeight(viewportRatio: number): number {
  const [height, setHeight] = useState(() => getOutputWellMaxHeight(viewportRatio));

  useEffect(() => {
    const handleResize = () => {
      setHeight(getOutputWellMaxHeight(viewportRatio));
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [viewportRatio]);

  return height;
}

import type { JupyterOutput } from "./jupyter-output";
// Re-export so existing imports continue to work.
export type { JupyterOutput } from "./jupyter-output";

interface OutputAreaProps {
  /**
   * Array of Jupyter outputs to render.
   */
  outputs: JupyterOutput[];
  /**
   * Cell ID for stable output keys in the iframe (enables smooth updates).
   */
  cellId?: string;
  /**
   * Whether the output area is collapsed.
   */
  collapsed?: boolean;
  /**
   * Callback when collapse state is toggled.
   */
  onToggleCollapse?: () => void;
  /**
   * Maximum height before scrolling. Set to enable scroll behavior.
   */
  maxHeight?: number;
  /**
   * When true, iframe outputs receive focused sizing and own wheel gestures.
   * This disables scroll passthrough and wheel-boundary forwarding so this
   * cell owns wheel gestures while active.
   */
  focused?: boolean;
  /**
   * When false, explicit max-height constraints are ignored for in-DOM
   * outputs. Code cells use this for short text output so it renders as
   * plain notebook content.
   */
  useOutputWell?: boolean;
  /**
   * Additional CSS classes for the container.
   */
  className?: string;
  /**
   * Custom renderers passed to MediaRouter.
   */
  renderers?: Record<
    string,
    (props: {
      data: unknown;
      metadata: Record<string, unknown>;
      mimeType: string;
      className?: string;
    }) => ReactNode
  >;
  /**
   * Custom MIME type priority order.
   */
  priority?: readonly string[];
  /**
   * Force isolation mode. When true, all outputs render in an isolated iframe.
   * When "auto" (default), isolation is used when any output needs it.
   * When false, outputs render in-DOM (less secure but faster for simple outputs).
   */
  isolated?: boolean | "auto";
  /**
   * Pre-create the IsolatedFrame even when there are no outputs.
   * This allows the iframe to bootstrap ahead of time, making output rendering instant.
   * The iframe is hidden until outputs that need isolation arrive.
   * @default false
   */
  preloadIframe?: boolean;
  /**
   * Callback when a link is clicked in isolated outputs.
   */
  onLinkClick?: (url: string, newTab: boolean) => void;
  /**
   * Callback when widget state is updated in isolated outputs.
   * @deprecated Use the comm bridge instead for full widget support
   */
  onWidgetUpdate?: (commId: string, state: Record<string, unknown>) => void;
  /**
   * Search query to highlight in iframe outputs.
   * Empty string or undefined clears highlights.
   */
  searchQuery?: string;
  /**
   * Callback reporting how many search matches were found in this cell's outputs.
   * Called when iframe reports search_results or in-DOM highlighting completes.
   */
  onSearchMatchCount?: (count: number) => void;
  /**
   * Callback when the user clicks (mousedown) inside an isolated output iframe.
   * Use to update cell focus when the click is captured by the iframe.
   */
  onIframeMouseDown?: () => void;
}

/**
 * Normalize stream text (can be string or string array).
 */
function normalizeText(text: string | string[]): string {
  return Array.isArray(text) ? text.join("") : text;
}

/**
 * Select the best MIME type from available data based on priority.
 */
function selectMimeType(
  data: Record<string, unknown>,
  priority: readonly string[] = DEFAULT_PRIORITY,
): string | null {
  const availableTypes = Object.keys(data);
  for (const mimeType of priority) {
    if (availableTypes.includes(mimeType) && data[mimeType] != null) {
      return mimeType;
    }
  }
  const firstAvailable = availableTypes.find((type) => data[type] != null);
  return firstAvailable || null;
}

function isScrollPassthroughMimeType(mimeType: string): boolean {
  // Static document-like outputs (markdown / HTML / SVG) and sift's
  // interactive tables (parquet / arrow stream) all behave better as
  // click-to-engage: the page wheels through them by default;
  // pointer-down on the wrapper hands events back to the iframe so
  // sift's column drag, sort, and internal scroll work; pointer-out
  // releases. Without sift on this list the iframe traps every wheel
  // gesture that crosses its 600px box.
  return (
    mimeType === "text/markdown" ||
    mimeType === "text/html" ||
    mimeType === "image/svg+xml" ||
    mimeType === "application/vnd.apache.parquet" ||
    mimeType === "application/vnd.apache.arrow.stream"
  );
}

function isSiftMimeType(mimeType: string): boolean {
  return (
    mimeType === "application/vnd.apache.parquet" ||
    mimeType === "application/vnd.apache.arrow.stream"
  );
}

function outputAllowsScrollPassthrough(
  output: JupyterOutput,
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  if (output.output_type === "execute_result" || output.output_type === "display_data") {
    const mimeType = selectMimeType(output.data, priority);
    return mimeType != null && isScrollPassthroughMimeType(mimeType);
  }

  return true;
}

function outputUsesSift(
  output: JupyterOutput,
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  if (output.output_type === "execute_result" || output.output_type === "display_data") {
    const mimeType = selectMimeType(output.data, priority);
    return mimeType != null && isSiftMimeType(mimeType);
  }

  return false;
}

function scrollElementIntoComfortableView(element: HTMLElement | null): boolean {
  if (!element || typeof window === "undefined") return false;

  const rect = element.getBoundingClientRect();
  const bottomLimit = window.innerHeight - SIFT_VIEWPORT_BOTTOM_INSET_PX;
  const availableHeight = bottomLimit - SIFT_VIEWPORT_TOP_INSET_PX;
  let top = 0;

  if (rect.height > availableHeight) {
    if (Math.abs(rect.top - SIFT_VIEWPORT_TOP_INSET_PX) > 1) {
      top = rect.top - SIFT_VIEWPORT_TOP_INSET_PX;
    }
  } else if (rect.top < SIFT_VIEWPORT_TOP_INSET_PX) {
    top = rect.top - SIFT_VIEWPORT_TOP_INSET_PX;
  } else if (rect.bottom > bottomLimit) {
    top = rect.bottom - bottomLimit;
  }

  if (Math.abs(top) <= 1) return false;

  window.scrollBy({ top, behavior: "auto" });
  return true;
}

/**
 * Check if a single output needs iframe isolation.
 * Uses the safe-list: anything not explicitly safe defaults to isolation.
 */
function outputNeedsIsolation(
  output: JupyterOutput,
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  if (output.output_type === "execute_result" || output.output_type === "display_data") {
    const mimeType = selectMimeType(output.data, priority);
    return mimeType ? !isSafeForMainDom(mimeType) : false;
  }
  // stream and error outputs don't need isolation
  return false;
}

/**
 * Check if any outputs in the array need iframe isolation.
 * If any output needs isolation, ALL outputs should go to the iframe.
 */
export function anyOutputNeedsIsolation(
  outputs: JupyterOutput[],
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  return outputs.some((output) => outputNeedsIsolation(output, priority));
}

/**
 * Check if outputs contain any widget MIME types.
 */
function hasWidgetOutputs(
  outputs: JupyterOutput[],
  priority: readonly string[] = DEFAULT_PRIORITY,
): boolean {
  return outputs.some((output) => {
    if (output.output_type === "execute_result" || output.output_type === "display_data") {
      const mimeType = selectMimeType(output.data, priority);
      return mimeType === "application/vnd.jupyter.widget-view+json";
    }
    return false;
  });
}

/**
 * Render a single Jupyter output based on its type.
 */
function renderOutput(
  output: JupyterOutput,
  index: number,
  renderers?: OutputAreaProps["renderers"],
  priority?: readonly string[],
) {
  const key = `output-${index}`;

  switch (output.output_type) {
    case "execute_result":
    case "display_data":
      return (
        <MediaRouter
          key={key}
          data={output.data}
          metadata={output.metadata as Record<string, Record<string, unknown> | undefined>}
          renderers={renderers}
          priority={priority}
        />
      );

    case "stream":
      return (
        <AnsiStreamOutput key={key} text={normalizeText(output.text)} streamName={output.name} />
      );

    case "error":
      // Rich sibling is set by the daemon when either the kernel
      // emitted `application/vnd.nteract.traceback+json` (launcher path)
      // or the Rust-side ANSI parser synthesized one at `.ipynb` load.
      // When absent, fall back to the plain ANSI render — the classic
      // path still works for vanilla ipykernel_launcher.
      if (output.rich != null && typeof output.rich === "object") {
        return <TracebackOutput key={key} data={output.rich} />;
      }
      return (
        <AnsiErrorOutput
          key={key}
          ename={output.ename}
          evalue={output.evalue}
          traceback={output.traceback}
        />
      );

    default:
      return null;
  }
}

/**
 * OutputArea renders multiple Jupyter outputs with proper layout.
 *
 * Handles all Jupyter output types: execute_result, display_data, stream, and error.
 * Supports collapsible state. Outputs render in natural document flow by
 * default; callers opt into wrapper scrolling with `maxHeight` or by marking
 * an isolated output as focused.
 *
 * @example
 * ```tsx
 * <OutputArea
 *   outputs={cell.outputs}
 *   collapsed={outputsCollapsed}
 *   onToggleCollapse={() => setOutputsCollapsed(!outputsCollapsed)}
 * />
 * ```
 */
export function OutputArea({
  outputs,
  cellId,
  collapsed = false,
  onToggleCollapse,
  maxHeight,
  focused = false,
  useOutputWell = true,
  className,
  renderers,
  priority = DEFAULT_PRIORITY,
  isolated = "auto",
  preloadIframe = false,
  onLinkClick,
  onWidgetUpdate,
  searchQuery,
  onSearchMatchCount,
  onIframeMouseDown,
}: OutputAreaProps) {
  const id = useId();
  const frameRef = useRef<IsolatedFrameHandle>(null);
  const bridgeRef = useRef<CommBridgeManager | null>(null);
  const inDomOutputRef = useRef<HTMLDivElement>(null);
  const staticFrameInteractionRef = useRef<HTMLDivElement>(null);
  const ignoreScrollDeactivationRef = useRef(false);
  const ignoreScrollDeactivationTimerRef = useRef<number | null>(null);
  const injectedLibsRef = useRef(new Set<string>());
  const renderGenRef = useRef(0);
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const [staticFrameInteractionActive, setStaticFrameInteractionActive] = useState(false);

  const darkMode = useDarkMode();
  const colorTheme = useColorTheme();
  const focusedOutputWellMaxHeight = useOutputWellMaxHeight(FOCUSED_OUTPUT_WELL_VIEWPORT_RATIO);
  const inDomMaxHeight = useOutputWell ? (maxHeight ?? null) : null;
  const maxHeightStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!inDomMaxHeight) return undefined;
    return { maxHeight: `${inDomMaxHeight}px` };
  }, [inDomMaxHeight]);
  // Ref for reading current darkMode in callbacks without adding to deps
  const darkModeRef = useRef(darkMode);
  darkModeRef.current = darkMode;
  const colorThemeRef = useRef(colorTheme);
  colorThemeRef.current = colorTheme;

  // Get widget store context (may be null if not in provider)
  const widgetContext = useWidgetStore();

  // Determine if we should use isolation (when we have outputs)
  const shouldIsolate =
    outputs.length > 0 &&
    (isolated === true || (isolated === "auto" && anyOutputNeedsIsolation(outputs, priority)));
  const shouldConstrainIsolatedOutput = shouldIsolate && (focused || maxHeight != null);
  const isolatedOutputWellMaxHeight = focused
    ? focusedOutputWellMaxHeight
    : (maxHeight ?? focusedOutputWellMaxHeight);
  const isolatedOutputWellStyle = shouldConstrainIsolatedOutput
    ? {
        maxHeight: `${isolatedOutputWellMaxHeight}px`,
        ...(focused ? { minHeight: `${MIN_OUTPUT_WELL_HEIGHT}px` } : {}),
      }
    : undefined;

  // When preloading, we render the iframe even with no outputs (hidden)
  // This allows it to bootstrap ahead of time for instant rendering
  const showPreloadedIframe = preloadIframe && !collapsed;

  // Check if we have widgets and should set up comm bridge
  const hasWidgets = hasWidgetOutputs(outputs, priority);
  const hasSiftOutputs = outputs.some((output) => outputUsesSift(output, priority));
  const shouldUseBridge = shouldIsolate && hasWidgets && widgetContext !== null;
  const shouldUseScrollPassthroughFrame =
    shouldIsolate &&
    !focused &&
    !hasWidgets &&
    outputs.every((output) => outputAllowsScrollPassthrough(output, priority));
  const shouldScrollPassthroughFrame =
    shouldUseScrollPassthroughFrame && !staticFrameInteractionActive;
  const allowWheelBoundaryScroll =
    !focused && !shouldScrollPassthroughFrame && !(hasSiftOutputs && staticFrameInteractionActive);
  const showSiftInteractionCue =
    hasSiftOutputs && shouldUseScrollPassthroughFrame && !staticFrameInteractionActive;
  const siftFrameAccent = siftFocusAccent(darkMode, colorTheme);
  const siftFrameStyle = hasSiftOutputs
    ? ({
        "--notebook-sift-focus": siftFrameAccent,
        "--notebook-sift-focus-hover": `${siftFrameAccent}66`,
        boxShadow: staticFrameInteractionActive
          ? `0 0 0 2px ${siftFrameAccent}cc, 0 12px 30px ${siftFrameAccent}24`
          : undefined,
      } as React.CSSProperties)
    : undefined;

  const hasCollapseControl = onToggleCollapse !== undefined;

  useEffect(() => {
    if (!shouldUseScrollPassthroughFrame && staticFrameInteractionActive) {
      setStaticFrameInteractionActive(false);
    }
  }, [shouldUseScrollPassthroughFrame, staticFrameInteractionActive]);

  useEffect(() => {
    if (!hasSiftOutputs) return;
    frameRef.current?.send({
      type: "interaction_state",
      payload: { active: staticFrameInteractionActive },
    });
  }, [hasSiftOutputs, staticFrameInteractionActive]);

  useEffect(() => {
    return () => {
      if (ignoreScrollDeactivationTimerRef.current != null) {
        window.clearTimeout(ignoreScrollDeactivationTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!staticFrameInteractionActive) return;

    const handleScroll = () => {
      if (ignoreScrollDeactivationRef.current) return;
      setStaticFrameInteractionActive(false);
    };

    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [staticFrameInteractionActive]);

  useEffect(() => {
    if (!staticFrameInteractionActive) return;

    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && staticFrameInteractionRef.current?.contains(target)) {
        return;
      }
      setStaticFrameInteractionActive(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [staticFrameInteractionActive]);

  const activateStaticFrameInteraction = useCallback(() => {
    if (shouldUseScrollPassthroughFrame) {
      if (!staticFrameInteractionActive && hasSiftOutputs) {
        ignoreScrollDeactivationRef.current = scrollElementIntoComfortableView(
          staticFrameInteractionRef.current,
        );
        if (ignoreScrollDeactivationTimerRef.current != null) {
          window.clearTimeout(ignoreScrollDeactivationTimerRef.current);
        }
        ignoreScrollDeactivationTimerRef.current = window.setTimeout(() => {
          ignoreScrollDeactivationRef.current = false;
          ignoreScrollDeactivationTimerRef.current = null;
        }, 250);
      }
      setStaticFrameInteractionActive(true);
      // Move DOM focus off CodeMirror without scrolling; this wrapper owns
      // focus until iframe pointer interaction is active.
      staticFrameInteractionRef.current?.focus({ preventScroll: true });
    }
    onIframeMouseDown?.();
  }, [
    hasSiftOutputs,
    shouldUseScrollPassthroughFrame,
    staticFrameInteractionActive,
    onIframeMouseDown,
  ]);

  const deactivateStaticFrameInteractionWhenIdle = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      if (!(event.buttons > 0)) {
        setStaticFrameInteractionActive(false);
      }
    },
    [],
  );

  const handleStaticFrameKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      setStaticFrameInteractionActive(false);
    }
  }, []);

  // Handle messages from iframe, routing widget messages to comm bridge
  const handleIframeMessage = useCallback(
    (message: IframeToParentMessage) => {
      // Route widget messages to bridge
      if (bridgeRef.current) {
        bridgeRef.current.handleIframeMessage(message);
      }

      // Also handle widget_update for backward compatibility
      if (message.type === "widget_update" && onWidgetUpdate) {
        onWidgetUpdate(message.payload.commId, message.payload.state);
      }

      // Capture search result count from iframe
      if (message.type === "search_results") {
        onSearchMatchCount?.(message.payload.count);
      }
    },
    [onWidgetUpdate, onSearchMatchCount],
  );

  // Callback when frame is ready - set up bridge and render outputs
  const handleFrameReady = useCallback(async () => {
    if (!frameRef.current) return;

    // Bump generation so any in-flight async handleFrameReady from a
    // previous outputs snapshot will bail out after it awaits.
    const gen = ++renderGenRef.current;

    // Set up comm bridge if we have widgets and widget context
    if (shouldUseBridge && widgetContext && !bridgeRef.current) {
      bridgeRef.current = new CommBridgeManager({
        frame: frameRef.current,
        store: widgetContext.store,
        sendUpdate: widgetContext.sendUpdate,
        sendCustom: widgetContext.sendCustom,
        closeComm: widgetContext.closeComm,
      });
    }

    // Ensure theme is in sync before re-rendering (fixes theme drift after cell moves)
    // Use ref to avoid adding darkMode to deps which would cause re-renders on theme toggle
    frameRef.current.setTheme(darkModeRef.current, colorThemeRef.current ?? null);

    // Install renderer plugins required by the outputs (e.g. plotly, vega).
    // Must happen before clear+render so the installRenderer messages arrive first.
    // Clear the tracking set on each call — a reloaded iframe has a fresh registry.
    injectedLibsRef.current.clear();

    // Collect MIME types that need renderer plugins from the cell's outputs
    const pluginMimes = new Set<string>();
    for (const output of outputs) {
      if (output.output_type === "execute_result" || output.output_type === "display_data") {
        for (const mime of Object.keys(output.data)) {
          if (needsPlugin(mime)) pluginMimes.add(mime);
        }
      }
    }

    // Also scan output widgets for captured outputs that need plugins.
    // A cell may output a widget view (application/vnd.jupyter.widget-view+json)
    // whose OutputModel.outputs contain plotly/vega/etc MIME types.
    if (widgetContext?.store) {
      for (const output of outputs) {
        if (
          (output.output_type === "execute_result" || output.output_type === "display_data") &&
          output.data?.["application/vnd.jupyter.widget-view+json"]
        ) {
          const widgetData = output.data["application/vnd.jupyter.widget-view+json"] as {
            model_id?: string;
          };
          if (widgetData?.model_id) {
            const model = widgetContext.store.getModel(widgetData.model_id);
            if (model?.modelName === "OutputModel" && model.state.outputs) {
              const widgetOutputs = model.state.outputs as Array<{
                output_type: string;
                data?: Record<string, unknown>;
              }>;
              for (const wo of widgetOutputs) {
                for (const mime of Object.keys(wo.data ?? {})) {
                  if (needsPlugin(mime)) pluginMimes.add(mime);
                }
              }
            }
          }
        }
      }
    }

    if (pluginMimes.size > 0) {
      try {
        await injectPluginsForMimes(frameRef.current, pluginMimes, injectedLibsRef.current);
      } catch (error) {
        if (gen !== renderGenRef.current) return;
        console.error("[OutputArea] Failed to load renderer plugin:", error);
        frameRef.current.renderBatch([
          {
            mimeType: "text/plain",
            data: `Failed to load renderer plugin: ${formatPluginLoadError(error)}`,
            metadata: { isError: true },
            cellId,
            outputIndex: 0,
          },
        ]);
        return;
      }
      // Stale check: if outputs changed while we were loading the plugin,
      // bail — a newer handleFrameReady call is already in flight.
      if (gen !== renderGenRef.current) return;
    }

    // Build batch of render payloads and send atomically.
    // This avoids the clear+re-render cycle that causes DOM thrashing
    // (visible as flickering when interactive widgets update rapidly).
    const batch: import("@/components/isolated/frame-bridge").RenderPayload[] = [];

    outputs.forEach((output, index) => {
      // output_id is the daemon-stamped UUID (non-empty invariant). Threading
      // it through lets the iframe React key reconciliation survive
      // display_update, stream append, and cell reorder without re-mounting
      // sibling outputs. outputIndex stays as a fallback for render paths
      // that don't surface an id.
      const outputId = output.output_id;
      if (output.output_type === "execute_result" || output.output_type === "display_data") {
        const mimeType = selectMimeType(output.data, priority);
        if (mimeType) {
          batch.push({
            mimeType,
            data: output.data[mimeType],
            metadata: output.metadata?.[mimeType] as Record<string, unknown> | undefined,
            outputId,
            cellId,
            outputIndex: index,
          });
        }
      } else if (output.output_type === "stream") {
        batch.push({
          mimeType: "text/plain",
          data: normalizeText(output.text),
          metadata: { streamName: output.name },
          outputId,
          cellId,
          outputIndex: index,
        });
      } else if (output.output_type === "error") {
        // Prefer the rich payload when present so mixed cells (HTML +
        // raise, plotly + raise, widget + raise) don't downgrade to
        // plain ANSI just because a sibling output forced iframe
        // isolation. The iframe's OutputRenderer routes the rich MIME
        // through TracebackOutput; without this branch we'd send
        // text/plain and the iframe's AnsiErrorOutput fallback would
        // win, losing the rich upgrade.
        if (output.rich != null && typeof output.rich === "object") {
          batch.push({
            mimeType: "application/vnd.nteract.traceback+json",
            data: output.rich,
            metadata: { isError: true },
            outputId,
            cellId,
            outputIndex: index,
          });
        } else {
          batch.push({
            mimeType: "text/plain",
            data: output.traceback.join("\n"),
            metadata: {
              isError: true,
              ename: output.ename,
              evalue: output.evalue,
              traceback: output.traceback,
            },
            outputId,
            cellId,
            outputIndex: index,
          });
        }
      }
    });

    frameRef.current.renderBatch(batch);

    // Re-apply search highlights after rendering new content
    if (searchQueryRef.current) {
      frameRef.current?.search(searchQueryRef.current);
    }
  }, [outputs, priority, shouldUseBridge, widgetContext]);

  // Clean up bridge on unmount
  useEffect(() => {
    return () => {
      if (bridgeRef.current) {
        bridgeRef.current.dispose();
        bridgeRef.current = null;
      }
    };
  }, []);

  // Re-render outputs when they change (after initial ready)
  useEffect(() => {
    if (frameRef.current?.isReady) {
      handleFrameReady();
    }
  }, [handleFrameReady]);

  // Forward search query to the iframe (for isolated outputs)
  useEffect(() => {
    if (frameRef.current?.isIframeReady) {
      frameRef.current.search(searchQuery || "");
    }
  }, [searchQuery]);

  // Highlight search matches in in-DOM outputs
  // Re-run when outputs array ref changes so new content gets highlighted
  useEffect(() => {
    if (shouldIsolate) return; // iframe reports its own count via search_results
    if (!searchQuery || !inDomOutputRef.current || outputs.length === 0) {
      // Only report 0 if we were previously tracking matches for this cell
      if (searchQuery) onSearchMatchCount?.(0);
      return;
    }
    const cleanup = highlightTextInDom(inDomOutputRef.current, searchQuery);
    const count = inDomOutputRef.current.querySelectorAll(".global-find-match").length;
    onSearchMatchCount?.(count);
    return cleanup;
  }, [searchQuery, shouldIsolate, outputs, onSearchMatchCount]);

  // Empty state: render nothing (unless preloading iframe)
  if (outputs.length === 0 && !showPreloadedIframe) {
    return null;
  }

  // Hide the entire output area when only preloading (no visible outputs)
  const isPreloadOnly = showPreloadedIframe && outputs.length === 0;

  // pl-6 pr-3 matches the code editor row padding so outputs align
  // flush with the editor content. The CellContainer output wrapper
  // has no horizontal padding — it must live here because the iframe
  // ignores padding on its parent container.
  return (
    <div
      data-slot="output-area"
      className={cn("output-area pl-6 pr-3", isPreloadOnly && "hidden", className)}
    >
      {/* Collapse toggle */}
      {hasCollapseControl && (
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={!collapsed}
          aria-controls={id}
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          <span>
            {collapsed
              ? `Show ${outputs.length} output${outputs.length > 1 ? "s" : ""}`
              : "Hide outputs"}
          </span>
        </button>
      )}

      {/* Output content */}
      {!collapsed && (
        <div
          id={id}
          className={cn(
            "space-y-2",
            !shouldIsolate && inDomMaxHeight !== null && "overflow-y-auto",
            shouldConstrainIsolatedOutput && "overflow-y-auto",
          )}
          style={shouldIsolate ? isolatedOutputWellStyle : maxHeightStyle}
        >
          {/* Preloaded or active isolated frame */}
          {(shouldIsolate || showPreloadedIframe) && (
            <div
              ref={staticFrameInteractionRef}
              className={cn(
                shouldIsolate ? "relative outline-none transition-shadow" : "hidden",
                hasSiftOutputs && "group/sift rounded-md overflow-hidden",
                hasSiftOutputs &&
                  shouldUseScrollPassthroughFrame &&
                  !staticFrameInteractionActive &&
                  "hover:ring-1 hover:ring-[var(--notebook-sift-focus-hover)]",
                hasSiftOutputs && staticFrameInteractionActive && "bg-background",
              )}
              style={siftFrameStyle}
              data-frame-interaction-active={staticFrameInteractionActive ? "true" : undefined}
              data-sift-output={hasSiftOutputs ? "true" : undefined}
              tabIndex={shouldUseScrollPassthroughFrame ? -1 : undefined}
              onPointerDown={
                shouldUseScrollPassthroughFrame ? activateStaticFrameInteraction : undefined
              }
              onPointerOut={
                shouldUseScrollPassthroughFrame
                  ? deactivateStaticFrameInteractionWhenIdle
                  : undefined
              }
              onKeyDown={shouldUseScrollPassthroughFrame ? handleStaticFrameKeyDown : undefined}
            >
              <IsolatedFrame
                ref={frameRef}
                darkMode={darkMode}
                colorTheme={colorTheme}
                minHeight={24}
                maxHeight={isolatedOutputWellMaxHeight}
                autoHeight={shouldIsolate && !focused}
                allowWheelBoundaryScroll={allowWheelBoundaryScroll}
                scrollPassthrough={shouldScrollPassthroughFrame}
                onReady={handleFrameReady}
                onLinkClick={onLinkClick}
                onMouseDown={activateStaticFrameInteraction}
                onWidgetUpdate={onWidgetUpdate}
                onMessage={handleIframeMessage}
                onError={handleIframeError}
              />
              {showSiftInteractionCue && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-end rounded-b-md pb-[9px] pr-[84px] opacity-0 transition-opacity duration-150 group-hover/sift:opacity-100 group-focus-within/sift:opacity-100">
                  <SiftScrollHandoffCue
                    className="pointer-events-auto"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      activateStaticFrameInteraction();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      activateStaticFrameInteraction();
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/* In-DOM outputs (when not using isolation) */}
          {!shouldIsolate && (
            <div ref={inDomOutputRef}>
              {outputs.map((output, index) => {
                // Prefer daemon-stamped output_id for stable React keys so a
                // stream append doesn't re-mount sibling outputs. Fall back
                // to positional when a render path skipped the id.
                const key = output.output_id ?? `output-${index}`;
                return (
                  <div key={key} data-slot="output-item" data-output-index={index}>
                    <ErrorBoundary
                      resetKeys={[output]}
                      fallback={(error, reset) => (
                        <OutputErrorFallback error={error} outputIndex={index} onRetry={reset} />
                      )}
                      onError={(error, errorInfo) => {
                        console.error(
                          `[OutputArea] Error rendering output ${index}:`,
                          error,
                          errorInfo.componentStack,
                        );
                      }}
                    >
                      {renderOutput(output, index, renderers, priority)}
                    </ErrorBoundary>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
