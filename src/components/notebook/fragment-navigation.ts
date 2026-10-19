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

/** Scroll to a document anchor, falling back to its cell when the anchor itself
 * is not in this document (headings rendered inside an isolated frame). */
export function navigateDocumentAnchor(
  anchor: DocumentAnchor,
  options: { behavior?: ScrollBehavior } = {},
): boolean {
  const target =
    document.getElementById(anchor.domId) ?? document.getElementById(anchor.cellAnchorId);
  if (!target) return false;

  const behavior = options.behavior ?? "smooth";
  if (anchor.kind === "markdown_heading" && anchor.markdownHeadingAnchorId) {
    void navigateMarkdownHeading(anchor.cellId, anchor.markdownHeadingAnchorId, { behavior }).then(
      (handled) => {
        if (!handled) {
          scrollElementIntoView(target, { block: "start", behavior });
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
