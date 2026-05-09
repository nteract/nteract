import type { EditorView, KeyBinding } from "@codemirror/view";
import { ChevronRight, Code2, EyeOff, Maximize2, Square, SquareMousePointer } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CellContainer } from "@/components/cell/CellContainer";
import { CompactExecutionButton } from "@/components/cell/CompactExecutionButton";
import { OutputArea } from "@/components/cell/OutputArea";
import { CodeMirrorEditor, type CodeMirrorEditorRef } from "@/components/editor/codemirror-editor";
import type { SupportedLanguage } from "@/components/editor/languages";
import { remoteCursorsExtension } from "@/components/editor/remote-cursors";
import { searchHighlight } from "@/components/editor/search-highlight";
import { textAttributionExtension } from "@/components/editor/text-attribution";
import { cn } from "@/lib/utils";
import { usePresenceContext } from "../contexts/PresenceContext";
import { useCellKeyboardNavigation } from "../hooks/useCellKeyboardNavigation";
import { useCrdtBridge } from "../hooks/useCrdtBridge";
import {
  useIsCellExecuting,
  useIsCellFocused,
  useIsCellQueued,
  useIsGroupExecuting,
  useIsNextCellFromFocused,
  useIsPreviousCellFromFocused,
  useSearchActiveOffset,
  useSearchQuery,
} from "../lib/cell-ui-state";
import { onEditorRegistered, onEditorUnregistered } from "../lib/cursor-registry";
import { registerCellEditor, unregisterCellEditor } from "../lib/editor-registry";
import { kernelCompletionExtension } from "../lib/kernel-completion";
import { useCellExecutionId, useExecution } from "../lib/notebook-executions";
import { useCellOutputs } from "../lib/notebook-outputs";
import { openUrl } from "../lib/open-url";
import { presenceSenderExtension } from "../lib/presence-sender";
import { tabCompletionKeymap } from "../lib/tab-completion";
import type { CodeCell as CodeCellType } from "../types";
import { CellPresenceIndicators } from "./cell/CellPresenceIndicators";
import { HistorySearchDialog } from "./HistorySearchDialog";

interface CodeCellProps {
  cell: CodeCellType;
  language?: SupportedLanguage;
  onSearchMatchCount?: (count: number) => void;
  onFocus: () => void;
  outputFocused?: boolean;
  outputDimmed?: boolean;
  onOutputFocusChange?: (focused: boolean) => void;
  onExecute: () => void;
  onInterrupt: () => void;
  onDelete: () => void;
  onFocusPrevious?: (cursorPosition: "start" | "end") => void;
  onFocusNext?: (cursorPosition: "start" | "end") => void;
  onInsertCellAfter?: () => void;
  isLastCell?: boolean;
  /** Props for dnd-kit drag handle (applied to ribbon) */
  dragHandleProps?: Record<string, unknown>;
  /** Whether this cell is currently being dragged */
  isDragging?: boolean;
  /** Callback to toggle source visibility (JupyterLab convention) */
  onToggleSourceHidden?: (hidden: boolean) => void;
  /** Callback to toggle outputs visibility (JupyterLab convention) */
  onToggleOutputsHidden?: (hidden: boolean) => void;
  /** Number of consecutive fully-hidden cells in this group (including this one) */
  hiddenGroupCount?: number;
  /** Callback to expand all cells in a hidden group */
  onExpandHiddenGroup?: () => void;
  /** Cell IDs in this hidden group (for executing indicator) */
  hiddenGroupCellIds?: string[];
  /** Number of error outputs across all cells in a hidden group */
  hiddenGroupErrorCount?: number;
  /** Content for the right gutter (e.g., delete button, source toggle) */
  rightGutterContent?: ReactNode;
}

type OutputMode = "compact" | "expanded" | "focused";

interface OutputModeStripProps {
  mode: OutputMode;
  onChange: (mode: OutputMode) => void;
}

function historyQueryFromEditor(view: EditorView | null, fallbackSource: string): string {
  if (view) {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const linePrefix = line.text.slice(0, head - line.from).trim();
    if (linePrefix) {
      return linePrefix;
    }
  }

  return fallbackSource.trim();
}

/**
 * Three-segment mode selector for an iframe output: compact, expanded,
 * focused. Mutually exclusive states grouped on a shared rail so the
 * "this is one piece of state" intent reads visually. Single click jumps
 * to any mode regardless of current.
 */
