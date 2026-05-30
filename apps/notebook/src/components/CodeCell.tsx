import type { EditorView, KeyBinding } from "@codemirror/view";
import { ChevronRight, Code2, EyeOff, Play, Square } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CellContainer } from "@/components/cell/CellContainer";
import { cellOutputInnerInset } from "@/components/cell/cell-layout";
import { OutputArea } from "@/components/cell/OutputArea";
import { CodeMirrorEditor, type CodeMirrorEditorRef } from "@/components/editor/codemirror-editor";
import { languageDisplayNames, type SupportedLanguage } from "@/components/editor/languages";
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
import {
  getCellIdForExecutionId,
  useCellExecutionId,
  useExecution,
} from "../lib/notebook-executions";
import { logNotebookIsolatedDiagnostic } from "../lib/isolated-diagnostics";
import { useCellOutputs } from "../lib/notebook-outputs";
import { openUrl } from "../lib/open-url";
import { presenceSenderExtension } from "../lib/presence-sender";
import { tabCompletionKeymap } from "../lib/tab-completion";
import type { CodeCell as CodeCellType, JupyterOutput } from "../types";
import { CellPresenceIndicators } from "./cell/CellPresenceIndicators";
import { HistorySearchDialog } from "./HistorySearchDialog";

const SIMPLE_OUTPUT_MAX_CHARS = 2000;
const SIMPLE_OUTPUT_MAX_LINES = 24;
const SIMPLE_OUTPUT_MAX_LINE_CHARS = 180;

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
  onNavigateToCell?: (cellId: string) => void;
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

function normalizeOutputText(text: string | string[]): string {
  return Array.isArray(text) ? text.join("") : text;
}

function simpleOutputText(output: JupyterOutput): string | null {
  if (output.output_type === "stream") {
    return normalizeOutputText(output.text);
  }

  if (output.output_type !== "execute_result" && output.output_type !== "display_data") {
    return null;
  }

  const populatedMimeTypes = Object.entries(output.data).filter(([, value]) => value != null);
  if (populatedMimeTypes.length !== 1) {
    return null;
  }

  const [mimeType, value] = populatedMimeTypes[0]!;
  if (mimeType !== "text/plain" || (typeof value !== "string" && !Array.isArray(value))) {
    return null;
  }

  return normalizeOutputText(value as string | string[]);
}

function needsOutputChrome(outputs: readonly JupyterOutput[]): boolean {
  let totalChars = 0;
  let totalLines = 0;

  for (const output of outputs) {
    const text = simpleOutputText(output);
    if (text == null) return true;

    totalChars += text.length;
    const lines = text.split(/\r\n|\r|\n/);
    totalLines += lines.length;

    if (lines.some((line) => line.length > SIMPLE_OUTPUT_MAX_LINE_CHARS)) {
      return true;
    }
  }

  return totalChars > SIMPLE_OUTPUT_MAX_CHARS || totalLines > SIMPLE_OUTPUT_MAX_LINES;
}

function formatExecutionCount(count: number): string {
  return count > 999 ? "999+" : String(count);
}

function executionPhrase({
  count,
  isExecuting,
  isQueued,
  languageLabel,
}: {
  count: number | null;
  isExecuting: boolean;
  isQueued: boolean;
  languageLabel: string;
}): string {
  if (isExecuting) return `Running in ${languageLabel}`;
  if (isQueued) return `Queued to run in ${languageLabel}`;
  if (count !== null) return `Completed in ${languageLabel}`;
  return `Ready to run in ${languageLabel}`;
}

function visibleExecutionCountLabel(count: number | null): string | null {
  return count === null ? null : `run ${formatExecutionCount(count)}`;
}

function executionCountLabel(count: number | null): string | null {
  return count === null ? null : `Execution ${formatExecutionCount(count)}`;
}

function executionLineClass({
  isExecuting,
  isQueued,
  isFocused,
}: {
  isExecuting: boolean;
  isQueued: boolean;
  isFocused: boolean;
}) {
  if (isExecuting) {
    return "bg-destructive/35";
  }

  if (isQueued) {
    return "bg-sky-400/35";
  }

  if (isFocused) {
    return "bg-border/70";
  }

  return "bg-transparent group-hover:bg-border/45";
}

