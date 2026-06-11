import { SiftScrollHandoffCue } from "@nteract/sift/handoff";
import "@nteract/sift/handoff.css";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  anyOutputNeedsIsolation,
  CommBridgeManager,
  hasWidgetOutputs,
  type IframeToParentMessage,
  IsolatedFrame,
  type IsolatedDiagnosticHandler,
  type IsolatedFrameHandle,
  outputAllowsScrollPassthrough,
  outputNeedsIsolation,
  type OutputSegment,
  outputUsesSift,
  outputUsesWheelOwningFrame,
  type RenderPayload,
  segmentedOutputLanes,
  useIsolatedRenderer,
  useRegisterIsolatedOutput,
} from "@/components/isolated";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { injectPluginsForMimes, needsPlugin } from "@/components/isolated/iframe-libraries";
import {
  jupyterOutputsToRenderPayloads,
  type IdentifiedJupyterOutput,
} from "@/components/isolated/output-payloads";
import { AnsiErrorOutput, AnsiStreamOutput } from "@/components/outputs/ansi-output";
import { DEFAULT_PRIORITY, MediaRouter } from "@/components/outputs/media-router";
import {
  classicTracebackToPayload,
  TracebackOutput,
  type TracebackCellTarget,
  type TracebackCellNavigator,
  type TracebackExecutionResolver,
} from "@/components/outputs/traceback-output";
import { useWidgetStore } from "@/components/widgets/widget-store-context";
import { useSavedWidgetModels } from "@/components/widgets/saved-widget-state-context";
import {
  parseWidgetViewModelId,
  WIDGET_VIEW_MIME,
  type SavedWidgetModels,
} from "@/components/widgets/widget-state";
import type { WidgetStore } from "@/components/widgets/widget-store";
import { useColorTheme, useDarkMode } from "@/lib/dark-mode";
import { ErrorBoundary } from "@/lib/error-boundary";
import { highlightTextInDom } from "@/lib/highlight-text";
import { OutputErrorFallback } from "@/lib/output-error-fallback";
import { cn } from "@/lib/utils";
import { cellOutputInnerInset } from "./cell-layout";

const handleIframeError = (err: { message: string; stack?: string }) =>
  console.error("[OutputArea] iframe error:", err);

function formatPluginLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withSavedWidgetStateHint(
  payload: RenderPayload,
  store: WidgetStore | undefined,
  savedWidgetModels: SavedWidgetModels,
): RenderPayload {
  if (payload.mimeType !== WIDGET_VIEW_MIME) return payload;

  const modelId = parseWidgetViewModelId(payload.data);
  if (!modelId || store?.getModel(modelId)) return payload;

  const savedModel = savedWidgetModels.get(modelId);
  if (!savedModel) return payload;

  return {
    ...payload,
    widgetStateHint: {
      ...payload.widgetStateHint,
      savedModel,
    },
  };
}

const FOCUSED_OUTPUT_WELL_VIEWPORT_RATIO = 0.8;
const MIN_OUTPUT_WELL_HEIGHT = 360;
const DEFERRED_OUTPUT_PLACEHOLDER_HEIGHT = 96;
const SIFT_VIEWPORT_TOP_INSET_PX = 96;
const SIFT_VIEWPORT_BOTTOM_INSET_PX = 32;
const DEFAULT_DEFERRED_ISOLATED_FRAME_ROOT_MARGIN = "1200px 0px";

function outputAreaInsetClass(layoutInset: NonNullable<OutputAreaProps["layoutInset"]>) {
  switch (layoutInset) {
    case "cell-output":
      return cellOutputInnerInset;
    case "none":
      return undefined;
    case "standalone":
      return "pl-6";
  }
}

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

