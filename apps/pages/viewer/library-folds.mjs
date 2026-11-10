// Which library groups are folded. Like the display mode (display-mode.mjs),
// fold state belongs to this browser, never the account's data; it is kept
// per account and per grouping, by group key (library-groups.mjs). A Project
// group's key holds its Project ID, so renaming a Project keeps it folded.
//
// The functions over a fold list are pure; readFolds and writeFolds are the
// only storage edge. One localStorage entry holds every account's folds,
// bounded twice: at most MAX_FOLD_ACCOUNTS accounts (the least recently
// written goes first) and MAX_FOLDS keys per account and grouping (the oldest
// fold goes first). A fold list is ordered oldest first.
export const FOLDS_KEY = "nteract.pages.folds";
/** The groupings whose groups fold: LIBRARY_GROUPS without null. */
export const FOLD_KINDS = Object.freeze(["project", "date"]);
export const MAX_FOLD_ACCOUNTS = 4;
export const MAX_FOLDS = 100;
/** Group keys are short (`project:prj_<uuid>` is 44); longer is not ours. */
export const MAX_FOLD_KEY_LENGTH = 128;
const VERSION = 1;

export const NO_FOLDS = Object.freeze(
  Object.fromEntries(FOLD_KINDS.map((kind) => [kind, Object.freeze([])])),
);

const validKey = (key) =>
  typeof key === "string" && key.length > 0 && key.length <= MAX_FOLD_KEY_LENGTH;

/** `keys` as a fold list: valid keys, each once (its latest place), at most
 * MAX_FOLDS of the newest. */
export function boundFolds(keys) {
  if (!Array.isArray(keys)) return Object.freeze([]);
  const latest = new Map();
  keys.forEach((key, index) => {
    if (!validKey(key)) return;
    latest.delete(key);
    latest.set(key, index);
  });
  return Object.freeze([...latest.keys()].slice(-MAX_FOLDS));
}

/** `folds` with `key` folded when it was open, or opened when folded. A new
 * fold is the newest. */
export function toggleFold(folds, key) {
  if (!validKey(key)) return boundFolds(folds);
  return folds.includes(key)
    ? Object.freeze(folds.filter((entry) => entry !== key))
    : boundFolds([...folds, key]);
}

/** `folds` with every group in `shown` folded too. */
export const foldAll = (folds, shown) => boundFolds([...folds, ...shown]);

/** Nothing folded in this grouping, shown or not: Unfold all means every
 * group, including ones the library hasn't loaded yet. */
export const unfoldAll = () => Object.freeze([]);

/** Whether every group in `shown` is folded. */
export const allFolded = (folds, shown) =>
  shown.length > 0 && shown.every((key) => folds.includes(key));

/** Whether any group in `shown` is folded. */
export const anyFolded = (folds, shown) => shown.some((key) => folds.includes(key));

/** The stored accounts, oldest written first, or none when storage is blocked,
 * empty or holds something this build doesn't read. */
function readStore(browser) {
  let raw = null;
  try {
    raw = browser?.localStorage?.getItem(FOLDS_KEY) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const stored = JSON.parse(raw);
    if (stored?.v !== VERSION || !Array.isArray(stored.accounts)) return [];
    return stored.accounts
      .filter(
        (entry) =>
          Array.isArray(entry) &&
          validKey(entry[0]) &&
          entry[1] !== null &&
          typeof entry[1] === "object",
      )
      .slice(-MAX_FOLD_ACCOUNTS);
  } catch {
    return [];
  }
}

/** `account`'s folds for every grouping. An unknown account (null) has none
 * stored: its folds last as long as the screen. */
export function readFolds(browser, account) {
  if (!validKey(account)) return NO_FOLDS;
  const entry = readStore(browser).find(([name]) => name === account)?.[1] ?? {};
  return Object.freeze(
    Object.fromEntries(FOLD_KINDS.map((kind) => [kind, boundFolds(entry[kind])])),
  );
}

/** Remember `keys` as `account`'s folds under the `kind` grouping. Returns
 * the bounded list to show, even when storage refuses it, so the folds still
 * hold for this visit; null for a grouping that doesn't fold. */
export function writeFolds(browser, account, kind, keys) {
  if (!FOLD_KINDS.includes(kind)) return null;
  const folds = boundFolds(keys);
  if (!validKey(account)) return folds;
  const accounts = readStore(browser);
  const previous = accounts.find(([name]) => name === account)?.[1] ?? {};
  const entry = Object.fromEntries(
    FOLD_KINDS.map((name) => [name, name === kind ? folds : boundFolds(previous[name])]).filter(
      ([, list]) => list.length > 0,
    ),
  );
  const others = accounts.filter(([name]) => name !== account);
  const next = Object.keys(entry).length ? [...others, [account, entry]] : others;
  try {
    if (next.length === 0) browser?.localStorage?.removeItem(FOLDS_KEY);
    else
      browser?.localStorage?.setItem(
        FOLDS_KEY,
        JSON.stringify({ v: VERSION, accounts: next.slice(-MAX_FOLD_ACCOUNTS) }),
      );
  } catch {
    // Embedded and private browsers can still fold for this visit.
  }
  return folds;
}
