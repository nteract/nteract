"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { WidgetView } from "@/components/widgets/widget-view";
import { useWidgetStore } from "@/components/widgets/widget-store-context";
import { parseWidgetViewModelId, WIDGET_VIEW_MIME } from "@/components/widgets/widget-state";
import {
  anyOutputNeedsIsolation,
  hasWidgetOutputs,
  isScrollPassthroughMimeType,
  isSiftMimeType,
  outputAllowsScrollPassthrough,
  outputNeedsIsolation,
  outputSegmentLane,
  outputUsesSift,
  outputUsesVega,
  outputUsesWheelOwningFrame,
  outputUsesWidget,
  segmentedOutputLanes,
  selectedOutputMimeType,
  splitOutputSegments,
  type OutputLane,
  type OutputSegment,
  type OutputSegmentationOptions,
} from "../../../../src/components/isolated/output-lane-policy";
import type {
  IframeToParentMessage,
  ParentToIframeMessage,
  RenderPayload,
} from "../../../../src/components/isolated/frame-bridge";
import type { IsolatedDiagnosticHandler } from "../../../../src/components/isolated/diagnostics";
import type { NteractEmbedHostContextPatch } from "../../../../src/components/isolated/host-context";
import type { NteractMeasureElementResult } from "../../../../src/components/isolated/rpc-methods";

export {
  anyOutputNeedsIsolation,
  hasWidgetOutputs,
  isScrollPassthroughMimeType,
  isSiftMimeType,
  outputAllowsScrollPassthrough,
  outputNeedsIsolation,
  outputSegmentLane,
  outputUsesSift,
  outputUsesVega,
  outputUsesWheelOwningFrame,
  outputUsesWidget,
  segmentedOutputLanes,
  selectedOutputMimeType,
  splitOutputSegments,
};
export type {
  IframeToParentMessage,
  IsolatedDiagnosticHandler,
  OutputLane,
  OutputSegment,
  OutputSegmentationOptions,
  RenderPayload,
};

export interface IsolatedFrameProps {
  id?: string;
  name?: string;
  initialContent?: RenderPayload;
  darkMode?: boolean;
  colorTheme?: string;
  hostContext?: NteractEmbedHostContextPatch;
  outputDocumentUrl?: string | null;
  minHeight?: number;
  maxHeight?: number;
  autoHeight?: boolean;
  className?: string;
  allowWheelBoundaryScroll?: boolean;
  scrollPassthrough?: boolean;
  revealOnRender?: boolean;
  onReady?: () => void;
  onResize?: (height: number) => void;
  onLinkClick?: (url: string, newTab: boolean) => void;
  onMouseDown?: () => void;
  onMouseUp?: (params: { hasSelection?: boolean }) => void;
  onDoubleClick?: () => void;
  onWidgetUpdate?: (commId: string, state: Record<string, unknown>) => void;
  onError?: (error: { message: string; stack?: string }) => void;
  onMessage?: (message: IframeToParentMessage) => void;
  onDiagnostic?: IsolatedDiagnosticHandler;
}

export interface IsolatedFrameHandle {
  send: (message: ParentToIframeMessage) => void;
  render: (payload: RenderPayload) => void;
  renderBatch: (outputs: RenderPayload[]) => void;
  eval: (code: string) => void;
  installRenderer: (code: string, css?: string) => void;
  setTheme: (isDark: boolean, colorTheme?: string | null) => void;
  setHostContext: (hostContext: NteractEmbedHostContextPatch) => void;
  clear: () => void;
  search: (query: string, caseSensitive?: boolean) => void;
  searchNavigate: (matchIndex: number) => void;
  measureElement: (anchorId: string) => Promise<NteractMeasureElementResult | null>;
  isReady: boolean;
  isIframeReady: boolean;
}

export class CommBridgeManager {
  constructor(_options: unknown) {}

  handleIframeMessage(_message: IframeToParentMessage): void {}

  dispose(): void {}
}

export function createCommBridgeManager(options: unknown): CommBridgeManager {
  return new CommBridgeManager(options);
}

function stringifyPayloadData(data: unknown): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return data.map(stringifyPayloadData).join("");
  if (data == null) return "";
  return JSON.stringify(data, null, 2);
}

