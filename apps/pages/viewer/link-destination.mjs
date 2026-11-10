// No Automerge here: the shell's boot preview (PagePreview.jsx) draws links
// with linkAttributes' class before the editor chunk loads.
import { safeUrl } from "../model/marks.mjs";
import { linkedTarget } from "../shared/page-links.mjs";

// Opening is stricter than markup parsing: resolve relative links first and
// never let a generic document writer navigate to an executable scheme.
export function linkDestination(href, base) {
  if (!href || !safeUrl(href)) return null;
  try {
    const url = new URL(href, base);
    return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** The class a link to another of this deployment's Pages draws with. CSS
 * draws its Page glyph (wordgard.css), and the hover card finds it by this
 * class and `data-page-id` (PageLinkCard.jsx). */
export const PAGE_LINK_CLASS = "page-link";
/** The class a link to one of this deployment's Projects draws with, beside
 * `data-project-id`: CSS draws the Project glyph, and the hover card finds
 * it the same way. */
export const PROJECT_LINK_CLASS = "project-link";

/** The class and data attribute a target (shared/page-links.mjs
 * linkTarget) draws with. */
export function targetAttributes(target) {
  if (target?.kind === "page") return { class: PAGE_LINK_CLASS, "data-page-id": target.pageId };
  if (target?.kind === "project")
    return { class: PROJECT_LINK_CLASS, "data-project-id": target.projectId };
  return {};
}

/**
 * The attributes a link mark draws with, in Page blocks and in comments: its
 * resolved href and title, opening in a new tab, or none for a link that
 * doesn't resolve. A link to another of this deployment's Pages or to one of
 * its Projects (shared/page-links.mjs linkedTarget) also gets the kind's
 * class and data attribute (targetAttributes). The link text never changes.
 * `currentPageId` is the Page open now, whose links are section links, and
 * `currentProjectId` the Project whose content is open now; without them,
 * what `base` shows.
 */
export function linkAttributes(
  value,
  { base = globalThis.location?.href, currentPageId = null, currentProjectId = null } = {},
) {
  const href = linkDestination(value?.href, base);
  if (!href) return {};
  const target = linkedTarget(href, base, { currentPageId, currentProjectId });
  return {
    href,
    title: value.title ?? "",
    target: "_blank",
    rel: "noopener noreferrer",
    ...targetAttributes(target),
  };
}

/** True for a click that asks for a new tab: Command-click on macOS,
 * Ctrl-click elsewhere, or a middle click. Browsers don't follow links
 * inside an editable document, so the editor opens these itself. */
export function wantsNewTab(event) {
  if (event.button === 1) return true;
  return event.button === 0 && (event.metaKey || event.ctrlKey) && !event.altKey;
}

/** Open a resolved link in a new tab without giving it a handle on this one. */
export function openInNewTab(href, open = globalThis.open) {
  if (!href) return false;
  open?.(href, "_blank", "noopener,noreferrer");
  return true;
}
