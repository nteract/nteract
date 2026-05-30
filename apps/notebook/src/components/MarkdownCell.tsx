import type { EditorView, KeyBinding } from "@codemirror/view";
import { Pencil } from "lucide-react";
import {
  memo,
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
import { injectPluginsForMimes } from "@/components/isolated/iframe-libraries";
import { findVerticalScrollAncestor } from "@/components/isolated/scroll-boundary";
import type { MarkdownHeadingAnchor } from "@/components/outputs/markdown-heading-anchors";
import { useColorTheme, useDarkMode } from "@/lib/dark-mode";
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
} from "../lib/cell-ui-state";
import { onEditorRegistered, onEditorUnregistered } from "../lib/cursor-registry";
import { registerCellEditor, unregisterCellEditor } from "../lib/editor-registry";
import { logNotebookIsolatedDiagnostic } from "../lib/isolated-diagnostics";
import { logger } from "../lib/logger";
import {
  isMeasuredElementFound,
  registerMarkdownHeadingNavigator,
} from "@/components/cell/markdown-heading-navigation";
import {
  createMarkdownFormattingKeyMap,
  shouldStartMarkdownEditMode,
} from "@/components/cell/markdown-editor-keymap";
import { rewriteMarkdownAssetRefs } from "../lib/markdown-assets";
import { openUrl } from "../lib/open-url";
import { presenceSenderExtension } from "../lib/presence-sender";
import type { MarkdownCell as MarkdownCellType } from "../types";
import { CellPresenceIndicators } from "./cell/CellPresenceIndicators";

const handleIframeError = (err: { message: string; stack?: string }) =>
  logger.error("[MarkdownCell] iframe error:", err);
const EMPTY_HEADING_ANCHORS: readonly MarkdownHeadingAnchor[] = [];

function formatPluginLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface MarkdownCellProps {
  cell: MarkdownCellType;
  onFocus: () => void;
  onDelete: () => void;
  onFocusPrevious?: (cursorPosition: "start" | "end") => void;
  onFocusNext?: (cursorPosition: "start" | "end") => void;
  onInsertCellAfter?: () => void;
  isLastCell?: boolean;
  /** Props for dnd-kit drag handle (applied to ribbon) */
  dragHandleProps?: Record<string, unknown>;
  /** Whether this cell is currently being dragged */
  isDragging?: boolean;
  /** Content for the right gutter (e.g., delete button) */
  rightGutterContent?: ReactNode;
  headingAnchors?: readonly MarkdownHeadingAnchor[];
}