function outputLabel(payload: RenderPayload): string {
  if (payload.mimeType === WIDGET_VIEW_MIME) return "widget view adapter";
  if (payload.mimeType === "text/markdown") return "markdown preview adapter";
  if (payload.mimeType === "text/plain") return "text output adapter";
  return payload.mimeType;
}

function WidgetPayloadPreview({ payload }: { payload: RenderPayload }) {
  const widgetContext = useWidgetStore();
  const modelId = parseWidgetViewModelId(payload.data);

  if (!modelId || widgetContext === null) {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-fd-foreground">
        {stringifyPayloadData(payload.data)}
      </pre>
    );
  }

  return (
    <div
      className="rounded-md border border-fd-border bg-fd-background p-3"
      data-elements-widget-frame-adapter="true"
      data-widget-model-id={modelId}
    >
      <WidgetView modelId={modelId} />
    </div>
  );
}

function PayloadPreview({ payload }: { payload: RenderPayload }) {
  if (payload.mimeType === WIDGET_VIEW_MIME) {
    return <WidgetPayloadPreview payload={payload} />;
  }

  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-fd-foreground">
      {stringifyPayloadData(payload.data)}
    </pre>
  );
}

export const IsolatedFrame = forwardRef<IsolatedFrameHandle, IsolatedFrameProps>(
  function IsolatedFrame(
    {
      id,
      name,
      initialContent,
      darkMode = false,
      minHeight = 24,
      maxHeight,
      autoHeight = false,
      className,
      onReady,
      onResize,
      onMouseDown,
      onMouseUp,
      onDoubleClick,
    },
    ref,
  ) {
    const [outputs, setOutputs] = useState<RenderPayload[]>(() =>
      initialContent ? [initialContent] : [],
    );
    const [theme, setThemeState] = useState(darkMode ? "dark" : "light");
    const [hostContext, setHostContextState] = useState<NteractEmbedHostContextPatch>({});
    const onReadyRef = useRef(onReady);
    const onResizeRef = useRef(onResize);
    const handleMouseUp = useCallback(
      (event: ReactMouseEvent<HTMLDivElement>) => {
        if (!onMouseUp) return;

        const selection = event.currentTarget.ownerDocument.getSelection();
        onMouseUp({
          hasSelection: !!selection && !selection.isCollapsed && selection.toString().length > 0,
        });
      },
      [onMouseUp],
    );

    useEffect(() => {
      onReadyRef.current = onReady;
      onResizeRef.current = onResize;
    }, [onReady, onResize]);

    useEffect(() => {
      onReadyRef.current?.();
    }, []);

    useEffect(() => {
      onResizeRef.current?.(Math.max(minHeight, outputs.length * 72));
    }, [minHeight, outputs.length]);

    useImperativeHandle(
      ref,
      () => ({
        send: () => {},
        render: (payload) =>
          setOutputs(payload.replace ? [payload] : (current) => [...current, payload]),
        renderBatch: (nextOutputs) => setOutputs(nextOutputs),
        eval: () => {},
        installRenderer: () => {},
        setTheme: (isDark) => setThemeState(isDark ? "dark" : "light"),
        setHostContext: (nextHostContext) =>
          setHostContextState((current) => ({ ...current, ...nextHostContext })),
        clear: () => setOutputs([]),
        search: () => {},
        searchNavigate: () => {},
        measureElement: async () => ({ found: false }),
        isReady: true,
        isIframeReady: true,
      }),
      [],
    );

    const frameStyle = useMemo<CSSProperties>(
      () => ({
        minHeight,
        maxHeight: autoHeight ? undefined : maxHeight,
      }),
      [autoHeight, maxHeight, minHeight],
    );

    return (
      <div
        id={id}
        data-elements-isolated-adapter="true"
        data-elements-frame-name={name}
        data-elements-frame-theme={theme}
        data-elements-host-context={hostContext.nteract?.colorTheme ?? undefined}
        className={className}
        style={frameStyle}
        onMouseDown={onMouseDown}
        onMouseUp={handleMouseUp}
        onDoubleClick={onDoubleClick}
      >
        {outputs.map((payload) => (
          <div
            key={payload.outputId}
            className="rounded-md border border-fd-border bg-fd-muted/30 p-3 text-sm"
          >
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-fd-muted-foreground">
              {outputLabel(payload)}
            </div>
            <PayloadPreview payload={payload} />
          </div>
        ))}
      </div>
    );
  },
);
