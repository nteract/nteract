// Viewer experiments that are off unless this browser opts in. A flag reads
// from the page URL first (`?glide=1`), then from this browser's localStorage
// under `pages.<name>` (`localStorage["pages.glide"] = "1"`). Flags belong to
// the browser, never the Page.

/** The raw value of a flag, or null when neither source sets it. */
export function readFlag(name, browser = globalThis) {
  try {
    const value = new URLSearchParams(browser?.location?.search ?? "").get(name);
    if (value !== null) return value;
  } catch {
    // A sandboxed or synthetic location has no query to read.
  }
  try {
    return browser?.localStorage?.getItem(`pages.${name}`) ?? null;
  } catch {
    // Embedded and private browsers can refuse storage.
    return null;
  }
}

const enabled = (value) => ["1", "true", "on", "yes"].includes(value?.trim().toLowerCase());

function integer(value, fallback, max) {
  if (value === null || value.trim() === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= max ? number : fallback;
}

function easing(value, fallback, browser) {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 120) return fallback;
  const supports = browser?.CSS?.supports;
  if (typeof supports === "function")
    return supports.call(browser.CSS, "transition-timing-function", candidate)
      ? candidate
      : fallback;
  return /^[a-z0-9\-().,\s]+$/i.test(candidate) ? candidate : fallback;
}

/**
 * Agent caret glide: when an agent's next write batch lands somewhere new, its
 * caret glides from the old position to the new one and a faint ghost fades at
 * the old position. Off by default. Knobs, each as `?name=value` or
 * `localStorage["pages.<name>"]`:
 *
 * - `glide`          `1` turns it on.
 * - `glide.duration` glide length in ms (default 280; 0 = jump, ghost only).
 * - `glide.easing`   a CSS easing (default `cubic-bezier(.2,.7,.2,1)`).
 * - `glide.maxJump`  px; a longer move skips the glide and ghost and the caret
 *                    just appears (default 900; 0 = always glide).
 * - `glide.ghost`    ghost fade in ms (default 600; 0 = no ghost).
 *
 * `prefers-reduced-motion: reduce` turns off the glide and the ghost.
 */
export const GLIDE_DEFAULTS = Object.freeze({
  enabled: false,
  durationMs: 280,
  easing: "cubic-bezier(.2,.7,.2,1)",
  maxJumpPx: 900,
  ghostFadeMs: 600,
});

export function readGlideSettings(browser = globalThis) {
  if (!enabled(readFlag("glide", browser))) return GLIDE_DEFAULTS;
  return Object.freeze({
    enabled: true,
    durationMs: integer(readFlag("glide.duration", browser), GLIDE_DEFAULTS.durationMs, 5000),
    easing: easing(readFlag("glide.easing", browser), GLIDE_DEFAULTS.easing, browser),
    maxJumpPx: integer(readFlag("glide.maxJump", browser), GLIDE_DEFAULTS.maxJumpPx, 100_000),
    ghostFadeMs: integer(readFlag("glide.ghost", browser), GLIDE_DEFAULTS.ghostFadeMs, 10_000),
  });
}

/**
 * Grid cards in the Pages library: `?grid=1` or `localStorage["pages.grid"]`.
 * Off by default; the library shows its list and no List/Grid toggle until
 * cards show previews. With it on, the toggle shows and the choice is
 * remembered (display-mode.mjs). `?grid=1` also asks for the grid itself
 * (readGridRequest): the tab opens on it, though the library's address then
 * drops the query, so a reload keeps the grid only with the stored flag.
 */
export const readGridFlag = (browser = globalThis) => enabled(readFlag("grid", browser));

/** Whether the page's own address asks for grid cards (`?grid=1`). Storage
 * turns the flag on but asks for nothing: it shows the toggle, and the
 * remembered choice decides. */
export function readGridRequest(browser = globalThis) {
  try {
    return enabled(new URLSearchParams(browser?.location?.search ?? "").get("grid"));
  } catch {
    return false;
  }
}

let tabGrid = null;
/** Whether this tab shows grid cards. Read once, like glideSettings. */
export function gridEnabled() {
  tabGrid ??= readGridFlag(globalThis);
  return tabGrid;
}

let tabGridRequest = null;
/** Whether this tab's first address asked for the grid. Read once, like
 * gridEnabled. */
export function gridRequested() {
  tabGridRequest ??= readGridRequest(globalThis);
  return tabGridRequest;
}

let tabGlide = null;
/** The glide settings this tab opened with. In-app navigation drops the query,
 * so the first read is kept; reload to pick up a localStorage change. */
export function glideSettings() {
  tabGlide ??= readGlideSettings(globalThis);
  return tabGlide;
}
