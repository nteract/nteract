// A refusal fence: a small record, kept outside IndexedDB, that says the host
// refused this account a Page. Retirement writes it before archiving the
// local copy and clears it once the archive's marker is written, so a failed
// archive still keeps the copy from rendering. PageSession.start() reads it
// before importing any checkpoint.
//
// The fence lives in localStorage, shared by the browser's tabs. Where that is
// missing or throws (Node, a locked-down profile) it falls back to memory,
// which still fences this tab. It holds the reason, the time and the
// comment drafts the failed archive couldn't keep, bounded so it stays small.

const PREFIX = "pages-refusal-fence/";
const MAX_DRAFT_BYTES = 32 * 1024;
const memory = new Map();

const keyOf = (identity, pageId) =>
  `${PREFIX}${encodeURIComponent(identity.principal)}/${encodeURIComponent(pageId)}`;

function storage() {
  try {
    const local = globalThis.localStorage;
    if (local && typeof local.getItem === "function") return local;
  } catch {}
  return undefined;
}

/** The fence for this account and Page, or undefined. */
export function readRefusalFence(identity, pageId) {
  if (!identity?.principal) return undefined;
  const key = keyOf(identity, pageId);
  let text;
  try {
    text = storage()?.getItem(key) ?? undefined;
  } catch {}
  text ??= memory.get(key);
  if (!text) return undefined;
  try {
    const fence = JSON.parse(text);
    return fence?.reason === "access" || fence?.reason === "deleted" ? fence : undefined;
  } catch {
    return undefined;
  }
}

/** Fence this account off the Page: `reason` is `access` or `deleted`. */
export function writeRefusalFence(identity, pageId, { reason, drafts } = {}) {
  if (!identity?.principal) return;
  const fence = { reason, at: new Date().toISOString() };
  if (drafts?.length && JSON.stringify(drafts).length <= MAX_DRAFT_BYTES)
    fence.comment_drafts = drafts;
  const key = keyOf(identity, pageId);
  const text = JSON.stringify(fence);
  memory.set(key, text);
  try {
    storage()?.setItem(key, text);
  } catch {}
}

export function clearRefusalFence(identity, pageId) {
  if (!identity?.principal) return;
  const key = keyOf(identity, pageId);
  memory.delete(key);
  try {
    storage()?.removeItem(key);
  } catch {}
}
