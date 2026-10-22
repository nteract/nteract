import { navigateMarkdownHeading } from "@/components/cell/markdown-heading-navigation";
import type { DocumentAnchor } from "./document-anchors";
import { scrollElementIntoView } from "./scroll-anchors";

/**
 * Resolve an in-notebook link (`#…`) to a document anchor. Matches an anchor id
 * (`#notebook-cell-<id>`, heading and output anchors) first, then a heading's
 * own slug (`#load-the-data`), which is what hand-written links usually use.
 */
export function documentAnchorForFragment(
  href: string,
  anchors: readonly DocumentAnchor[],
): DocumentAnchor | null {
  if (!href.startsWith("#") || href.length === 1) return null;
  const id = decodeFragment(href.slice(1));

  return (
    anchors.find((anchor) => anchor.id === id) ??
    anchors.find(
      (anchor) => anchor.kind === "markdown_heading" && anchor.markdownAnchorSlug === id,
    ) ??
    null
  );
}

/** Scroll to a document anchor, falling back to its cell when the heading
 * navigator can't place a heading (rendered inside an isolated frame, or hidden
 * while its cell is in edit mode). */
export function navigateDocumentAnchor(
  anchor: DocumentAnchor,
  options: { behavior?: ScrollBehavior } = {},
): boolean {
  const cell = document.getElementById(anchor.cellAnchorId);
  const target = document.getElementById(anchor.domId) ?? cell;
  if (!target) return false;

  const behavior = options.behavior ?? "smooth";
  if (anchor.kind === "markdown_heading" && anchor.markdownHeadingAnchorId) {
    void navigateMarkdownHeading(anchor.cellId, anchor.markdownHeadingAnchorId, { behavior }).then(
      (handled) => {
        // An editing cell keeps its preview mounted but hidden, so the heading
        // element can exist without a visible box; scroll the cell instead.
        if (!handled) {
          scrollElementIntoView(cell ?? target, { block: "start", behavior });
        }
      },
    );
  } else {
    scrollElementIntoView(target, { block: "start", behavior });
  }
  return true;
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}
