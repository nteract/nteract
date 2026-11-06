// How many of the editor's link menus (LinkPopover.jsx) are open in this tab.
// The Page-link card (page-link-card.mjs) closes when one opens and doesn't
// open while one shows. A count, not a flag: a menu that unmounts late never
// clears another's.
import { Store } from "./store.mjs";

export const linkMenus = new Store(0);

/** Count one open link menu; returns the function that uncounts it. */
export function linkMenuOpened(menus = linkMenus) {
  menus.update((open) => open + 1);
  let counted = true;
  return () => {
    if (!counted) return;
    counted = false;
    menus.update((open) => Math.max(0, open - 1));
  };
}
