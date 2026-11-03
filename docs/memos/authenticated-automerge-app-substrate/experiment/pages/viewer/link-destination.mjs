import { safeUrl } from "../model/richtext.mjs";

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
