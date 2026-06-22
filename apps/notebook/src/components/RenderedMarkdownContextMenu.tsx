import { Code2, Copy } from "lucide-react";
import { useCallback, useState, type ReactNode, type RefObject } from "react";
import { CommentMarkIcon } from "@/components/comments/CommentMarkIcon";
import {
  NotebookContextMenu,
  type NotebookContextMenuAction,
  type NotebookContextMenuGroup,
} from "@/components/notebook/NotebookContextMenu";
import {
  resolveSourceRangeAnchor,
  selectionRectFromDomSelection,
  type SourceCommentSelectionRect,
  type SourceRangeCommentAnchor,
} from "../lib/comment-source-anchor";
import {
  renderedTextForSourceRange,
  type MarkdownProjectionPlan,
} from "../lib/markdown-projection";
import { sourceRangeAnchorFromRenderedMarkdownSelection } from "../lib/rendered-markdown-source-comment";

interface RenderedMarkdownContextMenuProps {
  cellId: string;
  source: string;
  markdownProjection: MarkdownProjectionPlan | null;
  viewRef: RefObject<HTMLDivElement | null>;
  onCreateSourceComment?: (
    anchor: SourceRangeCommentAnchor,
    rect: SourceCommentSelectionRect | null,
    quote?: string | null,
  ) => void;
  onChangeCellType?: (type: "code" | "markdown") => void;
  children: ReactNode;
}

export interface BuildRenderedMarkdownContextGroupsOptions {
  hasSelection: boolean;
  canComment: boolean;
  onCopy?: () => void;
  onAddComment?: () => void;
  onChangeCellType?: (type: "code" | "markdown") => void;
}

export interface RenderedMarkdownClipboardPayload {
  text: string;
  html: string;
}

export function buildRenderedMarkdownContextGroups({
  hasSelection,
  canComment,
  onCopy,
  onAddComment,
  onChangeCellType,
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
      icon: <CommentMarkIcon className="size-4" aria-hidden="true" />,
      shortcut: "C",
      separatorBefore: actions.length > 0,
      onSelect: onAddComment,
    });
  }

  if (onChangeCellType) {
    actions.push({
      id: "change-to-code",
      label: "Change to Code",
      icon: <Code2 className="size-4" aria-hidden="true" />,
      separatorBefore: actions.length > 0,
      onSelect: () => onChangeCellType("code"),
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
  markdownProjection,
  viewRef,
  onCreateSourceComment,
  onChangeCellType,
  children,
}: RenderedMarkdownContextMenuProps) {
  const [groups, setGroups] = useState<NotebookContextMenuGroup[]>([]);

  const refreshGroups = useCallback(() => {
    const root = viewRef.current;
    const selection = currentDomSelection();
    const hasSelection = !!root && selectionIsInsideRoot(root, selection);
    const selectedText = hasSelection ? (selection?.toString() ?? "") : "";
    const selectionRange = hasSelection && selection?.rangeCount ? selection.getRangeAt(0) : null;
    const anchor = root
      ? sourceRangeAnchorFromRenderedMarkdownSelection(cellId, source, root, selection)
      : null;
    const clipboardPayload = buildRenderedMarkdownClipboardPayload({
      anchor,
      selectedText,
      range: selectionRange,
    });

    setGroups(
      buildRenderedMarkdownContextGroups({
        hasSelection,
        canComment: !!anchor && !!onCreateSourceComment,
        onCopy: clipboardPayload ? () => copyRenderedSelection(clipboardPayload) : undefined,
        onChangeCellType,
        onAddComment:
          anchor && onCreateSourceComment
            ? () => {
                const range = resolveSourceRangeAnchor(source, anchor);
                const quote = range
                  ? renderedTextForSourceRange(markdownProjection, range.from, range.to)
                  : null;
                onCreateSourceComment(
                  anchor,
                  selectionRectFromDomSelection(currentDomSelection()),
                  quote,
                );
              }
            : undefined,
      }),
    );
  }, [cellId, markdownProjection, onChangeCellType, onCreateSourceComment, source, viewRef]);

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

export function buildRenderedMarkdownClipboardPayload({
  anchor,
  selectedText,
  range,
}: {
  anchor: SourceRangeCommentAnchor | null;
  selectedText: string;
  range: Range | null;
}): RenderedMarkdownClipboardPayload | null {
  const text = anchor?.exact_quote ?? selectedText;
  if (text.length === 0) return null;
  return {
    text,
    html: range ? cleanRenderedMarkdownClipboardHtml(range) : "",
  };
}

export function cleanRenderedMarkdownClipboardHtml(range: Range): string {
  const container = document.createElement("div");
  container.append(range.cloneContents());

  container.querySelectorAll("a").forEach((anchor) => {
    const label = anchor.getAttribute("aria-label") ?? "";
    const href = anchor.getAttribute("href") ?? "";
    if (
      anchor.textContent?.trim() === "#" &&
      href.startsWith("#") &&
      label.startsWith("Link to ")
    ) {
      anchor.remove();
    }
  });

  container.querySelectorAll("ul, ol, li").forEach((element) => {
    element.classList.remove(
      "list-disc",
      "list-decimal",
      "marker:text-primary/65",
      "marker:font-semibold",
    );
    const existingStyle = element.getAttribute("style");
    const markerlessStyle = "list-style-type: none";
    element.setAttribute(
      "style",
      existingStyle ? `${existingStyle}; ${markerlessStyle}` : markerlessStyle,
    );
  });

  return container.innerHTML;
}

function copyRenderedSelection(payload: RenderedMarkdownClipboardPayload): void {
  const clipboard = currentClipboard();
  if (!clipboard) return;

  if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
    const item = new ClipboardItem({
      "text/plain": new Blob([payload.text], { type: "text/plain" }),
      "text/html": new Blob([payload.html], { type: "text/html" }),
    });
    void clipboard.write([item]).catch(() => {
      void clipboard.writeText(payload.text).catch(() => undefined);
    });
    return;
  }

  void clipboard.writeText(payload.text).catch(() => undefined);
}

function currentDomSelection(): Selection | null {
  if (typeof window === "undefined") return null;
  return window.getSelection();
}

function currentClipboard(): Clipboard | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.clipboard;
}
