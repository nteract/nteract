import { navigateMarkdownHeading } from "@/components/cell/markdown-heading-navigation";
import type { NotebookOutlineItem } from "runtimed";
import { documentAnchorForOutlineItem, type DocumentAnchor } from "./document-anchors";
import { scrollElementIntoView } from "./scroll-anchors";

export interface NavigateNotebookOutlineItemOptions {
  behavior?: ScrollBehavior;
  block?: ScrollLogicalPosition;
  documentAnchors?: readonly DocumentAnchor[];
  findCellElement?: (item: NotebookOutlineItem, href: string) => HTMLElement | null;
  headingHashTarget?: "heading" | "cell";
  updateHash?: boolean;
}

export function navigateNotebookOutlineItem(
  item: NotebookOutlineItem,
  href: string,
  options: NavigateNotebookOutlineItemOptions = {},
): boolean {
  if (!href.startsWith("#")) return false;

  const documentAnchor = options.documentAnchors
    ? documentAnchorForOutlineItem(item, options.documentAnchors)
    : null;
  const target = options.findCellElement
    ? options.findCellElement(item, href)
    : defaultFindCellElement(item, href, documentAnchor);
  if (!target) return false;

  const behavior = options.behavior ?? "smooth";
  const block = options.block ?? "start";

  if (item.headingAnchorId) {
    void navigateMarkdownHeading(item.cellId, item.headingAnchorId, { behavior }).then(
      (handled) => {
        if (!handled) {
          scrollElementIntoView(target, { block, behavior });
        }
      },
    );
  } else {
    scrollElementIntoView(target, { block, behavior });
  }

  if (options.updateHash ?? true) {
    const hash =
      item.headingAnchorId && options.headingHashTarget === "cell" ? `#${item.cellAnchorId}` : href;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${hash}`,
    );
  }

  return true;
}

function defaultFindCellElement(
  item: NotebookOutlineItem,
  href: string,
  documentAnchor: DocumentAnchor | null,
): HTMLElement | null {
  if (documentAnchor) {
    const target = document.getElementById(documentAnchor.domId);
    if (target) return target;
  }

  const targetId = item.headingAnchorId ? item.cellAnchorId : href.slice(1);
  return document.getElementById(targetId);
}
