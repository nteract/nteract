import type { EditorView, KeyBinding } from "@codemirror/view";
import { ChevronRight, Code2, Eye, EyeOff, type LucideIcon } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CellContainer } from "@/components/cell/CellContainer";
import { cellOutputInnerInset } from "@/components/cell/cell-layout";
import { CompactExecutionButton } from "@/components/cell/CompactExecutionButton";
import { CodeCellCurrentLine } from "@/components/cell/CodeCellCurrentLine";
import { OutputArea } from "@/components/cell/OutputArea";
import { CodeMirrorEditor, type CodeMirrorEditorRef } from "@/components/editor/codemirror-editor";
import { languageDisplayNames, type SupportedLanguage } from "@/components/editor/languages";
import { remoteCursorsExtension } from "@/components/editor/remote-cursors";
import { searchHighlight } from "@/components/editor/search-highlight";
import { textAttributionExtension } from "@/components/editor/text-attribution";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { cn } from "@/lib/utils";
import { usePresenceContext } from "../contexts/PresenceContext";
import { useCellKeyboardNavigation } from "../hooks/useCellKeyboardNavigation";
import { useCrdtBridge } from "../hooks/useCrdtBridge";
import {
  useCellQueuePriority,
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
  onDelete?: () => void;
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
  readOnly?: boolean;
  canExecute?: boolean;
  outputHostContext?: NteractEmbedHostContextPatch;
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

interface HiddenCellDisclosureProps {
  icon: LucideIcon;
  label: string;
  detail?: string;
  alert?: string;
  disabled?: boolean;
  pulsing?: boolean;
  onClick: () => void;
  title: string;
  className?: string;
}

function HiddenCellDisclosure({
  icon: Icon,
  label,
  detail,
  alert,
  disabled,
  pulsing,
  onClick,
  title,
  className,
}: HiddenCellDisclosureProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group/reveal flex w-full min-w-0 items-center gap-2 py-1 text-left text-xs leading-none",
        "text-muted-foreground/70 transition-colors hover:text-foreground",
        disabled && "cursor-default hover:text-muted-foreground/70",
        pulsing && "animate-pulse",
        className,
      )}
      title={title}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/45 transition-colors group-hover/reveal:text-muted-foreground/70">
        <Icon className="size-3.5" />
      </span>
      <span className="shrink-0 font-medium">{label}</span>
      {detail ? (
        <span className="min-w-0 truncate font-mono text-muted-foreground/55 transition-colors group-hover/reveal:text-muted-foreground/70">
          {detail}
        </span>
      ) : null}
      <span
        className="h-px min-w-4 flex-1 rounded-full bg-border/15 transition-colors group-hover/reveal:bg-border/30"
        aria-hidden="true"
      />
      {alert ? <span className="shrink-0 font-medium text-destructive">{alert}</span> : null}
      <ChevronRight className="size-3 shrink-0 text-muted-foreground/35 transition-colors group-hover/reveal:text-muted-foreground/70" />
    </button>
  );
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
  readOnly = false,
  canExecute = !readOnly,
  outputHostContext,
}: CodeCellProps) {
  // Read transient UI state from the store
  const isFocused = useIsCellFocused(cell.id);
  const isExecuting = useIsCellExecuting(cell.id);
  const isQueued = useIsCellQueued(cell.id);
  const queuePriority = useCellQueuePriority(cell.id);
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
  const isExecutionErrored = execution?.success === false || execution?.status === "error";
  const languageLabel =
    language === "ipython" ? "Python" : (languageDisplayNames[language] ?? "Code");
  const isSourceEmpty = cell.source.trim().length === 0;
  const showOutputChrome = useMemo(() => needsOutputChrome(outputs), [outputs]);
  const sourcePreview = cell.source.split("\n")[0]?.trim() || "source";

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
      if (readOnly) {
        return;
      }
      if (isLastCell && onInsertCellAfter) {
        onInsertCellAfter();
      } else if (onFocusNext) {
        onFocusNext(cursorPosition);
      }
    },
    [isLastCell, onFocusNext, onInsertCellAfter, readOnly],
  );

  const handleExecute = useCallback(() => {
    if (!canExecute) {
      return;
    }
    onExecute();
  }, [canExecute, onExecute]);

  // Get keyboard navigation bindings
  const navigationKeyMap = useCellKeyboardNavigation({
    onFocusPrevious: onFocusPrevious ?? (() => {}),
    onFocusNext: handleFocusNextOrCreate,
    onExecute: canExecute ? handleExecute : undefined,
    onExecuteAndInsert:
      canExecute && onInsertCellAfter
        ? () => {
            handleExecute();
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
        if (readOnly) {
          return false;
        }
        setHistoryInitialQuery(
          historyQueryFromEditor(editorRef.current?.getEditor() ?? null, cell.source),
        );
        setHistoryDialogOpen(true);
        return true;
      },
    }),
    [cell.source, readOnly],
  );

  // Handle history selection - replace cell content via CRDT bridge
  const handleHistorySelect = useCallback(
    (source: string) => {
      if (readOnly) {
        return;
      }
      bridge.replaceSource(source);
    },
    [bridge, readOnly],
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

  const hasCurrentLine =
    !isSourceEmpty ||
    outputs.length > 0 ||
    executionCount !== null ||
    isExecuting ||
    isQueued ||
    isExecutionErrored ||
    isSourceHidden;
  const currentLine = hasCurrentLine ? (
    <CodeCellCurrentLine
      languageLabel={languageLabel}
      count={executionCount}
      isExecuting={isExecuting}
      isQueued={isQueued}
      queuePriority={queuePriority}
      isErrored={isExecutionErrored}
      isFocused={isFocused}
      compactIdle={isSourceEmpty}
      activityContent={<CellPresenceIndicators cellId={cell.id} variant="inline" prefixSeparator />}
    />
  ) : null;

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
        gutterContent={
          <CompactExecutionButton
            count={executionCount}
            isExecuting={isExecuting || isGroupExecuting}
            isQueued={isQueued}
            isErrored={isExecutionErrored}
            submittedByActorLabel={submittedByActorLabel}
            isCellFocused={isFocused}
            canExecute={canExecute}
            onExecute={handleExecute}
            onInterrupt={onInterrupt}
            className={cn(
              bothHidden &&
                !isFocused &&
                !isExecuting &&
                !isGroupExecuting &&
                !isQueued &&
                !isExecutionErrored &&
                "opacity-0 group-hover:opacity-70",
            )}
          />
        }
        rightGutterContent={rightGutterContent}
        stateLaneClassName={isSourceHidden ? "pt-2 sm:pt-2" : undefined}
        dragHandleProps={dragHandleProps}
        isDragging={isDragging}
        codeContent={
          <>
            {/* Source visibility toggle + Editor */}
            {bothHidden ? (
              <div className="mt-0.5">
                <HiddenCellDisclosure
                  icon={Code2}
                  disabled={readOnly}
                  pulsing={isExecuting || isGroupExecuting}
                  onClick={() => {
                    if (readOnly) return;
                    if (onExpandHiddenGroup) {
                      onExpandHiddenGroup();
                    } else {
                      onToggleSourceHidden?.(false);
                      onToggleOutputsHidden?.(false);
                    }
                  }}
                  title={
                    hiddenGroupCount && hiddenGroupCount > 1
                      ? `Show ${hiddenGroupCount} cells`
                      : "Show cell"
                  }
                  label={
                    hiddenGroupCount && hiddenGroupCount > 1
                      ? `${hiddenGroupCount} cells hidden`
                      : "Cell hidden"
                  }
                  alert={
                    hiddenGroupErrorCount
                      ? hiddenGroupErrorCount === 1
                        ? "1 error"
                        : `${hiddenGroupErrorCount} errors`
                      : undefined
                  }
                />
              </div>
            ) : isSourceHidden ? (
              <>
                <div className="mt-0.5">
                  <HiddenCellDisclosure
                    icon={Code2}
                    disabled={readOnly}
                    onClick={() => onToggleSourceHidden?.(false)}
                    title="Show input"
                    label="Input hidden"
                    detail={sourcePreview}
                  />
                </div>
                {currentLine}
              </>
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
                  readOnly={readOnly}
                />
                {currentLine}
              </>
            )}
          </>
        }
        outputContent={
          isOutputsHidden && outputs.length > 0 ? (
            <div className={cn("mt-0.5", cellOutputInnerInset)}>
              <HiddenCellDisclosure
                icon={Eye}
                disabled={readOnly}
                onClick={() => onToggleOutputsHidden?.(false)}
                title="Show outputs"
                label={outputs.length === 1 ? "Output hidden" : "Outputs hidden"}
                detail={outputs.length > 1 ? `${outputs.length} outputs` : undefined}
              />
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
              hostContext={outputHostContext}
              resolveTracebackExecutionTarget={resolveTracebackExecutionTarget}
              onNavigateToTracebackCell={handleTracebackCellNavigate}
              focused={outputFocused}
              useOutputWell={showOutputChrome}
            />
          )
        }
        outputRightGutterContent={
          outputs.length > 0 && !isOutputsHidden && onToggleOutputsHidden && !readOnly ? (
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
