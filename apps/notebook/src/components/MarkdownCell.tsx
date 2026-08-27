import type { EditorView, KeyBinding } from "@codemirror/view";
import { Check, Pencil } from "lucide-react";
import {
  memo,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
import { CommentSelectionAffordance } from "@/components/comments/CommentSelectionAffordance";
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
  markdownProjectionMatchesSource,
  renderedTextForSourceRange,
  type MarkdownProjectionRun,
  projectedMarkdownPreviewHeight,
  projectMarkdownPlan,
  resolveMarkdownProjection,
} from "../lib/markdown-projection";
import { cn } from "@/lib/utils";
import { usePresenceContext } from "@/components/notebook/presence-context";
import { useCellKeyboardNavigation } from "../hooks/useCellKeyboardNavigation";
import { useCrdtBridge } from "../hooks/useCrdtBridge";
import { useBlobResolver } from "../lib/blob-port";
import {
  getActiveInteractionTarget,
  useIsCellEditorTarget,
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
import { sourceRangeAnchorFromRenderedMarkdownSelection } from "../lib/rendered-markdown-source-comment";
import { buildRenderedCommentHighlights } from "../lib/rendered-comment-highlights";
import { commentHighlightExtension } from "../lib/comment-highlight-extension";
import { refreshCellCommentHighlights, type SourceCommentThread } from "../lib/comment-highlights";
import {
  resolveSourceRangeAnchor,
  type SourceRangeCommentAnchor,
} from "../lib/comment-source-anchor";
import { sourceCommentExtension } from "../lib/source-comment-extension";
import type { MarkdownCell as MarkdownCellType } from "../types";
import { CellPresenceIndicators } from "./cell/CellPresenceIndicators";
import { EditorContextMenu } from "./EditorContextMenu";
import {
  cleanRenderedMarkdownClipboardHtml,
  RenderedMarkdownContextMenu,
} from "./RenderedMarkdownContextMenu";

const handleIframeError = (err: { message: string; stack?: string }) =>
  logger.error("[MarkdownCell] iframe error:", err);
const EMPTY_HEADING_ANCHORS: readonly MarkdownHeadingAnchor[] = [];
const MARKDOWN_EDITOR_CONTENT_ATTRIBUTES = {
  autocapitalize: "sentences",
  autocorrect: "on",
  spellcheck: "true",
} as const;
const MARKDOWN_RENDERED_COMMENT_BUTTON_SIZE = 34;
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
  /** Select the rendered cell without entering source-edit mode. */
  onSelect?: () => void;
  /** Publish source-editor interaction when edit mode is entered. */
  onFocus: () => void;
  onDelete?: () => void;
  onFocusPrevious?: (cursorPosition: "start" | "end") => void;
  onFocusNext?: (cursorPosition: "start" | "end") => void;
  /** Move between rendered cell surfaces without entering source editing. */
  onPreviewFocusPrevious?: () => void;
  onPreviewFocusNext?: () => void;
  /** Escape enters Jupyter-style command mode (in addition to exiting to preview). */
  onEnterCommandMode?: () => void;
  onInsertCellAfter?: () => void;
  onChangeCellType?: (type: "code" | "markdown") => void;
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
  onCreateSourceComment?: (anchor: SourceRangeCommentAnchor, quote?: string | null) => void;
  onActivateCommentThread?: (threadId: string) => void;
  commentThreads?: readonly SourceCommentThread[];
  pendingCommentAnchor?: SourceRangeCommentAnchor | null;
  outputHostContext?: NteractEmbedHostContextPatch;
}

