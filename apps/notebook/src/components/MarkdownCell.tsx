import type { EditorView, KeyBinding } from "@codemirror/view";
import { Check, Pencil } from "lucide-react";
import {
  memo,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CellContainer } from "@/components/cell/CellContainer";
import { CodeMirrorEditor, type CodeMirrorEditorRef } from "@/components/editor/codemirror-editor";
import { remoteCursorsExtension } from "@/components/editor/remote-cursors";
import { searchHighlight } from "@/components/editor/search-highlight";
import { textAttributionExtension } from "@/components/editor/text-attribution";
import { IsolatedFrame, type IsolatedFrameHandle } from "@/components/isolated";
import type { NteractEmbedHostContextPatch } from "@/components/isolated/host-context";
import { injectPluginsForMimes } from "@/components/isolated/iframe-libraries";
import { findVerticalScrollAncestor } from "@/components/isolated/scroll-boundary";
import type { MarkdownHeadingAnchor } from "@/components/outputs/markdown-heading-anchors";
import { ProjectedMarkdownView } from "./markdown/ProjectedMarkdownView";
import { useColorTheme, useDarkMode } from "@/lib/dark-mode";
import {
  canRenderMarkdownProjectionInHost,
  type MarkdownProjectionRun,
  projectedMarkdownPreviewHeight,
  projectMarkdownPlan,
  resolveMarkdownProjection,
} from "../lib/markdown-projection";
import { cn } from "@/lib/utils";
import { usePresenceContext } from "../contexts/PresenceContext";
import { useCellKeyboardNavigation } from "../hooks/useCellKeyboardNavigation";
import { useCrdtBridge } from "../hooks/useCrdtBridge";
import { useBlobResolver } from "../lib/blob-port";
import {
  useIsCellFocused,
  useIsNextCellFromFocused,
  useIsPreviousCellFromFocused,
  useSearchQuery,
} from "@/components/notebook/state/cell-ui-state";
import { onEditorRegistered, onEditorUnregistered } from "../lib/cursor-registry";
import { registerCellEditor, unregisterCellEditor } from "../lib/editor-registry";
import { logNotebookIsolatedDiagnostic } from "../lib/isolated-diagnostics";
import { logger } from "../lib/logger";
import {
  isMeasuredElementFound,
  registerMarkdownHeadingNavigator,
} from "@/components/cell/markdown-heading-navigation";
import { rewriteMarkdownAssetRefs } from "../lib/markdown-assets";
import { openUrl } from "../lib/open-url";
import { toggleMarkdownTaskMarker } from "../lib/markdown-task-source";
import { presenceSenderExtension } from "../lib/presence-sender";
import type { MarkdownCell as MarkdownCellType } from "../types";
import { CellPresenceIndicators } from "./cell/CellPresenceIndicators";

const handleIframeError = (err: { message: string; stack?: string }) =>
  logger.error("[MarkdownCell] iframe error:", err);
