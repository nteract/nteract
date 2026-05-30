import type { EditorView } from "@codemirror/view";
import { Pencil } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditableMarkdownCell } from "@/components/cell/EditableMarkdownCell";
import type { CodeMirrorEditorRef } from "@/components/editor/codemirror-editor";
import { remoteCursorsExtension } from "@/components/editor/remote-cursors";
import { searchHighlight } from "@/components/editor/search-highlight";
import { textAttributionExtension } from "@/components/editor/text-attribution";
import type { MarkdownHeadingAnchor } from "@/components/outputs/markdown-heading-anchors";
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
import { shouldStartMarkdownEditMode } from "@/components/cell/markdown-editor-keymap";
import { rewriteMarkdownAssetRefs } from "../lib/markdown-assets";
import { openUrl } from "../lib/open-url";
import { presenceSenderExtension } from "../lib/presence-sender";
import type { MarkdownCell as MarkdownCellType } from "../types";
import { CellPresenceIndicators } from "./cell/CellPresenceIndicators";

const EMPTY_HEADING_ANCHORS: readonly MarkdownHeadingAnchor[] = [];

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

  const blobResolver = useBlobResolver();
  const renderedSource = useMemo(
    () => rewriteMarkdownAssetRefs(cell.source, cell.resolvedAssets, blobResolver),
    [blobResolver, cell.resolvedAssets, cell.source],
  );
  const markdownMetadata = useMemo(
    () =>
      headingAnchors.length > 0
        ? {
            nteractMarkdownHeadingAnchors: headingAnchors,
          }
        : undefined,
    [headingAnchors],
  );

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

  const rightGutter = editing ? (
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
  );

  return (
    <EditableMarkdownCell
      id={cell.id}
      source={cell.source}
      renderedSource={renderedSource}
      markdownMetadata={markdownMetadata}
      editing={editing}
      onEditingChange={setEditing}
      editorRef={editorRef}
      isFocused={isFocused}
      isPreviousCellFromFocused={isPreviousCellFromFocused}
      isNextCellFromFocused={isNextCellFromFocused}
      onFocus={onFocus}
      focusPreview={isFocused}
      previewClassName="py-2 cursor-text outline-none"
      rightGutterContent={rightGutter}
      dragHandleProps={dragHandleProps}
      isDragging={isDragging}
      editorExtensions={[crdtBridgeExt, ...searchExtensions]}
      editorKeyMap={navigationKeyMap}
      searchQuery={searchQuery || ""}
      onPreviewKeyDown={handleViewKeyDown}
      onLinkClick={handleLinkClick}
      onIframeMouseDown={onFocus}
      onDiagnostic={logNotebookIsolatedDiagnostic}
      presenceIndicators={<CellPresenceIndicators cellId={cell.id} />}
    />
  );
});