export const MarkdownCell = memo(function MarkdownCell({
  cell,
  onSelect,
  onFocus,
  onDelete,
  onFocusPrevious,
  onFocusNext,
  onPreviewFocusPrevious,
  onPreviewFocusNext,
  onEnterCommandMode,
  onInsertCellAfter,
  onChangeCellType,
  onUpdateSource,
  isLastCell = false,
  dragHandleProps,
  isDragging,
  rightGutterContent,
  headingAnchors = EMPTY_HEADING_ANCHORS,
  readOnly = false,
  onCreateSourceComment,
  onActivateCommentThread,
  commentThreads,
  pendingCommentAnchor,
  outputHostContext,
}: MarkdownCellProps) {
  const isFocused = useIsCellFocused(cell.id);
  const isPreviousCellFromFocused = useIsPreviousCellFromFocused(cell.id);
  const isNextCellFromFocused = useIsNextCellFromFocused(cell.id);
  const isEditorTarget = useIsCellEditorTarget(cell.id);
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
  const commandModeTransitionRef = useRef(false);
  const previewSourcePositionRef = useRef<number | undefined>(undefined);
  const presence = usePresenceContext();
  const { extension: crdtBridgeExt, bridge } = useCrdtBridge(cell.id);
  const frameRef = useRef<IsolatedFrameHandle>(null);
  const injectedLibsRef = useRef(new Set<string>());
  const viewRef = useRef<HTMLDivElement>(null);
  const [renderedSourceCommentTarget, setRenderedSourceCommentTarget] = useState<{
    anchor: SourceRangeCommentAnchor;
    left: number;
    top: number;
  } | null>(null);
  const [previewFrameInteractionActive, setPreviewFrameInteractionActive] = useState(false);
  const [previewFrameReadyGeneration, setPreviewFrameReadyGeneration] = useState(0);
  const previewSource = draftPreviewSource ?? cell.source;
  const selectCell = onSelect ?? onFocus;

  useEffect(() => {
    if (draftPreviewSource !== null && cell.source === draftPreviewSource) {
      setDraftPreviewSource(null);
    }
  }, [cell.source, draftPreviewSource]);

  useEffect(() => {
    setRenderedSourceCommentTarget(null);
  }, [editing, previewSource]);

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
  const projectionMatchesPreview =
    markdownProjection !== null &&
    markdownProjectionMatchesSource(markdownProjection, previewSource);
  const canCommentOnRenderedMarkdown =
    Boolean(onCreateSourceComment) && !readOnly && !editing && projectionMatchesPreview;
  const renderedCommentHighlights = useMemo(
    () =>
      buildRenderedCommentHighlights({
        cellId: cell.id,
        source: previewSource,
        editing,
        projectionMatchesPreview,
        commentThreads,
        pendingCommentAnchor,
      }),
    [
      cell.id,
      commentThreads,
      editing,
      pendingCommentAnchor,
      previewSource,
      projectionMatchesPreview,
    ],
  );
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
        refreshCellCommentHighlights(cell.id);
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

  // Command-mode "Enter" leaves command mode by setting the interaction
  // target to {kind:"editor"} directly (see useCommandMode), without going
  // through enterEditing()/onFocus(). The editor for this cell is always
  // mounted (just CSS-hidden while not editing), so entering edit mode here
  // is required before that target's own focus request can land — a hidden
  // element cannot receive DOM focus.
  useEffect(() => {
    if (readOnly) return;
    if (!isEditorTarget) {
      // Command mode has propagated through the reactive store. Future
      // explicit {kind:"editor"} transitions (e.g. pressing Enter while the
      // cell is selected) may enter editing again.
      commandModeTransitionRef.current = false;
      return;
    }
    // Hiding CodeMirror can synchronously emit focus/selection work that
    // republishes the previous editor target before command mode has fully
    // propagated. Do not let that transient target reopen the editor.
    if (commandModeTransitionRef.current) return;
    const currentTarget = getActiveInteractionTarget();
    if (
      isEditorTarget &&
      currentTarget?.kind === "editor" &&
      currentTarget.cellId === cell.id &&
      !editing
    ) {
      enterEditing();
    }
  }, [cell.id, isEditorTarget, editing, enterEditing, readOnly]);

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

  // Returns whether the transition actually happened. Callers that also
  // want to hand off to command mode (Escape) must check this — an empty
  // cell with allowEmpty unset no-ops here and keeps the editor mounted
  // and focused, so entering command mode in that case would desync the
  // published interaction target from the still-focused editor.
  const exitEditingToPreview = useCallback(
    (options?: { allowEmpty?: boolean }): boolean => {
      const source = getCurrentEditorSource();
      if (!source.trim() && !options?.allowEmpty) return false;
      setDraftPreviewSource(source);
      revealEditorSourcePosition();
      setEditing(false);
      return true;
    },
    [getCurrentEditorSource, revealEditorSourcePosition],
  );

  const renderMarkdownAndEnterCommandMode = useCallback(() => {
    commandModeTransitionRef.current = true;
    exitEditingToPreview({ allowEmpty: true });
    // Rendering a markdown cell removes its source editor from view. Move
    // the shared interaction target out of {kind:"editor"} at the same time;
    // otherwise the editor-target effect below observes editing=false with
    // an editor target and immediately reopens the source editor.
    onEnterCommandMode?.();
  }, [exitEditingToPreview, onEnterCommandMode]);

  const handleRenderMarkdownMouseDown = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      renderMarkdownAndEnterCommandMode();
    },
    [renderMarkdownAndEnterCommandMode],
  );

  const releasePreviewFrameInteraction = useCallback(() => {
    setPreviewFrameInteractionActive(false);
  }, []);

  const activatePreviewFrameInteraction = useCallback(() => {
    setPreviewFrameInteractionActive(true);
    selectCell();
  }, [selectCell]);

  const handlePreviewWrapperPointerDown = useCallback(() => {
    activatePreviewFrameInteraction();
    setRenderedSourceCommentTarget(null);
  }, [activatePreviewFrameInteraction]);

  const clearRenderedSourceCommentTarget = useCallback(() => {
    setRenderedSourceCommentTarget(null);
  }, []);

  const updateRenderedSourceCommentTarget = useCallback(() => {
    if (!canCommentOnRenderedMarkdown) {
      clearRenderedSourceCommentTarget();
      return;
    }

    const root = viewRef.current;
    if (!root || typeof window === "undefined") {
      clearRenderedSourceCommentTarget();
      return;
    }

    const selection = window.getSelection();
    const anchor = sourceRangeAnchorFromRenderedMarkdownSelection(
      cell.id,
      previewSource,
      root,
      selection,
    );
    if (!anchor || !selection || selection.rangeCount === 0) {
      clearRenderedSourceCommentTarget();
      return;
    }

    const rangeRect = selection.getRangeAt(0).getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    if (rangeRect.width === 0 && rangeRect.height === 0) {
      clearRenderedSourceCommentTarget();
      return;
    }

    setRenderedSourceCommentTarget({
      anchor,
      left: Math.min(
        Math.max(0, rangeRect.right - rootRect.left + 6),
        Math.max(0, rootRect.width - MARKDOWN_RENDERED_COMMENT_BUTTON_SIZE),
      ),
      top: Math.max(0, rangeRect.top - rootRect.top - 32),
    });
  }, [canCommentOnRenderedMarkdown, cell.id, clearRenderedSourceCommentTarget, previewSource]);

  const requestRenderedSourceComment = useCallback(() => {
    if (!canCommentOnRenderedMarkdown || !onCreateSourceComment) return false;

    const root = viewRef.current;
    if (!root || typeof window === "undefined") return false;

    const anchor = sourceRangeAnchorFromRenderedMarkdownSelection(
      cell.id,
      previewSource,
      root,
      window.getSelection(),
    );

    if (!anchor) return false;
    const range = resolveSourceRangeAnchor(previewSource, anchor);
    const quote = range
      ? renderedTextForSourceRange(markdownProjection, range.from, range.to)
      : null;
    onCreateSourceComment(anchor, quote);
    window.getSelection()?.removeAllRanges();
    clearRenderedSourceCommentTarget();
    return true;
  }, [
    canCommentOnRenderedMarkdown,
    cell.id,
    clearRenderedSourceCommentTarget,
    markdownProjection,
    onCreateSourceComment,
    previewSource,
  ]);

  const handleRenderedSourceCommentClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (requestRenderedSourceComment()) return;
      const anchor = renderedSourceCommentTarget?.anchor;
      if (!anchor || !onCreateSourceComment) return;
      const range = resolveSourceRangeAnchor(previewSource, anchor);
      const quote = range
        ? renderedTextForSourceRange(markdownProjection, range.from, range.to)
        : null;
      onCreateSourceComment(anchor, quote);
      if (typeof window !== "undefined") {
        window.getSelection()?.removeAllRanges();
      }
      clearRenderedSourceCommentTarget();
    },
    [
      clearRenderedSourceCommentTarget,
      markdownProjection,
      onCreateSourceComment,
      previewSource,
      renderedSourceCommentTarget,
      requestRenderedSourceComment,
    ],
  );

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

  useEffect(() => {
    if (readOnly) {
      setEditing(false);
      return;
    }
    if (!isFocused || editing) {
      setPreviewFrameInteractionActive(false);
    }
  }, [isFocused, editing, readOnly]);

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

    // Clear injected set because a reloaded iframe has a fresh renderer registry.
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
      const key = e.key.toLowerCase();
      if (key === "m" && e.altKey && (e.metaKey || e.ctrlKey)) {
        if (requestRenderedSourceComment()) {
          e.preventDefault();
          return;
        }
      }

      if (e.key === "Escape") {
        (e.currentTarget as HTMLElement).blur();
        onEnterCommandMode?.();
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        if (onPreviewFocusNext) onPreviewFocusNext();
        else onFocusNext?.("start");
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        if (onPreviewFocusPrevious) onPreviewFocusPrevious();
        else onFocusPrevious?.("end");
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
        const interactionTarget = getActiveInteractionTarget();
        // Cell insertion updates the notebook interaction target synchronously,
        // but the previously selected Markdown preview may retain DOM focus.
        // Let the document-level command-mode handler process Enter for the
        // newly selected cell instead of reclaiming focus for this stale view.
        if (interactionTarget && interactionTarget.cellId !== cell.id) {
          return;
        }
        // Enter: enter edit mode
        enterEditing();
        e.preventDefault();
      }
    },
    [
      enterEditing,
      cell.id,
      onEnterCommandMode,
      onFocusNext,
      onFocusPrevious,
      onPreviewFocusNext,
      onPreviewFocusPrevious,
      readOnly,
      requestRenderedSourceComment,
    ],
  );

  const handleRenderedMarkdownCopy = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      if (editing || !canRenderProjectionInHost || !markdownProjection) return;

      const root = viewRef.current;
      const selection = typeof window === "undefined" ? null : window.getSelection();
      if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) return;

      const range = selection.getRangeAt(0);
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;

      const anchor = sourceRangeAnchorFromRenderedMarkdownSelection(
        cell.id,
        previewSource,
        root,
        selection,
      );
      if (!anchor?.exact_quote) return;

      event.preventDefault();
      event.clipboardData.setData("text/plain", anchor.exact_quote);
      event.clipboardData.setData("text/html", cleanRenderedMarkdownClipboardHtml(range));
    },
    [canRenderProjectionInHost, cell.id, editing, markdownProjection, previewSource],
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

  // Handle markdown lifecycle shortcuts in the capture phase, before
  // CodeMirror's content DOM can consume them. Code cells can keep all of
  // their shortcuts in CodeMirror because execution does not unmount/hide
  // their editor; markdown Escape/execute transitions do, so they need a
  // reliable owner outside the editor event pipeline.
  const handleEditorKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        renderMarkdownAndEnterCommandMode();
        return;
      }

      if (event.key !== "Enter" || event.altKey) return;

      if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        renderMarkdownAndEnterCommandMode();
        handleFocusNextOrCreate("start");
        return;
      }

      if (!event.shiftKey && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        renderMarkdownAndEnterCommandMode();
      }
    },
    [handleFocusNextOrCreate, renderMarkdownAndEnterCommandMode],
  );

  // Remote cursors extension (stable, no deps that change)
  const remoteCursorsExt = useMemo(() => remoteCursorsExtension(), []);

  // Text attribution extension (stable, no deps that change)
  const textAttributionExt = useMemo(() => textAttributionExtension(), []);

  // Presence sender extension broadcasts local cursor/selection to other peers.
  const presenceSenderExt = useMemo(() => {
    if (!presence) return [];
    return [
      presenceSenderExtension(cell.id, {
        onCursor: presence.setCursor,
        onSelection: presence.setSelection,
      }),
    ];
  }, [cell.id, presence]);

  const sourceCommentExt = useMemo(() => {
    if (readOnly || !onCreateSourceComment) return [];
    return [sourceCommentExtension(cell.id, onCreateSourceComment)];
  }, [cell.id, onCreateSourceComment, readOnly]);

  const commentHighlightExt = useMemo(() => {
    if (!onActivateCommentThread) return [];
    return [
      commentHighlightExtension({
        onActivate: onActivateCommentThread,
        onReady: () => refreshCellCommentHighlights(cell.id),
      }),
    ];
  }, [cell.id, onActivateCommentThread]);

  // Search highlight extension for edit mode, remote cursors, presence, and comments.
  const searchExtensions = useMemo(
    () => [
      ...searchHighlight(searchQuery || ""),
      ...remoteCursorsExt,
      ...textAttributionExt,
      ...presenceSenderExt,
      ...sourceCommentExt,
      ...commentHighlightExt,
    ],
    [
      searchQuery,
      remoteCursorsExt,
      textAttributionExt,
      presenceSenderExt,
      sourceCommentExt,
      commentHighlightExt,
    ],
  );
  const editorExtensions = useMemo(
    () => [crdtBridgeExt, ...searchExtensions],
    [crdtBridgeExt, searchExtensions],
  );

  // Get keyboard navigation bindings
  const navigationKeyMap = useCellKeyboardNavigation({
    onFocusPrevious: onFocusPrevious ?? (() => {}),
    onFocusNext: handleFocusNextOrCreate,
    // Markdown "execution" means rendering the current editor document.
    // Shift-Enter renders then advances; Ctrl/Mod-Enter renders in place.
    onExecute: renderMarkdownAndEnterCommandMode,
    onExecuteInPlace: renderMarkdownAndEnterCommandMode,
    onDelete,
    cellId: cell.id,
  });

  // Combine navigation with markdown-specific keys
  const keyMap: KeyBinding[] = useMemo(
    () => [
      ...navigationKeyMap,
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
    [navigationKeyMap, applyInlineFormatting, applyLinkFormatting, applyQuoteFormatting],
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
      onFocus={editing ? onFocus : selectCell}
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
              <Check className="size-3.5" />
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
              <Pencil className="size-3.5" />
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
              <div onKeyDownCapture={handleEditorKeyDownCapture}>
                <EditorContextMenu
                  cellId={cell.id}
                  cellType="markdown"
                  readOnly={readOnly}
                  onChangeCellType={onChangeCellType}
                  onCreateSourceComment={onCreateSourceComment}
                >
                  <CodeMirrorEditor
                    ref={editorRef}
                    initialValue={cell.source}
                    language="markdown"
                    lineWrapping
                    onSelectionChange={noteEditorSourcePosition}
                    keyMap={keyMap}
                    extensions={editorExtensions}
                    contentAttributes={MARKDOWN_EDITOR_CONTENT_ATTRIBUTES}
                    placeholder="Enter markdown..."
                    className="min-h-[2rem]"
                    autoFocus={editing}
                    readOnly={readOnly}
                  />
                </EditorContextMenu>
              </div>
            </div>
          </div>

          <RenderedMarkdownContextMenu
            cellId={cell.id}
            source={previewSource}
            markdownProjection={markdownProjection}
            viewRef={viewRef}
            onChangeCellType={onChangeCellType}
            onCreateSourceComment={canCommentOnRenderedMarkdown ? onCreateSourceComment : undefined}
          >
            {/* View section - hidden when editing */}
            <div
              ref={viewRef}
              role="textbox"
              aria-readonly
              aria-label="Markdown cell content"
              tabIndex={0}
              className={cn("relative py-2 cursor-text outline-none", editing && "hidden")}
              onFocus={activatePreviewFrameInteraction}
              onDoubleClick={enterEditing}
              onPointerDown={handlePreviewWrapperPointerDown}
              onMouseUp={updateRenderedSourceCommentTarget}
              onKeyUp={updateRenderedSourceCommentTarget}
              onKeyDown={handleViewKeyDown}
              onCopy={handleRenderedMarkdownCopy}
            >
              {previewSource && canRenderProjectionInHost && markdownProjection ? (
                <ProjectedMarkdownView
                  plan={markdownProjection}
                  commentHighlights={renderedCommentHighlights}
                  headingAnchors={headingAnchors}
                  onActivateCommentThread={onActivateCommentThread}
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
              {!previewSource && (
                <p className="text-muted-foreground italic">Double-click to edit</p>
              )}
              {renderedSourceCommentTarget ? (
                <CommentSelectionAffordance
                  className="absolute z-20"
                  style={{
                    left: renderedSourceCommentTarget.left,
                    top: renderedSourceCommentTarget.top,
                  }}
                  label="Add comment on selected markdown"
                  testId="markdown-source-comment-button"
                  onActivate={handleRenderedSourceCommentClick}
                />
              ) : null}
            </div>
          </RenderedMarkdownContextMenu>
        </>
      }
    />
  );
});
