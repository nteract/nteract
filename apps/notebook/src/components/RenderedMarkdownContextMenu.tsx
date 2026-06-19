import { Copy, MessageSquarePlus } from "lucide-react";
import { useCallback, useState, type ReactNode, type RefObject } from "react";
import {
  NotebookContextMenu,
  type NotebookContextMenuAction,
  type NotebookContextMenuGroup,
} from "@/components/notebook/NotebookContextMenu";
import {
  selectionRectFromDomSelection,
  type SourceCommentSelectionRect,
  type SourceRangeCommentAnchor,
} from "../lib/comment-source-anchor";
import { sourceRangeAnchorFromRenderedMarkdownSelection } from "../lib/rendered-markdown-source-comment";

interface RenderedMarkdownContextMenuProps {
  cellId: string;
  source: string;
  viewRef: RefObject<HTMLDivElement | null>;
  onCreateSourceComment?: (
    anchor: SourceRangeCommentAnchor,
    rect: SourceCommentSelectionRect | null,
  ) => void;
  children: ReactNode;
}

export interface BuildRenderedMarkdownContextGroupsOptions {
  hasSelection: boolean;
  canComment: boolean;
  onCopy?: () => void;
  onAddComment?: () => void;
}

export function buildRenderedMarkdownContextGroups({
  hasSelection,
  canComment,
  onCopy,
  onAddComment,
}: BuildRenderedMarkdownContextGroupsOptions): NotebookContextMenuGroup[] {
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

  if (hasSelection && canComment) {
    actions.push({
      id: "add-comment",
      label: "Add comment",
      icon: <MessageSquarePlus className="size-4" aria-hidden="true" />,
      shortcut: "C",
      separatorBefore: actions.length > 0,
      onSelect: onAddComment,
    });
  }

  if (actions.length === 0) return [];

  return [
    {
      id: "rendered-markdown",
      actions,
    },
  ];
}

export function RenderedMarkdownContextMenu({
  cellId,
  source,
  viewRef,
  onCreateSourceComment,
  children,
}: RenderedMarkdownContextMenuProps) {
  const [groups, setGroups] = useState<NotebookContextMenuGroup[]>([]);

  const refreshGroups = useCallback(() => {
    const root = viewRef.current;
    const selection = currentDomSelection();
    const hasSelection = !!root && selectionIsInsideRoot(root, selection);
    const selectedText = hasSelection ? (selection?.toString() ?? "") : "";
    const anchor = root
      ? sourceRangeAnchorFromRenderedMarkdownSelection(cellId, source, root, selection)
      : null;

    setGroups(
      buildRenderedMarkdownContextGroups({
        hasSelection,
        canComment: !!anchor && !!onCreateSourceComment,
        onCopy: hasSelection ? () => copyRenderedSelection(selectedText) : undefined,
        onAddComment:
          anchor && onCreateSourceComment
            ? () =>
                onCreateSourceComment(anchor, selectionRectFromDomSelection(currentDomSelection()))
            : undefined,
      }),
    );
  }, [cellId, onCreateSourceComment, source, viewRef]);

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

function selectionIsInsideRoot(root: HTMLElement, selection: Selection | null): boolean {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  if (selection.toString().length === 0) return false;

  const range = selection.getRangeAt(0);
  return root.contains(range.startContainer) && root.contains(range.endContainer);
}

function copyRenderedSelection(selectedText: string): void {
  const clipboard = currentClipboard();
  if (!clipboard || selectedText.length === 0) return;
  void clipboard.writeText(selectedText).catch(() => undefined);
}

function currentDomSelection(): Selection | null {
  if (typeof window === "undefined") return null;
  return window.getSelection();
}

function currentClipboard(): Clipboard | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.clipboard;
}
