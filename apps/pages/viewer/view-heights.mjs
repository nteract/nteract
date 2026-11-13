// The height each chart embed last drew at, so a reload reserves that room
// before the chart draws and the Page below it holds still. Like the library's
// folds (library-folds.mjs), this belongs to this browser, never the account's
// data.
//
// viewHeights is the only storage edge. One localStorage entry holds every
// remembered height, keyed by account (the signed-in principal), Page id and
// view id, as `[account, pageId, viewId, px]` rows ordered oldest written
// first and bounded to MAX_VIEW_HEIGHTS rows (the oldest goes first). An
// unknown account or Page remembers nothing. Reads are synchronous, so an
// embed has its reserve when it first renders.
export const VIEW_HEIGHTS_KEY = "nteract.pages.view-heights";
export const MAX_VIEW_HEIGHTS = 300;
/** Ids are short (a principal, a UUID, `view_<uuid>`); longer is not ours. */
export const MAX_VIEW_HEIGHT_ID_LENGTH = 128;
/** A remembered height past this is not a chart this browser drew. */
export const MAX_VIEW_HEIGHT_PX = 4000;
const VERSION = 1;

const validId = (id) =>
  typeof id === "string" && id.length > 0 && id.length <= MAX_VIEW_HEIGHT_ID_LENGTH;

/** `px` as a whole CSS px height, or null when it isn't one. */
export function viewHeight(px) {
  if (typeof px !== "number" || !Number.isFinite(px)) return null;
  const rounded = Math.round(px);
  return rounded > 0 && rounded <= MAX_VIEW_HEIGHT_PX ? rounded : null;
}

/** The stored rows, oldest written first, or none when storage is blocked,
 * empty or holds something this build doesn't read. */
function readRows(browser) {
  let raw = null;
  try {
    raw = browser?.localStorage?.getItem(VIEW_HEIGHTS_KEY) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const stored = JSON.parse(raw);
    if (stored?.v !== VERSION || !Array.isArray(stored.heights)) return [];
    return stored.heights
      .filter(
        (row) =>
          Array.isArray(row) &&
          row.length === 4 &&
          validId(row[0]) &&
          validId(row[1]) &&
          validId(row[2]) &&
          viewHeight(row[3]) === row[3],
      )
      .slice(-MAX_VIEW_HEIGHTS);
  } catch {
    return [];
  }
}

/**
 * The remembered heights of `account`'s charts on Page `pageId`:
 * `{ read(viewId) }` returns the height in CSS px or null, and
 * `{ write(viewId, px) }` remembers a new one and returns the whole px it
 * kept (null for a height it refuses). Storage that refuses a write loses
 * only the memory; the chart still draws. Null when the account or Page is
 * unknown.
 */
export function viewHeights(browser, { account, pageId } = {}) {
  if (!validId(account) || !validId(pageId)) return null;
  const matches = (viewId) => (row) => row[0] === account && row[1] === pageId && row[2] === viewId;
  return Object.freeze({
    read(viewId) {
      if (!validId(viewId)) return null;
      return readRows(browser).find(matches(viewId))?.[3] ?? null;
    },
    write(viewId, px) {
      const height = viewHeight(px);
      if (!validId(viewId) || height === null) return null;
      const rows = readRows(browser);
      const same = matches(viewId);
      if (rows.at(-1) && same(rows.at(-1)) && rows.at(-1)[3] === height) return height;
      const next = [...rows.filter((row) => !same(row)), [account, pageId, viewId, height]];
      try {
        browser?.localStorage?.setItem(
          VIEW_HEIGHTS_KEY,
          JSON.stringify({ v: VERSION, heights: next.slice(-MAX_VIEW_HEIGHTS) }),
        );
      } catch {
        // Embedded and private browsers draw charts without the memory.
      }
      return height;
    },
  });
}