const EMPTY_HEADING_ANCHORS: readonly MarkdownHeadingAnchor[] = [];
const MARKDOWN_PREVIEW_MIN_HEIGHT = 24;
const MARKDOWN_PREVIEW_MAX_INITIAL_HEIGHT = 720;

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function formatPluginLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function estimateMarkdownPreviewHeight(source: string): number {
  const trimmed = source.trim();
  if (!trimmed) return MARKDOWN_PREVIEW_MIN_HEIGHT;

  const lines = source.split(/\r?\n/);
  let height = 20;
  let inCodeFence = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^(```|~~~)/.test(line)) {
      inCodeFence = !inCodeFence;
      height += 24;
      continue;
    }
    if (line.length === 0) {
      height += 10;
      continue;
    }
    if (inCodeFence) {
      height += 22;
      continue;
    }
    if (/^#\s+/.test(line)) {
      height += 56;
    } else if (/^##\s+/.test(line)) {
      height += 42;
    } else if (/^#{3,6}\s+/.test(line)) {
      height += 34;
    } else {
      height += 28 + Math.floor(Math.max(0, line.length - 96) / 96) * 24;
    }
  }

  return Math.min(
    MARKDOWN_PREVIEW_MAX_INITIAL_HEIGHT,
    Math.max(MARKDOWN_PREVIEW_MIN_HEIGHT, height),
  );
}

interface MarkdownCellProps {
  cell: MarkdownCellType;
  onFocus: () => void;
  onDelete?: () => void;
  onFocusPrevious?: (cursorPosition: "start" | "end") => void;
  onFocusNext?: (cursorPosition: "start" | "end") => void;
  onInsertCellAfter?: () => void;
  onUpdateSource?: (source: string) => void;
  isLastCell?: boolean;
  /** Props for dnd-kit drag handle (applied to ribbon) */
  dragHandleProps?: Record<string, unknown>;
  /** Whether this cell is currently being dragged */
  isDragging?: boolean;
  /** Content for the right gutter (e.g., delete button) */
  rightGutterContent?: ReactNode;
  headingAnchors?: readonly MarkdownHeadingAnchor[];
  readOnly?: boolean;
  outputHostContext?: NteractEmbedHostContextPatch;
}

export const MarkdownCell = memo(function MarkdownCell({
  cell,
  onFocus,
  onDelete,
  onFocusPrevious,
  onFocusNext,
  onInsertCellAfter,
  onUpdateSource,
  isLastCell = false,
  dragHandleProps,
  isDragging,
  rightGutterContent,
  headingAnchors = EMPTY_HEADING_ANCHORS,
  readOnly = false,
  outputHostContext,
}: MarkdownCellProps) {
  const isFocused = useIsCellFocused(cell.id);
  const isPreviousCellFromFocused = useIsPreviousCellFromFocused(cell.id);
  const isNextCellFromFocused = useIsNextCellFromFocused(cell.id);
  const searchQuery = useSearchQuery();
  const applyInlineFormatting = useCallback(
    (prefix: string, suffix = prefix) =>
      (view: EditorView) => {
        const selection = view.state.selection.main;
        const selectedText = view.state.doc.sliceString(selection.from, selection.to);
        const wrappedText = `${prefix}${selectedText}${suffix}`;

        view.dispatch({
          changes: {
            from: selection.from,
            to: selection.to,
            insert: wrappedText,
          },
          selection: {
            anchor: selection.from + prefix.length,
            head: selection.from + prefix.length + selectedText.length,
          },
        });
        return true;
      },
    [],
  );

  const applyLinkFormatting = useCallback((view: EditorView) => {
    const selection = view.state.selection.main;
    const selectedText = view.state.doc.sliceString(selection.from, selection.to);
    const linkText = selectedText || "link text";
    const formattedText = `[${linkText}](https://)`;

    view.dispatch({
      changes: {
        from: selection.from,
        to: selection.to,
        insert: formattedText,
      },
      selection: selectedText
        ? {
            anchor: selection.from + 1,
            head: selection.from + 1 + linkText.length,
          }
        : {
            anchor: selection.from + 1,
            head: selection.from + 1 + "link text".length,
          },
    });
    return true;
  }, []);

  const applyQuoteFormatting = useCallback((view: EditorView) => {
    const selection = view.state.selection.main;
    const selectedText = view.state.doc.sliceString(selection.from, selection.to);
    const text = selectedText || "quote";
    const quotedText = text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");

    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: quotedText },
      selection: {
        anchor: selection.from,
        head: selection.from + quotedText.length,
      },
    });
    return true;
  }, []);

  const [editing, setEditing] = useState(!readOnly && cell.source === "");
  const [draftPreviewSource, setDraftPreviewSource] = useState<string | null>(null);
  const [activeSourcePosition, setActiveSourcePosition] = useState<number | undefined>();
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const previewSourcePositionRef = useRef<number | undefined>(undefined);
  const presence = usePresenceContext();
  const { extension: crdtBridgeExt, bridge } = useCrdtBridge(cell.id);
  const frameRef = useRef<IsolatedFrameHandle>(null);
  const injectedLibsRef = useRef(new Set<string>());
  const viewRef = useRef<HTMLDivElement>(null);
  const [previewFrameInteractionActive, setPreviewFrameInteractionActive] = useState(false);
  const [previewFrameReadyGeneration, setPreviewFrameReadyGeneration] = useState(0);
  const previewSource = draftPreviewSource ?? cell.source;

  useEffect(() => {
    if (draftPreviewSource !== null && cell.source === draftPreviewSource) {
      setDraftPreviewSource(null);
    }
  }, [cell.source, draftPreviewSource]);

  // Same resolution rule as the outline rail: a source-matching attached plan
  // wins, an edited source reprojects, never render a plan for source the
  // cell no longer holds. Keeps the preview and the rail on the same frozen
  // plan object for a given source.
  const markdownProjection = useMemo(
    () =>
      draftPreviewSource !== null
        ? projectMarkdownPlan(draftPreviewSource)
        : resolveMarkdownProjection(cell.markdownProjection, cell.source),
    [cell.markdownProjection, cell.source, draftPreviewSource],
  );
  const canRenderProjectionInHost = canRenderMarkdownProjectionInHost(markdownProjection);
  const previewMinHeight = useMemo(
    () =>
      projectedMarkdownPreviewHeight(
        markdownProjection,
        estimateMarkdownPreviewHeight(previewSource),
        {
          maxHeight: MARKDOWN_PREVIEW_MAX_INITIAL_HEIGHT,
          minHeight: MARKDOWN_PREVIEW_MIN_HEIGHT,
        },
      ),
    [previewSource, markdownProjection],
  );

  const handleTaskCheckedChange = useCallback(
    (run: MarkdownProjectionRun, checked: boolean) => {
      if (readOnly || !onUpdateSource) return;

      const nextSource = toggleMarkdownTaskMarker(previewSource, run, checked);
      if (nextSource === null || nextSource === previewSource) return;

      setDraftPreviewSource(nextSource);
      if (!bridge.replaceSource(nextSource)) {
        onUpdateSource(nextSource);
      }
    },
    [bridge, onUpdateSource, previewSource, readOnly],
  );

  // Register EditorView with the cursor registry when in edit mode.
  const registeredViewRef = useRef<EditorView | null>(null);
  useEffect(() => {
    if (!editing) {
      if (registeredViewRef.current) {
        onEditorUnregistered(cell.id);
        unregisterCellEditor(cell.id);
        registeredViewRef.current = null;
      }
      return;
    }

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
  }, [cell.id, editing]);

  const darkMode = useDarkMode();
  const colorTheme = useColorTheme();
  const darkModeRef = useRef(darkMode);
  darkModeRef.current = darkMode;
  const colorThemeRef = useRef(colorTheme);
  colorThemeRef.current = colorTheme;

  const blobResolver = useBlobResolver();
  const markdownMetadata = useMemo(() => {
    if (headingAnchors.length === 0 && !markdownProjection) {
      return undefined;
    }

    return {
      ...(headingAnchors.length > 0 ? { nteractMarkdownHeadingAnchors: headingAnchors } : {}),
      ...(markdownProjection ? { nteractMarkdownProjection: markdownProjection } : {}),
    };
  }, [headingAnchors, markdownProjection]);

  const enterEditing = useCallback(() => {
    if (readOnly) return;
    onFocus();
    setPreviewFrameInteractionActive(false);
    setEditing(true);
  }, [onFocus, readOnly]);

  const noteEditorSourcePosition = useCallback((position: number) => {
    previewSourcePositionRef.current = position;
  }, []);

  const getCurrentEditorSource = useCallback(() => {
    return editorRef.current?.getEditor()?.state.doc.toString() ?? cell.source;
  }, [cell.source]);

  const revealEditorSourcePosition = useCallback(() => {
    const view = editorRef.current?.getEditor();
    const position = view?.state.selection.main.head ?? previewSourcePositionRef.current;
    if (typeof position !== "number") return;
    previewSourcePositionRef.current = position;
    setActiveSourcePosition(position);
  }, []);

  const exitEditingToPreview = useCallback(
    (options?: { allowEmpty?: boolean }) => {
      const source = getCurrentEditorSource();
      if (!source.trim() && !options?.allowEmpty) return;
      setDraftPreviewSource(source);
      revealEditorSourcePosition();
      setEditing(false);
    },
    [getCurrentEditorSource, revealEditorSourcePosition],
  );

  const handleRenderMarkdownMouseDown = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      exitEditingToPreview({ allowEmpty: true });
    },
    [exitEditingToPreview],
  );

  const releasePreviewFrameInteraction = useCallback(() => {
    setPreviewFrameInteractionActive(false);
  }, []);

  const activatePreviewFrameInteraction = useCallback(() => {
    setPreviewFrameInteractionActive(true);
    onFocus();
  }, [onFocus]);

  const handlePreviewWrapperPointerDown = useCallback(() => {
    activatePreviewFrameInteraction();
  }, [activatePreviewFrameInteraction]);

  const handlePreviewFrameMouseUp = useCallback(
    ({ hasSelection }: { hasSelection?: boolean }) => {
      if (hasSelection) return;
      releasePreviewFrameInteraction();
    },
    [releasePreviewFrameInteraction],
  );

  const deactivatePreviewFrameInteractionWhenIdle = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      if (!(event.buttons > 0)) {
        releasePreviewFrameInteraction();
      }
    },
    [releasePreviewFrameInteraction],
  );

  // Derived boundary flag: re-run the focus effect only when source crosses
  // empty↔non-empty, not on every keystroke.
  const hasContent = previewSource.trim().length > 0;
  useEffect(() => {
    if (readOnly) {
      setEditing(false);
      return;
    }
    if (!isFocused && editing && hasContent) {
      setEditing(false);
    }
    if (!isFocused || editing) {
      setPreviewFrameInteractionActive(false);
    }
  }, [hasContent, isFocused, editing, readOnly]);

  const handleBlur = useCallback(() => {
    exitEditingToPreview();
  }, [exitEditingToPreview]);

  const renderMarkdownPreviewFrame = useCallback(
    async (frame: IsolatedFrameHandle | null = frameRef.current) => {
      if (canRenderProjectionInHost) return;
      if (!frame || !previewSource) return;

      // Ensure theme is in sync before re-rendering (fixes theme drift after cell moves).
      frame.setTheme(darkModeRef.current, colorThemeRef.current ?? null);

      try {
        await injectPluginsForMimes(frame, ["text/markdown"], injectedLibsRef.current);
      } catch (error) {
        logger.warn("[MarkdownCell] Failed to load markdown renderer plugin:", error);
        if (frameRef.current !== frame) return;
        frame.render({
          mimeType: "text/plain",
          data: `Failed to load markdown renderer: ${formatPluginLoadError(error)}`,
          outputId: `markdown-error:${cell.id}`,
          cellId: cell.id,
          replace: true,
        });
        return;
      }

      if (frameRef.current !== frame) return;
      const processedSource = rewriteMarkdownAssetRefs(
        previewSource,
        cell.resolvedAssets,
        blobResolver,
      );
      frame.render({
        mimeType: "text/markdown",
        data: processedSource,
        metadata: markdownMetadata,
        outputId: `markdown:${cell.id}`,
        cellId: cell.id,
        replace: true,
      });
    },
    [
      canRenderProjectionInHost,
      previewSource,
      cell.id,
      cell.resolvedAssets,
      blobResolver,
      markdownMetadata,
    ],
  );

  // Render markdown content when iframe is ready.
  const handleFrameReady = useCallback(() => {
    if (canRenderProjectionInHost) return;
    const frame = frameRef.current;
    if (!frame || !previewSource) return;

    // Clear injected set — a reloaded iframe has a fresh renderer registry.
    injectedLibsRef.current.clear();
    setPreviewFrameReadyGeneration((generation) => generation + 1);
    void renderMarkdownPreviewFrame(frame);
  }, [canRenderProjectionInHost, previewSource, renderMarkdownPreviewFrame]);

  // Sync markdown to iframe whenever source or resolved assets change (supports RTC updates)
  useEffect(() => {
    if (canRenderProjectionInHost) return;
    if (!previewSource) return;
    const frame = frameRef.current;
    if (!frame?.isReady && previewFrameReadyGeneration === 0) return;

    void renderMarkdownPreviewFrame(frame);
  }, [
    canRenderProjectionInHost,
    previewSource,
    previewFrameReadyGeneration,
    renderMarkdownPreviewFrame,
  ]);

  const scrollToHeading = useCallback(
    async (headingAnchorId: string, options?: { behavior?: ScrollBehavior }) => {
      if (editing || !headingAnchorId) return false;

      const hostHeading = viewRef.current?.querySelector<HTMLElement>(
        `[id="${cssEscape(headingAnchorId)}"]`,
      );
      if (hostHeading) {
        const behavior = options?.behavior ?? "smooth";
        const topPadding = 16;
        const scrollContainer = findVerticalScrollAncestor(hostHeading);

        if (scrollContainer) {
          const containerRect = scrollContainer.getBoundingClientRect();
          const headingRect = hostHeading.getBoundingClientRect();
          scrollContainer.scrollTo({
            top: Math.max(
              0,
              scrollContainer.scrollTop + headingRect.top - containerRect.top - topPadding,
            ),
            behavior,
          });
          return true;
        }

        const headingRect = hostHeading.getBoundingClientRect();
        window.scrollTo({
          top: Math.max(0, window.scrollY + headingRect.top - topPadding),
          behavior,
        });
        return true;
      }

      if (!frameRef.current?.isReady) return false;

      const measurement = await frameRef.current.measureElement(headingAnchorId);
      if (!isMeasuredElementFound(measurement)) return false;

      const iframe = viewRef.current?.querySelector<HTMLIFrameElement>(
        'iframe[data-slot="isolated-frame"]',
      );
      if (!iframe) return false;

      const behavior = options?.behavior ?? "smooth";
      const topPadding = 16;
      const iframeRect = iframe.getBoundingClientRect();
      const scrollContainer = findVerticalScrollAncestor(iframe.parentElement ?? iframe);

      if (scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect();
        scrollContainer.scrollTo({
          top: Math.max(
            0,
            scrollContainer.scrollTop +
              iframeRect.top -
              containerRect.top +
              measurement.top -
              topPadding,
          ),
          behavior,
        });
        return true;
      }

      window.scrollTo({
        top: Math.max(0, window.scrollY + iframeRect.top + measurement.top - topPadding),
        behavior,
      });
      return true;
    },
    [editing],
  );

  useEffect(() => {
    return registerMarkdownHeadingNavigator(cell.id, scrollToHeading);
  }, [cell.id, scrollToHeading]);

  // Handle link clicks from iframe - open in system browser
  const handleLinkClick = useCallback((url: string) => {
    openUrl(url);
  }, []);

  // Handle keyboard navigation in view mode (when not editing)
  const handleViewKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        onFocusNext?.("start");
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        onFocusPrevious?.("end");
        e.preventDefault();
      } else if (e.key === "Enter" && e.ctrlKey && !e.metaKey && !e.altKey) {
        setEditing(false);
        e.preventDefault();
      } else if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Shift+Enter: move to next cell (like execute for code cells)
        onFocusNext?.("start");
        e.preventDefault();
      } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (readOnly) {
          return;
        }
        // Enter: enter edit mode
        enterEditing();
        e.preventDefault();
      }
    },
    [enterEditing, onFocusNext, onFocusPrevious, readOnly],
  );

  // Handle focus next, creating a new cell if at the end
  const handleFocusNextOrCreate = useCallback(
    (cursorPosition: "start" | "end") => {
      if (readOnly) {
        return;
      }
      // For markdown, close edit mode first
      const source = getCurrentEditorSource();
      if (source.trim()) {
        setDraftPreviewSource(source);
        setEditing(false);
      }
      if (isLastCell && onInsertCellAfter) {
        onInsertCellAfter();
      } else if (onFocusNext) {
        onFocusNext(cursorPosition);
      }
    },
    [getCurrentEditorSource, isLastCell, onFocusNext, onInsertCellAfter, readOnly],
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

  // Search highlight extension for edit mode + remote cursors + presence sender
  const searchExtensions = useMemo(
    () => [
      ...searchHighlight(searchQuery || ""),
      ...remoteCursorsExt,
      ...textAttributionExt,
      ...presenceSenderExt,
    ],
    [searchQuery, remoteCursorsExt, textAttributionExt, presenceSenderExt],
  );
  const editorExtensions = useMemo(
    () => [crdtBridgeExt, ...searchExtensions],
    [crdtBridgeExt, searchExtensions],
  );

  // Get keyboard navigation bindings
  const navigationKeyMap = useCellKeyboardNavigation({
    onFocusPrevious: onFocusPrevious ?? (() => {}),
    onFocusNext: handleFocusNextOrCreate,
    onExecute: () => {}, // No-op for markdown, enables Shift+Enter navigation
    onDelete,
    cellId: cell.id,
  });

  // Combine navigation with markdown-specific keys
  const keyMap: KeyBinding[] = useMemo(
    () => [
      {
        key: "Ctrl-Enter",
        run: () => {
          exitEditingToPreview({ allowEmpty: true });
          return true;
        },
      },
      ...navigationKeyMap,
      {
        key: "Escape",
        run: () => {
          exitEditingToPreview();
          return true;
        },
      },
      {
        key: "Mod-b",
        run: applyInlineFormatting("**"),
      },
      {
        key: "Mod-i",
        run: applyInlineFormatting("*"),
      },
      {
        key: "Mod-u",
        run: applyInlineFormatting("<u>", "</u>"),
      },
      {
        key: "Mod-k",
        run: applyLinkFormatting,
      },
      {
        key: "Mod-Shift-.",
        run: applyQuoteFormatting,
      },
      {
        key: "Mod-Shift->",
        run: applyQuoteFormatting,
      },
    ],
    [
      navigationKeyMap,
      exitEditingToPreview,
      applyInlineFormatting,
      applyLinkFormatting,
      applyQuoteFormatting,
    ],
  );

  // Focus editor when entering edit mode (after initial mount)
  const initialMountRef = useRef(true);
  useEffect(() => {
    if (initialMountRef.current) {
      initialMountRef.current = false;
      return;
    }
    if (editing) {
      requestAnimationFrame(() => {
        editorRef.current?.focus();
      });
    }
  }, [editing]);

  // Forward search query to the markdown iframe
  useEffect(() => {
    if (!editing && !canRenderProjectionInHost && frameRef.current?.isReady) {
      frameRef.current.search(searchQuery || "");
    }
  }, [searchQuery, editing, canRenderProjectionInHost]);

  // Focus view section when cell becomes focused but not editing
  useEffect(() => {
    if (isFocused && !editing) {
      requestAnimationFrame(() => {
        viewRef.current?.focus({ preventScroll: true });
      });
    }
  }, [isFocused, editing]);

  return (
    <CellContainer
      id={cell.id}
      cellType="markdown"
      isFocused={isFocused}
      isPreviousCellFromFocused={isPreviousCellFromFocused}
      isNextCellFromFocused={isNextCellFromFocused}
      onFocus={onFocus}
      presenceIndicators={<CellPresenceIndicators cellId={cell.id} />}
      dragHandleProps={dragHandleProps}
      isDragging={isDragging}
      rightGutterContent={
        readOnly ? null : editing ? (
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={handleRenderMarkdownMouseDown}
              className="flex items-center justify-center rounded p-1 text-muted-foreground/40 transition-colors hover:text-foreground"
              title="View rendered markdown"
              aria-label="View rendered markdown"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            {rightGutterContent}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              tabIndex={-1}
              onClick={enterEditing}
              className="flex items-center justify-center rounded p-1 text-muted-foreground/40 transition-colors hover:text-foreground"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            {rightGutterContent}
          </div>
        )
      }
      codeContent={
        <>
          {/* Editor section - hidden when not editing */}
          <div className={editing ? "block" : "hidden"}>
            <div className="flex items-center gap-1 py-1">
              <span className="text-xs text-muted-foreground font-mono">md</span>
            </div>
            <div>
              <CodeMirrorEditor
                ref={editorRef}
                initialValue={cell.source}
                language="markdown"
                lineWrapping
                onBlur={handleBlur}
                onSelectionChange={noteEditorSourcePosition}
                keyMap={keyMap}
                extensions={editorExtensions}
                placeholder="Enter markdown..."
                className="min-h-[2rem]"
                autoFocus={editing}
                readOnly={readOnly}
              />
            </div>
          </div>

          {/* View section - hidden when editing */}
          <div
            ref={viewRef}
            role="textbox"
            aria-readonly
            aria-label="Markdown cell content"
            tabIndex={0}
            className={cn("py-2 cursor-text outline-none", editing && "hidden")}
            onFocus={activatePreviewFrameInteraction}
            onDoubleClick={enterEditing}
            onPointerDown={handlePreviewWrapperPointerDown}
            onKeyDown={handleViewKeyDown}
          >
            {previewSource && canRenderProjectionInHost && markdownProjection ? (
              <ProjectedMarkdownView
                plan={markdownProjection}
                headingAnchors={headingAnchors}
                onLinkClick={handleLinkClick}
                onTaskCheckedChange={
                  readOnly || !onUpdateSource ? undefined : handleTaskCheckedChange
                }
                activeSourcePosition={activeSourcePosition}
              />
            ) : (
              <div
                className={previewSource ? undefined : "hidden"}
                onPointerDown={handlePreviewWrapperPointerDown}
                onPointerOut={deactivatePreviewFrameInteractionWhenIdle}
              >
                <IsolatedFrame
                  ref={frameRef}
                  name={`md-${cell.id}`}
                  darkMode={darkMode}
                  colorTheme={colorTheme}
                  hostContext={outputHostContext}
                  minHeight={previewMinHeight}
                  autoHeight
                  scrollPassthrough={!previewFrameInteractionActive}
                  allowWheelBoundaryScroll={previewFrameInteractionActive}
                  revealOnRender
                  reserveHeightOnReveal
                  onReady={handleFrameReady}
                  onLinkClick={handleLinkClick}
                  onMouseDown={activatePreviewFrameInteraction}
                  onMouseUp={handlePreviewFrameMouseUp}
                  onDoubleClick={enterEditing}
                  onError={handleIframeError}
                  onDiagnostic={logNotebookIsolatedDiagnostic}
                  className="w-full"
                />
              </div>
            )}
            {!previewSource && <p className="text-muted-foreground italic">Double-click to edit</p>}
          </div>
        </>
      }
    />
  );
});