function useDeferredIsolatedFrame({
  enabled,
  rootMargin,
}: {
  enabled: boolean;
  rootMargin: string;
}) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const [activated, setActivated] = useState(!enabled);

  useEffect(() => {
    if (!enabled) {
      setActivated(true);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || activated) return;

    if (typeof window === "undefined" || typeof window.IntersectionObserver === "undefined") {
      setActivated(true);
      return;
    }

    const target = targetRef.current;
    if (!target) {
      setActivated(true);
      return;
    }

    const observer = new window.IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
          setActivated(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [activated, enabled, rootMargin]);

  return { activated, targetRef };
}

import type { JupyterOutput } from "./jupyter-output";
import { notebookOutputAnchorId } from "runtimed";
// Re-export so existing imports continue to work.
export type { JupyterOutput } from "./jupyter-output";

interface OutputAreaProps {
  /**
   * Array of Jupyter outputs to render.
   * Isolated rendering requires every output to carry a non-empty `output_id`.
   * Non-runtime render surfaces must stamp a synthetic id before passing
   * outputs here.
   */
  outputs: JupyterOutput[];
  /**
   * Cell ID for stable output keys in the iframe (enables smooth updates).
   */
  cellId?: string;
  /**
   * Execution count for the cell. Used to label the isolated iframe with
   * `code-Out[N]-{cellId}` so the dev-tools frame picker shows something
   * meaningful instead of a stack of identical `localhost` rows.
   */
  executionCount?: number | null;
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
   * Left inset behavior for the output content.
   *
   * `standalone` preserves the default renderer padding. `cell-output` aligns
   * output content with a surrounding CellContainer's content column.
   */
  layoutInset?: "standalone" | "cell-output" | "none";
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
   * Defer mounting isolated output frames until the output is near the
   * viewport. Once mounted, the frame stays mounted so interactive outputs
   * keep their internal state.
   * @default false
   */
  deferIsolatedFrameUntilVisible?: boolean;
  /**
   * IntersectionObserver root margin used when
   * `deferIsolatedFrameUntilVisible` is enabled.
   */
  deferredIsolatedFrameRootMargin?: string;
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
  /**
   * Exposes the mounted isolated frame handle to shared cell surfaces that need
   * iframe RPCs, such as markdown heading measurement for outline navigation.
   */
  onIsolatedFrameHandleChange?: (handle: IsolatedFrameHandle | null) => void;
  /**
   * Callback for structured isolated renderer diagnostics.
   */
  onDiagnostic?: IsolatedDiagnosticHandler;
  /**
   * Host-specific context passed through to isolated output iframes. Cloud
   * viewers use this for renderer sidecar asset bases; desktop callers can
   * keep relying on the default daemon-local context.
   */
  hostContext?: NteractEmbedHostContextPatch;
  /**
   * Resolve a traceback frame's execution_id back to a current notebook cell,
   * when the execution still belongs to one. Omitted in read-only/isolated
   * contexts that cannot navigate notebook cells.
   */
  resolveTracebackExecutionTarget?: TracebackExecutionResolver;
  /** Navigate to the cell resolved for a traceback frame. */
  onNavigateToTracebackCell?: TracebackCellNavigator;
}

/**
 * Normalize stream text (can be string or string array).
 */
function normalizeText(text: string | string[]): string {
  return Array.isArray(text) ? text.join("") : text;
}

function outputSegmentKey(segment: OutputSegment, index: number): string {
  const firstOutput = segment.outputs[0];
  if (firstOutput?.output_id) {
    return [segment.lane, firstOutput.output_id].join("\0");
  }
  return [segment.lane, index, firstOutput?.output_type ?? "empty"].join("\0");
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

function requireIdentifiedOutputs(outputs: JupyterOutput[]): IdentifiedJupyterOutput[] {
  for (const output of outputs) {
    if (!output.output_id) {
      throw new Error("Cannot render isolated output without output_id");
    }
  }
  return outputs as IdentifiedJupyterOutput[];
}

/**
 * Render a single Jupyter output based on its type.
 */
function renderOutput(
  output: JupyterOutput,
  index: number,
  renderers?: OutputAreaProps["renderers"],
  priority?: readonly string[],
  resolveTracebackExecutionTarget?: OutputAreaProps["resolveTracebackExecutionTarget"],
  onNavigateToTracebackCell?: OutputAreaProps["onNavigateToTracebackCell"],
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
        return (
          <TracebackOutput
            key={key}
            data={output.rich}
            resolveExecutionTarget={resolveTracebackExecutionTarget}
            onNavigateToCell={onNavigateToTracebackCell}
          />
        );
      }
      const classicTraceback = classicTracebackToPayload({
        ename: output.ename,
        evalue: output.evalue,
        traceback: output.traceback,
      });
      if (classicTraceback) {
        return (
          <TracebackOutput
            key={key}
            data={classicTraceback}
            resolveExecutionTarget={resolveTracebackExecutionTarget}
            onNavigateToCell={onNavigateToTracebackCell}
          />
        );
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

interface TracebackExecutionTargetEntry {
  execution_id: string;
  source_hash?: string;
  target: TracebackCellTarget;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collectTracebackExecutionTargets(
  data: unknown,
  resolveExecutionTarget?: TracebackExecutionResolver,
): TracebackExecutionTargetEntry[] {
  if (!resolveExecutionTarget) return [];

  const payload = objectRecord(data);
  if (!payload) return [];

  const entries: TracebackExecutionTargetEntry[] = [];
  const seen = new Set<string>();

  const addSource = (source: unknown) => {
    const record = objectRecord(source);
    if (!record) return;

    const sourceRef = objectRecord(record.source_ref);
    const executionId = stringField(sourceRef?.execution_id) ?? stringField(record.execution_id);
    if (!executionId) return;

    const sourceHash = stringField(sourceRef?.source_hash) ?? stringField(record.source_hash);
    const key = `${executionId}\u0000${sourceHash ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);

    const target = resolveExecutionTarget(executionId, sourceHash);
    if (target) {
      entries.push({ execution_id: executionId, source_hash: sourceHash, target });
    }
  };

  addSource(payload.syntax);
  const frames = payload.frames;
  if (Array.isArray(frames)) {
    frames.forEach(addSource);
  }

  return entries;
}

function withTracebackExecutionTargets(
  payload: RenderPayload,
  resolveExecutionTarget?: TracebackExecutionResolver,
): RenderPayload {
  if (payload.mimeType !== "application/vnd.nteract.traceback+json") return payload;

  const targets = collectTracebackExecutionTargets(payload.data, resolveExecutionTarget);
  if (targets.length === 0) return payload;

  return {
    ...payload,
    metadata: {
      ...payload.metadata,
      tracebackExecutionTargets: targets,
    },
  };
}

/**
 * OutputArea renders multiple Jupyter outputs with proper layout.
 *
 * Handles all Jupyter output types: execute_result, display_data, stream, and error.
 * Outputs render in natural document flow by default; callers opt into wrapper
 * scrolling with `maxHeight` or by marking an isolated output as focused.
 */
export function OutputArea({
  outputs,
  isolated = "auto",
  priority = DEFAULT_PRIORITY,
  ...props
}: OutputAreaProps) {
  const { onSearchMatchCount, preloadIframe = false, ...passthroughProps } = props;
  const segmentedSearchMatchCountsRef = useRef(new Map<string, number>());
  const outputSegments = segmentedOutputLanes(outputs, {
    isolated,
    hasCollapseControl: false,
    priority,
  });
  const outputSegmentKeys = outputSegments.map(outputSegmentKey);

  if (outputSegments.length > 0) {
    return (
      <>
        {outputSegments.map((segment, index) => {
          const segmentKey = outputSegmentKeys[index] ?? outputSegmentKey(segment, index);
          return (
            <OutputAreaSingle
              key={segmentKey}
              {...passthroughProps}
              outputs={segment.outputs}
              isolated="auto"
              onSearchMatchCount={
                onSearchMatchCount
                  ? (count) => {
                      const counts = segmentedSearchMatchCountsRef.current;
                      const activeKeys = new Set(outputSegmentKeys);
                      for (const key of counts.keys()) {
                        if (!activeKeys.has(key)) counts.delete(key);
                      }
                      counts.set(segmentKey, count);
                      const total = outputSegmentKeys.reduce(
                        (sum, key) => sum + (counts.get(key) ?? 0),
                        0,
                      );
                      onSearchMatchCount(total);
                    }
                  : undefined
              }
              preloadIframe={segment.lane === "dom" ? false : preloadIframe}
              priority={priority}
            />
          );
        })}
      </>
    );
  }

  return (
    <OutputAreaSingle
      {...passthroughProps}
      outputs={outputs}
      isolated={isolated}
      onSearchMatchCount={onSearchMatchCount}
      preloadIframe={preloadIframe}
      priority={priority}
    />
  );
}

function OutputAreaSingle({
  outputs,
  cellId,
  executionCount,
  maxHeight,
  focused = false,
  useOutputWell = true,
  className,
  layoutInset = "standalone",
  renderers,
  priority = DEFAULT_PRIORITY,
  isolated = "auto",
  preloadIframe = false,
  deferIsolatedFrameUntilVisible = false,
  deferredIsolatedFrameRootMargin = DEFAULT_DEFERRED_ISOLATED_FRAME_ROOT_MARGIN,
  onLinkClick,
  onWidgetUpdate,
  searchQuery,
  onSearchMatchCount,
  onIframeMouseDown,
  onIsolatedFrameHandleChange,
  onDiagnostic,
  hostContext,
  resolveTracebackExecutionTarget,
  onNavigateToTracebackCell,
}: OutputAreaProps) {
  const id = useId();
  const frameRef = useRef<IsolatedFrameHandle>(null);
  const bridgeRef = useRef<CommBridgeManager | null>(null);
  const inDomOutputRef = useRef<HTMLDivElement>(null);
  const staticFrameInteractionRef = useRef<HTMLDivElement>(null);
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
  const savedWidgetModels = useSavedWidgetModels();
  const rendererBundle = useIsolatedRenderer();

  // Determine if we should use isolation (when we have outputs)
  const shouldIsolate =
    outputs.length > 0 &&
    (isolated === true || (isolated === "auto" && anyOutputNeedsIsolation(outputs, priority)));
  // Page-level surfaces (the cloud's aggregated asset notice) gate on
  // whether anything on screen actually renders isolated outputs.
  useRegisterIsolatedOutput(shouldIsolate);
  // Renderer-bundle failure (the provider's bounded retries exhausted):
  // the frame could only render a silent blank well, so show the same
  // degraded fallback the in-DOM branch gets. `lastError` keeps the
  // fallback mounted through an in-flight retry ladder — frames remount
  // only once the bundle actually loads, so a hopeless Retry click never
  // churns N blank iframes. retry() recovery is shared module-level
  // state — one click un-blanks every output at once.
  const rendererBundleError = shouldIsolate
    ? (rendererBundle.error ?? rendererBundle.lastError)
    : null;
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
  const showPreloadedIframe = preloadIframe;
  const shouldDeferIsolatedFrame =
    deferIsolatedFrameUntilVisible && shouldIsolate && !showPreloadedIframe;
  const deferredIsolatedFrame = useDeferredIsolatedFrame({
    enabled: shouldDeferIsolatedFrame,
    rootMargin: deferredIsolatedFrameRootMargin,
  });
  const shouldMountIsolatedFrame = !shouldDeferIsolatedFrame || deferredIsolatedFrame.activated;

  // Frame name for dev-tools picker. `code-Out[N]-{cellId}` mirrors the
  // Jupyter `Out[N]` convention with the cell ID appended so the picker can
  // distinguish reruns and concurrent cells. `*` matches Jupyter's queued /
  // never-run indicator.
  const frameName = cellId
    ? `code-Out[${executionCount == null ? "*" : executionCount}]-${cellId}`
    : undefined;

  // Check if we have widgets and should set up comm bridge
  const hasWidgets = hasWidgetOutputs(outputs, priority);
  const hasSiftOutputs = outputs.some((output) => outputUsesSift(output, priority));
  // Sift tables and Vega/Altair charts must own the wheel once engaged so the
  // page does not steal pan/zoom (the source of unintended Altair zoom while
  // scrolling). Both render through the same click-to-engage frame.
  const hasWheelOwningOutputs = outputs.some((output) =>
    outputUsesWheelOwningFrame(output, priority),
  );
  const shouldUseBridge = shouldIsolate && hasWidgets && widgetContext !== null;
  const shouldUseScrollPassthroughFrame =
    shouldIsolate &&
    !focused &&
    !hasWidgets &&
    outputs.every((output) => outputAllowsScrollPassthrough(output, priority));
  const shouldScrollPassthroughFrame =
    shouldUseScrollPassthroughFrame && !staticFrameInteractionActive;
  const shouldLockWheelBoundary = hasWheelOwningOutputs && staticFrameInteractionActive;
  const allowWheelBoundaryScroll =
    !focused && !shouldScrollPassthroughFrame && !shouldLockWheelBoundary;
  const shouldForwardWheelBoundaryScroll =
    allowWheelBoundaryScroll &&
    !hasWidgets &&
    !hasWheelOwningOutputs &&
    outputs.some(
      (output) =>
        outputNeedsIsolation(output, priority) && !outputAllowsScrollPassthrough(output, priority),
    );
  const showSiftInteractionCue =
    shouldMountIsolatedFrame &&
    hasSiftOutputs &&
    shouldUseScrollPassthroughFrame &&
    !staticFrameInteractionActive;
  const frameFocusAccent = siftFocusAccent(darkMode, colorTheme);
  const interactionFrameStyle = hasWheelOwningOutputs
    ? ({
        "--notebook-sift-focus": frameFocusAccent,
        "--notebook-sift-focus-hover": `${frameFocusAccent}38`,
        boxShadow: staticFrameInteractionActive
          ? `0 0 0 1.5px ${frameFocusAccent}cc, 0 0 0 3px ${frameFocusAccent}14`
          : undefined,
      } as React.CSSProperties)
    : undefined;
  const setIsolatedFrameHandle = useCallback(
    (handle: IsolatedFrameHandle | null) => {
      frameRef.current = handle;
      onIsolatedFrameHandleChange?.(handle);
    },
    [onIsolatedFrameHandleChange],
  );
  const deferredIsolatedFramePlaceholderStyle = shouldDeferIsolatedFrame
    ? {
        minHeight: `${hasSiftOutputs ? MIN_OUTPUT_WELL_HEIGHT : DEFERRED_OUTPUT_PLACEHOLDER_HEIGHT}px`,
      }
    : undefined;

  useEffect(() => {
    if (!shouldUseScrollPassthroughFrame && staticFrameInteractionActive) {
      setStaticFrameInteractionActive(false);
    }
  }, [shouldUseScrollPassthroughFrame, staticFrameInteractionActive]);

  const releaseStaticFrameInteraction = useCallback(() => {
    setStaticFrameInteractionActive(false);
  }, []);

  useEffect(() => {
    if (!hasWheelOwningOutputs) return;
    frameRef.current?.send({
      type: "interaction_state",
      payload: { active: staticFrameInteractionActive },
    });
  }, [hasWheelOwningOutputs, staticFrameInteractionActive]);

  useEffect(() => {
    if (!staticFrameInteractionActive) return;

    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && staticFrameInteractionRef.current?.contains(target)) {
        return;
      }
      releaseStaticFrameInteraction();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [releaseStaticFrameInteraction, staticFrameInteractionActive]);

  const activateStaticFrameInteraction = useCallback(
    ({ alignIntoView = false }: { alignIntoView?: boolean } = {}) => {
      if (shouldUseScrollPassthroughFrame) {
        if (alignIntoView && !staticFrameInteractionActive && hasSiftOutputs) {
          scrollElementIntoComfortableView(staticFrameInteractionRef.current);
        }
        setStaticFrameInteractionActive(true);
        // Move DOM focus off CodeMirror without scrolling; this wrapper owns
        // focus until iframe pointer interaction is active.
        staticFrameInteractionRef.current?.focus({ preventScroll: true });
      }
      onIframeMouseDown?.();
    },
    [
      hasSiftOutputs,
      shouldUseScrollPassthroughFrame,
      staticFrameInteractionActive,
      onIframeMouseDown,
    ],
  );

  const activateStaticFrameInteractionWithAlignment = useCallback(() => {
    activateStaticFrameInteraction({ alignIntoView: true });
  }, [activateStaticFrameInteraction]);

  const activateStaticFrameInteractionTemporarily = useCallback(() => {
    activateStaticFrameInteraction();
  }, [activateStaticFrameInteraction]);

  const handleStaticFrameMouseUp = useCallback(
    ({ hasSelection }: { hasSelection?: boolean }) => {
      if (hasSelection) {
        return;
      }
      if (!hasWheelOwningOutputs) {
        releaseStaticFrameInteraction();
      }
    },
    [hasWheelOwningOutputs, releaseStaticFrameInteraction],
  );

  const handleStaticFrameKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      setStaticFrameInteractionActive(false);
    }
  }, []);

  const setStaticFrameInteractionNode = useCallback(
    (node: HTMLDivElement | null) => {
      staticFrameInteractionRef.current = node;
      deferredIsolatedFrame.targetRef.current = node;
    },
    [deferredIsolatedFrame.targetRef],
  );

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

      if (message.type === "traceback_navigate") {
        onNavigateToTracebackCell?.(message.payload.target);
      }
    },
    [onWidgetUpdate, onSearchMatchCount, onNavigateToTracebackCell],
  );

  // Callback when frame is ready - set up bridge and render outputs
  const handleFrameReady = useCallback(
    async (options: { resetInjectedPlugins?: boolean } = {}) => {
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
      if (options.resetInjectedPlugins) {
        injectedLibsRef.current.clear();
      }

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
              outputId: `${cellId}:plugin-load-error`,
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
      let batch: RenderPayload[];
      try {
        batch = jupyterOutputsToRenderPayloads(requireIdentifiedOutputs(outputs), {
          cellId,
          priority,
        }).map((payload) =>
          withSavedWidgetStateHint(
            withTracebackExecutionTargets(payload, resolveTracebackExecutionTarget),
            widgetContext?.store,
            savedWidgetModels,
          ),
        );
      } catch (error) {
        if (gen !== renderGenRef.current) return;
        console.error("[OutputArea] Failed to build isolated render payloads:", error);
        frameRef.current.renderBatch([
          {
            mimeType: "text/plain",
            data: `Failed to render isolated output: ${formatPluginLoadError(error)}`,
            metadata: { isError: true },
            outputId: `${cellId ?? "unknown-cell"}:output-identity-error`,
            cellId,
            outputIndex: 0,
          },
        ]);
        return;
      }

      frameRef.current.renderBatch(batch);

      // Re-apply search highlights after rendering new content
      if (searchQueryRef.current) {
        frameRef.current?.search(searchQueryRef.current);
      }
    },
    [
      cellId,
      outputs,
      priority,
      resolveTracebackExecutionTarget,
      savedWidgetModels,
      shouldUseBridge,
      widgetContext,
    ],
  );

  const handleIsolatedFrameReady = useCallback(() => {
    void handleFrameReady({ resetInjectedPlugins: true });
  }, [handleFrameReady]);

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

  // Keep the output's own inset here because isolated iframes ignore
  // padding on parent wrappers. CellContainer may add row-level inset
  // outside this component to align the output text with the editor.
  return (
    <div
      data-slot="output-area"
      className={cn(
        "output-area pr-3",
        outputAreaInsetClass(layoutInset),
        isPreloadOnly && "hidden",
        className,
      )}
    >
      {/* Output content */}
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
            ref={setStaticFrameInteractionNode}
            className={cn(
              shouldIsolate ? "relative outline-none transition-shadow" : "hidden",
              hasWheelOwningOutputs && "group/sift rounded-md overflow-hidden",
              hasWheelOwningOutputs &&
                shouldUseScrollPassthroughFrame &&
                !staticFrameInteractionActive &&
                "hover:ring-1 hover:ring-[var(--notebook-sift-focus-hover)]",
              hasWheelOwningOutputs && staticFrameInteractionActive && "bg-background",
            )}
            style={interactionFrameStyle}
            data-frame-interaction-active={staticFrameInteractionActive ? "true" : undefined}
            data-sift-output={hasSiftOutputs ? "true" : undefined}
            tabIndex={shouldUseScrollPassthroughFrame ? -1 : undefined}
            onPointerDown={
              shouldUseScrollPassthroughFrame
                ? activateStaticFrameInteractionTemporarily
                : undefined
            }
            onKeyDown={shouldUseScrollPassthroughFrame ? handleStaticFrameKeyDown : undefined}
          >
            {shouldMountIsolatedFrame ? (
              rendererBundleError ? (
                <OutputErrorFallback error={rendererBundleError} onRetry={rendererBundle.retry} />
              ) : (
                <ErrorBoundary
                  resetKeys={[outputs]}
                  fallback={(error, reset) => <OutputErrorFallback error={error} onRetry={reset} />}
                  onError={(error, errorInfo) => {
                    console.error(
                      "[OutputArea] Error rendering isolated output:",
                      error,
                      errorInfo.componentStack,
                    );
                  }}
                >
                  <IsolatedFrame
                    ref={setIsolatedFrameHandle}
                    name={frameName}
                    darkMode={darkMode}
                    colorTheme={colorTheme}
                    minHeight={24}
                    maxHeight={isolatedOutputWellMaxHeight}
                    autoHeight={shouldIsolate && !focused}
                    allowWheelBoundaryScroll={allowWheelBoundaryScroll}
                    forwardWheelBoundaryScroll={shouldForwardWheelBoundaryScroll}
                    scrollPassthrough={shouldScrollPassthroughFrame}
                    onReady={handleIsolatedFrameReady}
                    onLinkClick={onLinkClick}
                    onMouseDown={activateStaticFrameInteraction}
                    onMouseUp={handleStaticFrameMouseUp}
                    onWidgetUpdate={onWidgetUpdate}
                    onMessage={handleIframeMessage}
                    onError={handleIframeError}
                    onDiagnostic={onDiagnostic}
                    hostContext={hostContext}
                    outputDocumentUrl={hostContext?.nteract?.outputDocumentUrl}
                  />
                </ErrorBoundary>
              )
            ) : (
              <div
                aria-hidden="true"
                className="rounded-md"
                data-slot="isolated-frame-deferred"
                style={deferredIsolatedFramePlaceholderStyle}
              />
            )}
            {showSiftInteractionCue && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-end rounded-b-md pb-[9px] pr-[84px] opacity-0 transition-opacity duration-150 group-hover/sift:opacity-100 group-focus-within/sift:opacity-100">
                <SiftScrollHandoffCue
                  className="pointer-events-auto"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    activateStaticFrameInteractionWithAlignment();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    activateStaticFrameInteractionWithAlignment();
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
              const outputAnchor = cellId
                ? notebookOutputAnchorId(cellId, output.output_id ?? String(index))
                : undefined;
              return (
                <div key={key} id={outputAnchor} data-slot="output-item" data-output-index={index}>
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
                    {renderOutput(
                      output,
                      index,
                      renderers,
                      priority,
                      resolveTracebackExecutionTarget,
                      onNavigateToTracebackCell,
                    )}
                  </ErrorBoundary>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
