import type { EditorView, KeyBinding } from "@codemirror/view";
import {
  memo,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  const [editing, setEditing] = useState(cell.source === "");
  const [previewFrameInteractionActive, setPreviewFrameInteractionActive] = useState(false);
  const editorRef = useRef<CodeMirrorEditorRef>(null);
  const presence = usePresenceContext();
  const { extension: crdtBridgeExt } = useCrdtBridge(cell.id);
  const blobResolver = useBlobResolver();

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

  const markdownMetadata = useMemo(
    () =>
      headingAnchors.length > 0
        ? {
            nteractMarkdownHeadingAnchors: headingAnchors,
          }
        : undefined,
    [headingAnchors],
  );
  const previewSource = useMemo(
    () => rewriteMarkdownAssetRefs(cell.source, cell.resolvedAssets, blobResolver),
    [cell.resolvedAssets, cell.source, blobResolver],
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

  const handleFocusNextOrCreate = useCallback(
    (cursorPosition: "start" | "end") => {
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

  const navigationKeyMap = useCellKeyboardNavigation({
    onFocusPrevious: onFocusPrevious ?? (() => {}),
    onFocusNext: handleFocusNextOrCreate,
    onExecute: () => {}, // No-op for markdown, enables Shift+Enter navigation
    onDelete,
    cellId: cell.id,
  });

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
      cell.source,
      applyInlineFormatting,
      applyLinkFormatting,
      applyQuoteFormatting,
    ],
  );

  const editorExtensions = useMemo(
    () => [crdtBridgeExt, ...searchExtensions],
    [crdtBridgeExt, searchExtensions],
  );
  const handlePreviewLinkClick = useCallback((url: string) => {
    openUrl(url);
  }, []);

  const handlePreviewPointerDown = useCallback(
    (_event?: PointerEvent<HTMLDivElement>) => {
      setPreviewFrameInteractionActive(true);
      onFocus();
    },
    [onFocus],
  );

  const handlePreviewPointerOut = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    if (!(event.buttons > 0)) {
      setPreviewFrameInteractionActive(false);
    }
  }, []);

  const handlePreviewKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowDown") {
        onFocusNext?.("start");
        event.preventDefault();
        return true;
      }
      if (event.key === "ArrowUp") {
        onFocusPrevious?.("end");
        event.preventDefault();
        return true;
      }
      if (event.key === "Enter" && event.ctrlKey && !event.metaKey && !event.altKey) {
        setEditing(false);
        event.preventDefault();
        return true;
      }
      if (
        event.key === "Enter" &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        onFocusNext?.("start");
        event.preventDefault();
        return true;
      }
      return false;
    },
    [onFocusNext, onFocusPrevious],
  );

  const handleEditingChange = useCallback((nextEditing: boolean) => {
    setEditing(nextEditing);
    if (nextEditing) {
      setPreviewFrameInteractionActive(false);
    }
  }, []);
  const handlePreviewIframeDoubleClick = useCallback(() => {
    handleEditingChange(true);
  }, [handleEditingChange]);

  useEffect(() => {
    if (!isFocused || editing) {
      setPreviewFrameInteractionActive(false);
    }
  }, [isFocused, editing]);

  return (
    <EditableMarkdownCell
      id={cell.id}
      source={cell.source}
      editing={editing}
      onEditingChange={handleEditingChange}
      editorRef={editorRef}
      isFocused={isFocused}
      onFocus={onFocus}
      isPreviousCellFromFocused={isPreviousCellFromFocused}
      isNextCellFromFocused={isNextCellFromFocused}
      dragHandleProps={dragHandleProps}
      isDragging={isDragging}
      previewSource={previewSource}
      previewOutputId={`markdown:${cell.id}`}
      previewFrameName={`md-${cell.id}`}
      previewMetadata={markdownMetadata}
      previewSearchQuery={searchQuery || ""}
      previewFocused={previewFrameInteractionActive}
      keepPreviewMounted
      previewLabel="Markdown cell content"
      onPreviewKeyDown={handlePreviewKeyDown}
      onPreviewLinkClick={handlePreviewLinkClick}
      onPreviewPointerDown={handlePreviewPointerDown}
      onPreviewPointerOut={handlePreviewPointerOut}
      onPreviewIframeMouseDown={handlePreviewPointerDown}
      onPreviewIframeDoubleClick={handlePreviewIframeDoubleClick}
      editorKeyMap={keyMap}
      editorExtensions={editorExtensions}
      placeholder="Enter markdown..."
      editorClassName="min-h-[2rem]"
      editorHeaderContent={
        <div className="flex items-center gap-1 py-1">
          <span className="text-xs text-muted-foreground font-mono">md</span>
        </div>
      }
      previewClassName="cursor-text outline-none"
      previewOutputClassName="py-2"
      presenceIndicators={<CellPresenceIndicators cellId={cell.id} />}
      rightGutterContent={rightGutterContent}
    />
  );
});
