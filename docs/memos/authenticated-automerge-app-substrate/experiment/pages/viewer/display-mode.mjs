// How /pages lays out its Pages: a columned list or a grid of cards. Like the
// theme (theme.mjs), the choice belongs to this browser, never the account.
export const DISPLAY_KEY = "nteract.pages.view";
export const DISPLAY_MODES = Object.freeze(["list", "grid"]);
export const DEFAULT_DISPLAY = "list";

/** The stored mode, or the default when storage is blocked, empty or holds
 * a value this build doesn't know. */
export function readDisplayMode(browser) {
  let stored = null;
  try {
    stored = browser?.localStorage?.getItem(DISPLAY_KEY) ?? null;
  } catch {
    stored = null;
  }
  return DISPLAY_MODES.includes(stored) ? stored : DEFAULT_DISPLAY;
}

/** Remember `mode` for this browser. Returns the mode to show: `mode` when
 * it is valid, even if storage refuses it, so the choice still holds for
 * this visit; otherwise null and nothing is written. */
export function writeDisplayMode(browser, mode) {
  if (!DISPLAY_MODES.includes(mode)) return null;
  try {
    browser?.localStorage?.setItem(DISPLAY_KEY, mode);
  } catch {
    // Embedded and private browsers can still switch for this visit.
  }
  return mode;
}