function CodeCellCurrentLine({
  language,
  count,
  isExecuting,
  isQueued,
  isFocused,
  submittedByActorLabel,
  onExecute,
  onInterrupt,
}: {
  language: SupportedLanguage;
  count: number | null;
  isExecuting: boolean;
  isQueued: boolean;
  isFocused: boolean;
  submittedByActorLabel: string | null;
  onExecute: () => void;
  onInterrupt: () => void;
}) {
  const languageLabel =
    language === "ipython" ? "Python" : (languageDisplayNames[language] ?? "Code");
  const state = isExecuting ? "running" : isQueued ? "queued" : count !== null ? "ran" : "idle";
  const statusLabel = executionPhrase({ count, isExecuting, isQueued, languageLabel });
  const countLabel = executionCountLabel(count);
  const visibleCountLabel = visibleExecutionCountLabel(count);
  const actionTitle = isExecuting
    ? submittedByActorLabel
      ? `Stop execution submitted by ${submittedByActorLabel}`
      : "Stop execution"
    : isQueued
      ? submittedByActorLabel
        ? `Queued for execution by ${submittedByActorLabel}`
        : "Queued for execution"
      : count !== null
        ? `Run cell again; last execution ${count}`
        : "Run cell";

  const handleClick = () => {
    if (isQueued) return;
    if (isExecuting) {
      onInterrupt();
    } else {
      onExecute();
    }
  };

  return (
    <div
      data-slot="code-cell-current-line"
      data-execution-state={state}
      data-execution-count={count ?? undefined}
      data-execution-label={countLabel ?? undefined}
      className="mt-2 flex min-h-6 items-center gap-2 text-[11px] leading-none text-muted-foreground/65"
    >
      <button
        type="button"
        onClick={handleClick}
        disabled={isQueued}
        title={actionTitle}
        aria-label={actionTitle}
        aria-busy={isExecuting || undefined}
        data-testid="execute-button"
        data-execution-state={state}
        data-execution-count={count ?? undefined}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
          "transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
          !isFocused && state === "idle" && "opacity-55 group-hover:opacity-100",
          state === "idle" && "hover:bg-muted hover:text-foreground",
          state === "ran" && "hover:bg-primary/5 hover:text-primary",
          state === "queued" && "cursor-default text-sky-600 dark:text-sky-400",
          state === "running" && "text-destructive hover:bg-destructive/10",
        )}
      >
        {isExecuting ? (
          <Square className="size-3 fill-current animate-exec-squish" aria-hidden="true" />
        ) : isQueued ? (
          <span
            className="block size-1.5 rounded-full bg-current animate-queue-breathe"
            aria-hidden="true"
          />
        ) : (
          <Play className="size-3 fill-current" aria-hidden="true" />
        )}
      </button>
      <span
        className={cn(
          "shrink-0 font-medium transition-colors duration-150",
          isFocused && "text-foreground/70",
          isExecuting && "text-destructive/80",
          isQueued && "text-sky-700 dark:text-sky-300",
        )}
      >
        {statusLabel}
      </span>
      {visibleCountLabel && (
        <>
          <span className="shrink-0 text-muted-foreground/35" aria-hidden="true">
            ·
          </span>
          <span
            className={cn(
              "shrink-0 tabular-nums transition-colors duration-150",
              isFocused && "text-foreground/75",
              isExecuting && "text-destructive/80",
              isQueued && "text-sky-700 dark:text-sky-300",
            )}
          >
            {visibleCountLabel}
          </span>
        </>
      )}
      <div
        className={cn(
          "h-px min-w-6 flex-1 rounded-full transition-colors duration-150",
          executionLineClass({ isExecuting, isQueued, isFocused }),
        )}
      />
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
  onNavigateToCell,
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
  const presence = usePresenceContext();
  const { extension: crdtBridgeExt, bridge } = useCrdtBridge(cell.id);
  // Subscribe to outputs via the per-execution / per-output stores rather
  // than `cell.outputs`. Content changes no longer invalidate the cell
  // snapshot — CodeCell re-renders only when its chrome state changes.
  const outputs = useCellOutputs(cell.id);
  const executionId = useCellExecutionId(cell.id);
  const execution = useExecution(executionId);
  const executionCount = execution?.execution_count ?? null;
  const submittedByActorLabel = execution?.submitted_by_actor_label ?? null;
  const showOutputChrome = useMemo(() => needsOutputChrome(outputs), [outputs]);

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
    if (isOutputsHidden || outputs.length === 0 || !showOutputChrome) {
      if (outputFocused) {
        onOutputFocusChange?.(false);
      }
    }
  }, [isOutputsHidden, onOutputFocusChange, outputFocused, outputs.length, showOutputChrome]);

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

  // Ctrl+R opens history search seeded from the active editor line.
  const historyKeyBinding: KeyBinding = useMemo(
    () => ({
      key: "Ctrl-r",
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
  const resolveTracebackExecutionTarget = useCallback((executionId: string) => {
    const cellId = getCellIdForExecutionId(executionId);
    return cellId ? { cellId } : null;
  }, []);
  const handleTracebackCellNavigate = useCallback(
    (target: { cellId: string }) => {
      onNavigateToCell?.(target.cellId);
    },
    [onNavigateToCell],
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
              <>
                <CodeMirrorEditor
                  ref={editorRef}
                  initialValue={cell.source}
                  language={language}
                  keyMap={keyMap}
                  extensions={editorExtensions}
                  placeholder="Enter code..."
                  autoFocus={isFocused}
                />
                <CodeCellCurrentLine
                  language={language}
                  count={executionCount}
                  isExecuting={isExecuting}
                  isQueued={isQueued}
                  isFocused={isFocused}
                  submittedByActorLabel={submittedByActorLabel}
                  onExecute={onExecute}
                  onInterrupt={onInterrupt}
                />
              </>
            )}
          </>
        }
        outputContent={
          isOutputsHidden && outputs.length > 0 ? (
            <div className={cn("flex items-center justify-start mt-0.5", cellOutputInnerInset)}>
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
              executionCount={executionCount}
              preloadIframe
              searchQuery={searchQuery}
              onSearchMatchCount={onSearchMatchCount}
              onLinkClick={handleLinkClick}
              onIframeMouseDown={handleOutputMouseDown}
              onDiagnostic={logNotebookIsolatedDiagnostic}
              layoutInset="cell-output"
              resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
              onNavigateToTracebackCell={handleTracebackCellNavigate}
              focused={outputFocused}
              useOutputWell={showOutputChrome}
            />
          )
        }
        outputRightGutterContent={
          outputs.length > 0 && !isOutputsHidden && onToggleOutputsHidden ? (
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onToggleOutputsHidden(true)}
              className="flex items-center justify-center rounded p-1 text-muted-foreground/40 transition-colors hover:text-foreground"
              title="Hide outputs"
            >
              <EyeOff className="h-3.5 w-3.5" />
            </button>
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