export const MarkdownCell = memo(function MarkdownCell({
  cell,
  onFocus,
  onDelete,
  onFocusPrevious,
  onFocusNext,
  onInsertCellAfter,
  isLastCell = false,
  dragHandleProps,
  isDragging,
  rightGutterContent,
  headingAnchors = EMPTY_HEADING_ANCHORS,
}: MarkdownCellProps) {
  const isFocused = useIsCellFocused(cell.id);
  const isPreviousCellFromFocused = useIsPreviousCellFromFocused(cell.id);
  const isNextCellFromFocused = useIsNextCellFromFocused(cell.id);
  const searchQuery = useSearchQuery();
  const [editing, setEditing] = useState(shouldStartMarkdownEditMode(cell.source));
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const presence = usePresenceContext();
  const { extension: crdtBridgeExt } = useCrdtBridge(cell.id);
  const frameRef = useRef<IsolatedFrameHandle>(null);
  const injectedLibsRef = useRef(new Set<string>());
  const viewRef = useRef<HTMLDivElement>(null);
  const [previewFrameInteractionActive, setPreviewFrameInteractionActive] = useState(false);

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
  const markdownMetadata = useMemo(
    () =>
      headingAnchors.length > 0
        ? {
            nteractMarkdownHeadingAnchors: headingAnchors,
          }
        : undefined,
    [headingAnchors],
  );

  const handleDoubleClick = useCallback(() => {
    setEditing(true);
  }, []);

  const activatePreviewFrameInteraction = useCallback(() => {
    setPreviewFrameInteractionActive(true);
    onFocus();
  }, [onFocus]);

  const deactivatePreviewFrameInteractionWhenIdle = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      if (!(event.buttons > 0)) {
        setPreviewFrameInteractionActive(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isFocused || editing) {
      setPreviewFrameInteractionActive(false);
    }
  }, [isFocused, editing]);

  const handleBlur = useCallback(() => {
    if (cell.source.trim()) {
      setEditing(false);
    }
  }, [cell.source]);

  // Render markdown content when iframe is ready
  const handleFrameReady = useCallback(async () => {
    if (!frameRef.current || !cell.source) return;
    // Ensure theme is in sync before re-rendering (fixes theme drift after cell moves)
    frameRef.current.setTheme(darkModeRef.current, colorThemeRef.current ?? null);
    // Clear injected set — a reloaded iframe has a fresh renderer registry
    injectedLibsRef.current.clear();
    // Inject markdown renderer plugin before rendering (idempotent, cached after first load)
    try {
      await injectPluginsForMimes(frameRef.current, ["text/markdown"], injectedLibsRef.current);
    } catch (error) {
      logger.warn("[MarkdownCell] Failed to load markdown renderer plugin:", error);
      frameRef.current.render({
        mimeType: "text/plain",
        data: `Failed to load markdown renderer: ${formatPluginLoadError(error)}`,
        outputId: `markdown-error:${cell.id}`,
        cellId: cell.id,
        replace: true,
      });
      return;
    }
    const processedSource = rewriteMarkdownAssetRefs(
      cell.source,
      cell.resolvedAssets,
      blobResolver,
    );
    frameRef.current.render({
      mimeType: "text/markdown",
      data: processedSource,
      metadata: markdownMetadata,
      outputId: `markdown:${cell.id}`,
      cellId: cell.id,
      replace: true,
    });
  }, [cell.source, cell.id, cell.resolvedAssets, blobResolver, markdownMetadata]);

  // Sync markdown to iframe whenever source or resolved assets change (supports RTC updates)
  useEffect(() => {
    if (frameRef.current?.isReady && cell.source) {
      const frame = frameRef.current;
      // Inject markdown renderer plugin (idempotent) then render
      injectPluginsForMimes(frame, ["text/markdown"], injectedLibsRef.current)
        .then(() => {
          const processedSource = rewriteMarkdownAssetRefs(
            cell.source,
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
        })
        .catch((error) => {
          logger.warn("[MarkdownCell] Failed to load markdown renderer plugin:", error);
          frame.render({
            mimeType: "text/plain",
            data: `Failed to load markdown renderer: ${formatPluginLoadError(error)}`,
            outputId: `markdown-error:${cell.id}`,
            cellId: cell.id,
            replace: true,
          });
        });
    }
  }, [cell.source, cell.id, cell.resolvedAssets, blobResolver, markdownMetadata]);

  const scrollToHeading = useCallback(
    async (headingAnchorId: string, options?: { behavior?: ScrollBehavior }) => {
      if (editing || !headingAnchorId || !frameRef.current?.isReady) return false;

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
        // Enter: enter edit mode
        setEditing(true);
        e.preventDefault();
      }
    },
    [onFocusNext, onFocusPrevious],
  );

  // Handle focus next, creating a new cell if at the end
  const handleFocusNextOrCreate = useCallback(
    (cursorPosition: "start" | "end") => {
      // For markdown, close edit mode first
      if (cell.source.trim()) {
        setEditing(false);
      }
      if (isLastCell && onInsertCellAfter) {
        onInsertCellAfter();
      } else if (onFocusNext) {
        onFocusNext(cursorPosition);
      }
    },
    [cell.source, isLastCell, onFocusNext, onInsertCellAfter],
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
          setEditing(false);
          return true;
        },
      },
      ...navigationKeyMap,
      {
        key: "Escape",
        run: () => {
          if (cell.source.trim()) {
            setEditing(false);
          }
          return true;
        },
      },
      ...createMarkdownFormattingKeyMap(),
    ],
    [navigationKeyMap, cell.source],
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
    if (!editing && frameRef.current?.isReady) {
      frameRef.current.search(searchQuery || "");
    }
  }, [searchQuery, editing]);

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
        editing ? (
          rightGutterContent
        ) : (
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setEditing(true)}
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
                keyMap={keyMap}
                extensions={[crdtBridgeExt, ...searchExtensions]}
                placeholder="Enter markdown..."
                className="min-h-[2rem]"
                autoFocus={editing}
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
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleViewKeyDown}
          >
            {/* Always render IsolatedFrame to preload it (hidden when no content) */}
            <div
              className={cell.source ? undefined : "hidden"}
              onPointerDown={activatePreviewFrameInteraction}
              onPointerOut={deactivatePreviewFrameInteractionWhenIdle}
            >
              <IsolatedFrame
                ref={frameRef}
                name={`md-${cell.id}`}
                darkMode={darkMode}
                colorTheme={colorTheme}
                minHeight={24}
                autoHeight
                scrollPassthrough={!previewFrameInteractionActive}
                allowWheelBoundaryScroll={previewFrameInteractionActive}
                revealOnRender
                onReady={handleFrameReady}
                onLinkClick={handleLinkClick}
                onMouseDown={activatePreviewFrameInteraction}
                onDoubleClick={handleDoubleClick}
                onError={handleIframeError}
                onDiagnostic={logNotebookIsolatedDiagnostic}
                className="w-full"
              />
            </div>
            {!cell.source && <p className="text-muted-foreground italic">Double-click to edit</p>}
          </div>
        </>
      }
    />
  );
});
