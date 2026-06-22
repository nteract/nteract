import type { EditorView } from "@codemirror/view";
import { ClipboardPaste, Code2, Copy, FileText, Scissors } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { CommentMarkIcon } from "@/components/comments/CommentMarkIcon";
import {
  NotebookContextMenu,
  type NotebookContextMenuAction,
  type NotebookContextMenuGroup,
} from "@/components/notebook/NotebookContextMenu";
import {
  selectionRectFromView,
  sourceRangeAnchorFromSelection,
  type SourceCommentSelectionRect,
  type SourceRangeCommentAnchor,
} from "../lib/comment-source-anchor";
import { getCellEditor } from "../lib/editor-registry";

interface EditorSelectionRange {
  from: number;
  to: number;
  empty: boolean;
}

interface EditorContextMenuProps {
  cellId: string;
  cellType: "code" | "markdown" | "raw";
  readOnly?: boolean;
  onChangeCellType?: (type: "code" | "markdown") => void;
  onCreateSourceComment?: (
    anchor: SourceRangeCommentAnchor,
    rect: SourceCommentSelectionRect | null,
    quote?: string | null,
  ) => void;
  children: ReactNode;
}

export interface BuildEditorContextGroupsOptions {
  editable: boolean;
  hasSelection: boolean;
  canComment: boolean;
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: () => void;
  onAddComment?: () => void;
  cellType?: "code" | "markdown" | "raw";
  onChangeCellType?: (type: "code" | "markdown") => void;
}

export function buildEditorContextGroups({
  editable,
  hasSelection,
  canComment,
  onCopy,
  onCut,
  onPaste,
  onAddComment,
  cellType,
  onChangeCellType,
}: BuildEditorContextGroupsOptions): NotebookContextMenuGroup[] {
  const actions: NotebookContextMenuAction[] = [];

  if (hasSelection) {
    actions.push({
      id: "copy",
      label: "Copy",
      icon: <Copy className="size-4" aria-hidden="true" />,
      shortcut: "⌘C",
      onSelect: onCopy,
    });
  }

  if (editable && hasSelection) {
    actions.push({
      id: "cut",
      label: "Cut",
      icon: <Scissors className="size-4" aria-hidden="true" />,
      shortcut: "⌘X",
      onSelect: onCut,
    });
  }

  if (editable) {
    actions.push({
      id: "paste",
      label: "Paste",
      icon: <ClipboardPaste className="size-4" aria-hidden="true" />,
      shortcut: "⌘V",
      onSelect: onPaste,
    });
  }

  if (editable && hasSelection && canComment) {
    actions.push({
      id: "add-comment",
      label: "Add comment",
      icon: <CommentMarkIcon className="size-4" aria-hidden="true" />,
      shortcut: "C",
      separatorBefore: actions.length > 0,
      onSelect: onAddComment,
    });
  }

  if (onChangeCellType && (cellType === "markdown" || cellType === "raw")) {
    actions.push({
      id: "change-to-code",
      label: "Change to Code",
      icon: <Code2 className="size-4" aria-hidden="true" />,
      separatorBefore: actions.length > 0,
      onSelect: () => onChangeCellType("code"),
    });
  }

  if (onChangeCellType && (cellType === "code" || cellType === "raw")) {
    actions.push({
      id: "change-to-markdown",
      label: "Change to Markdown",
      icon: <FileText className="size-4" aria-hidden="true" />,
      separatorBefore: actions.length > 0,
      onSelect: () => onChangeCellType("markdown"),
    });
  }

  if (actions.length === 0) return [];

  return [
    {
      id: "editor",
      actions,
    },
  ];
}

export function EditorContextMenu({
  cellId,
  cellType,
  readOnly,
  onChangeCellType,
  onCreateSourceComment,
  children,
}: EditorContextMenuProps) {
  const [groups, setGroups] = useState<NotebookContextMenuGroup[]>([]);

  const refreshGroups = useCallback(() => {
    const view = getCellEditor(cellId);
    const selection = view?.state.selection.main;
    const hasSelection = !!selection && !selection.empty;
    const editable = !readOnly;

    setGroups(
      buildEditorContextGroups({
        editable,
        hasSelection,
        canComment: !!onCreateSourceComment,
        onCopy: view && selection ? () => copySelection(view, selection) : undefined,
        onCut: editable && view && selection ? () => cutSelection(view, selection) : undefined,
        onPaste: editable && view ? () => pasteIntoSelection(view) : undefined,
        cellType: onChangeCellType ? cellType : undefined,
        onChangeCellType,
        onAddComment:
          editable && view && onCreateSourceComment
            ? () => {
                const anchor = sourceRangeAnchorFromSelection(cellId, view);
                if (!anchor) return;
                onCreateSourceComment(anchor, selectionRectFromView(view));
              }
            : undefined,
      }),
    );
  }, [cellId, cellType, onChangeCellType, onCreateSourceComment, readOnly]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) refreshGroups();
    },
    [refreshGroups],
  );

  return (
    <NotebookContextMenu groups={groups} contentClassName="w-48" onOpenChange={handleOpenChange}>
      <div className="w-full min-w-0" onContextMenuCapture={refreshGroups}>
        {children}
      </div>
    </NotebookContextMenu>
  );
}

function copySelection(view: EditorView, selection: EditorSelectionRange): void {
  if (selection.empty) return;
  const clipboard = currentClipboard();
  if (!clipboard) return;

  const selectedText = view.state.sliceDoc(selection.from, selection.to);
  if (!selectedText) return;
  void clipboard.writeText(selectedText).catch(() => undefined);
}

function cutSelection(view: EditorView, selection: EditorSelectionRange): void {
  if (selection.empty) return;
  const clipboard = currentClipboard();
  if (!clipboard) return;

  const selectedText = view.state.sliceDoc(selection.from, selection.to);
  if (!selectedText) return;

  void clipboard
    .writeText(selectedText)
    .then(() => {
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: "" },
      });
      view.focus();
    })
    .catch(() => undefined);
}

function pasteIntoSelection(view: EditorView): void {
  const clipboard = currentClipboard();
  if (!clipboard) return;

  void clipboard
    .readText()
    .then((text) => {
      if (!text) return;
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    })
    .catch(() => undefined);
}

function currentClipboard(): Clipboard | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.clipboard;
}