function OutputModeStrip({ mode, onChange }: OutputModeStripProps) {
  const segments: Array<{ value: OutputMode; title: string; Icon: typeof Square }> = [
    { value: "compact", title: "Compact (default)", Icon: Square },
    { value: "expanded", title: "Expand inline", Icon: Maximize2 },
    { value: "focused", title: "Focus output", Icon: SquareMousePointer },
  ];
  return (
    <div
      role="group"
      aria-label="Output mode"
      className="flex flex-col items-center gap-0.5 rounded-md bg-muted/40 p-0.5"
    >
      {segments.map(({ value, title, Icon }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            tabIndex={-1}
            aria-pressed={active}
            onClick={() => onChange(value)}
            className={cn(
              "flex items-center justify-center rounded p-1 transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground/50 hover:text-foreground",
            )}
            title={title}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}

export const CodeCell = memo(function CodeCell({
  cell,
  language = "python",
  onSearchMatchCount,
  onFocus,
  outputFocused = false,
  outputDimmed = false,
  onOutputFocusChange,
  onExecute,
  onInterrupt,
  onDelete,
  onFocusPrevious,
  onFocusNext,
  onInsertCellAfter,
  isLastCell = false,
  dragHandleProps,
  isDragging,
  onToggleSourceHidden,
  onToggleOutputsHidden,
  hiddenGroupCount,
  onExpandHiddenGroup,
  hiddenGroupCellIds,
  hiddenGroupErrorCount,
  rightGutterContent,
}: CodeCellProps) {
  // Read transient UI state from the store
  const isFocused = useIsCellFocused(cell.id);
  const isExecuting = useIsCellExecuting(cell.id);
  const isQueued = useIsCellQueued(cell.id);
  const isPreviousCellFromFocused = useIsPreviousCellFromFocused(cell.id);
  const isNextCellFromFocused = useIsNextCellFromFocused(cell.id);
  const searchQuery = useSearchQuery();
  const searchActiveOffset = useSearchActiveOffset(cell.id);
  const isGroupExecuting = useIsGroupExecuting(hiddenGroupCellIds);
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyInitialQuery, setHistoryInitialQuery] = useState("");
  const [isIframeOutputExpanded, setIsIframeOutputExpanded] = useState(false);
  const presence = usePresenceContext();
  const { extension: crdtBridgeExt, bridge } = useCrdtBridge(cell.id);
  // Subscribe to outputs via the per-execution / per-output stores rather
  // than `cell.outputs`. Content changes no longer invalidate the cell
  // snapshot — CodeCell re-renders only when its chrome state changes.
  const outputs = useCellOutputs(cell.id);
  const executionId = useCellExecutionId(cell.id);
  const execution = useExecution(executionId);
  const executionCount = execution?.execution_count ?? null;

  // Check cell metadata for visibility (JupyterLab convention)
  const isSourceHidden =
    (cell.metadata?.jupyter as { source_hidden?: boolean })?.source_hidden === true;
  const isOutputsHidden =
    (cell.metadata?.jupyter as { outputs_hidden?: boolean })?.outputs_hidden === true;

  // Fully collapsed when source is hidden AND there's nothing else to show
  // (outputs explicitly hidden, or no outputs at all).
  const bothHidden = isSourceHidden && (isOutputsHidden || outputs.length === 0);

  // Auto-clear expand/focus when the cell has no visible outputs to
  // operate on. Previously also gated on `!hasIsolatedOutput`, which made
  // sense when the mode strip was iframe-only; now that stream outputs
  // share the strip, that gate stomped on focus the moment it engaged
  // for any non-iframe output.
  useEffect(() => {
    if (isOutputsHidden || outputs.length === 0) {
      setIsIframeOutputExpanded(false);
      if (outputFocused) {
        onOutputFocusChange?.(false);
      }
    }
  }, [isOutputsHidden, onOutputFocusChange, outputFocused, outputs.length]);

  // Register EditorView with the cursor registry for remote cursor rendering.
  // We use a ref + polling approach because the EditorView is created async
  // by CodeMirrorEditor and isn't available on first render.
  const registeredViewRef = useRef<EditorView | null>(null);
  useEffect(() => {
    const tryRegister = () => {
      const view = editorRef.current?.getEditor() ?? null;
      if (view && view !== registeredViewRef.current) {
        registeredViewRef.current = view;
        registerCellEditor(cell.id, view);
        onEditorRegistered(cell.id);
        return true;
      }
      return false;
    };

    if (!tryRegister()) {
      let attempts = 0;
      const intervalId = window.setInterval(() => {
        attempts += 1;
        if (tryRegister() || attempts >= 40) {
          clearInterval(intervalId);
        }
      }, 50);

      return () => {
        clearInterval(intervalId);
        if (registeredViewRef.current) {
          onEditorUnregistered(cell.id);
          unregisterCellEditor(cell.id);
          registeredViewRef.current = null;
        }
      };
    }

    return () => {
      if (registeredViewRef.current) {
        onEditorUnregistered(cell.id);
        unregisterCellEditor(cell.id);
        registeredViewRef.current = null;
      }
    };
  }, [cell.id]);

  // Handle focus next, creating a new cell if at the end
  const handleFocusNextOrCreate = useCallback(
    (cursorPosition: "start" | "end") => {
      if (isLastCell && onInsertCellAfter) {
        onInsertCellAfter();
      } else if (onFocusNext) {
        onFocusNext(cursorPosition);
      }
    },
    [isLastCell, onFocusNext, onInsertCellAfter],
  );

  // Get keyboard navigation bindings
  const navigationKeyMap = useCellKeyboardNavigation({
    onFocusPrevious: onFocusPrevious ?? (() => {}),
    onFocusNext: handleFocusNextOrCreate,
    onExecute: onExecute,
    onExecuteAndInsert: onInsertCellAfter
      ? () => {
          onExecute();
          onInsertCellAfter();
        }
      : undefined,
    onDelete,
    cellId: cell.id,
  });

  // Cmd/Ctrl+R to open history search seeded from the active editor line.
  const historyKeyBinding: KeyBinding = useMemo(
    () => ({
      key: "Mod-r",
      run: () => {
        setHistoryInitialQuery(
          historyQueryFromEditor(editorRef.current?.getEditor() ?? null, cell.source),
        );
        setHistoryDialogOpen(true);
        return true;
      },
    }),
    [cell.source],
  );

  // Handle history selection - replace cell content via CRDT bridge
  const handleHistorySelect = useCallback(
    (source: string) => {
      bridge.replaceSource(source);
    },
    [bridge],
  );

  // Merge navigation keybindings (navigation bindings take precedence for Shift-Enter)
  const keyMap: KeyBinding[] = useMemo(
    () => [...navigationKeyMap, historyKeyBinding],
    [navigationKeyMap, historyKeyBinding],
  );

  // Remote cursors extension (stable — no deps that change)
  const remoteCursorsExt = useMemo(() => remoteCursorsExtension(), []);

  // Text attribution extension (stable — no deps that change)
  const textAttributionExt = useMemo(() => textAttributionExtension(), []);

  // Presence sender extension — broadcasts local cursor/selection to other peers
  const presenceSenderExt = useMemo(() => {
    if (!presence) return [];
    return [
      presenceSenderExtension(cell.id, {
        onCursor: presence.setCursor,
        onSelection: presence.setSelection,
      }),
    ];
  }, [cell.id, presence]);

  // CodeMirror extensions: CRDT bridge + kernel completion + tab completion + search highlighting + remote cursors + presence sender
  const editorExtensions = useMemo(
    () => [
      crdtBridgeExt,
      kernelCompletionExtension,
      tabCompletionKeymap,
      ...searchHighlight(searchQuery || "", searchActiveOffset),
      ...remoteCursorsExt,
      ...textAttributionExt,
      ...presenceSenderExt,
    ],
    [
      crdtBridgeExt,
      searchQuery,
      searchActiveOffset,
      remoteCursorsExt,
      textAttributionExt,
      presenceSenderExt,
    ],
  );

  const handleLinkClick = useCallback((url: string) => openUrl(url), []);
  const handleOutputMouseDown = useCallback(() => {
    editorRef.current?.getEditor()?.contentDOM.blur();
    onFocus();
  }, [onFocus]);

  const gutterContent = bothHidden ? null : (
    <CompactExecutionButton
      count={executionCount}
      isExecuting={isExecuting}
      isQueued={isQueued}
      onExecute={onExecute}
      onInterrupt={onInterrupt}
    />
  );

  return (
    <>
      <CellContainer
        id={cell.id}
        cellType="code"
        isFocused={isFocused}
        isPreviousCellFromFocused={isPreviousCellFromFocused}
        isNextCellFromFocused={isNextCellFromFocused}
        outputFocused={outputFocused}
        outputDimmed={outputDimmed}
        onFocus={onFocus}
        gutterContent={gutterContent}
        rightGutterContent={rightGutterContent}
        presenceIndicators={<CellPresenceIndicators cellId={cell.id} />}
        dragHandleProps={dragHandleProps}
        isDragging={isDragging}
        codeContent={
          <>
            {/* Source visibility toggle + Editor */}
            {bothHidden ? (
              <div className="flex items-center justify-start mt-0.5">
                <button
                  type="button"
                  onClick={() => {
                    if (onExpandHiddenGroup) {
                      onExpandHiddenGroup();
                    } else {
                      onToggleSourceHidden?.(false);
                      onToggleOutputsHidden?.(false);
                    }
                  }}
                  className={cn(
                    "inline-flex items-center gap-1 px-2 py-0.5 text-sm text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded transition-colors",
                    (isExecuting || isGroupExecuting) && "animate-pulse",
                  )}
                  title={
                    hiddenGroupCount && hiddenGroupCount > 1
                      ? `Show ${hiddenGroupCount} cells`
                      : "Show cell"
                  }
                >
                  <span>
                    {hiddenGroupCount && hiddenGroupCount > 1
                      ? `${hiddenGroupCount} cells hidden`
                      : "Cell hidden"}
                  </span>
                  {hiddenGroupErrorCount ? (
                    <span className="text-destructive font-medium">
                      {hiddenGroupErrorCount === 1 ? "1 error" : `${hiddenGroupErrorCount} errors`}
                    </span>
                  ) : null}
                  <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            ) : isSourceHidden ? (
              <div className="flex items-center justify-start mt-0.5">
                <button
                  type="button"
                  onClick={() => onToggleSourceHidden?.(false)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-sm font-mono text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded transition-colors"
                  title="Show source"
                >
                  <Code2 className="h-3 w-3" />
                  <span className="font-mono truncate max-w-48">
                    {cell.source.split("\n")[0] || "source"}
                  </span>
                  <ChevronRight className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <CodeMirrorEditor
                ref={editorRef}
                initialValue={cell.source}
                language={language}
                keyMap={keyMap}
                extensions={editorExtensions}
                placeholder="Enter code..."
                autoFocus={isFocused}
              />
            )}
          </>
        }
        outputContent={
          isOutputsHidden && outputs.length > 0 ? (
            <div className="flex items-center justify-start mt-0.5 pl-6">
              <button
                type="button"
                onClick={() => onToggleOutputsHidden?.(false)}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-sm text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded transition-colors"
                title="Show outputs"
              >
                <span>
                  {outputs.length} output
                  {outputs.length !== 1 ? "s" : ""}
                </span>
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <OutputArea
              outputs={outputs}
              cellId={cell.id}
              preloadIframe
              searchQuery={searchQuery}
              onSearchMatchCount={onSearchMatchCount}
              onLinkClick={handleLinkClick}
              onIframeMouseDown={handleOutputMouseDown}
              expandIframeOutputs={isIframeOutputExpanded}
              focused={outputFocused}
            />
          )
        }
        outputRightGutterContent={
          outputs.length > 0 && !isOutputsHidden ? (
            <>
              <OutputModeStrip
                mode={outputFocused ? "focused" : isIframeOutputExpanded ? "expanded" : "compact"}
                onChange={(next) => {
                  if (next === "focused") {
                    setIsIframeOutputExpanded(false);
                    onOutputFocusChange?.(true);
                  } else {
                    setIsIframeOutputExpanded(next === "expanded");
                    if (outputFocused) onOutputFocusChange?.(false);
                  }
                  onFocus();
                }}
              />
              {onToggleOutputsHidden && (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => onToggleOutputsHidden(true)}
                  className="flex items-center justify-center rounded p-1 text-muted-foreground/40 transition-colors hover:text-foreground"
                  title="Hide outputs"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                </button>
              )}
            </>
          ) : undefined
        }
        hideOutput={outputs.length === 0 || bothHidden}
      />

      {/* History Search Dialog (Ctrl+R) */}
      {historyDialogOpen && (
        <HistorySearchDialog
          open={historyDialogOpen}
          onOpenChange={setHistoryDialogOpen}
          onSelect={handleHistorySelect}
          initialQuery={historyInitialQuery}
        />
      )}
    </>
  );
});
