/** Keep catalog order and identity intact while filtering display titles. */
export function matchingPages(pages, query) {
  const needle = query.trim().toLocaleLowerCase();
  return pages.filter((page) => (page.title || "Untitled").toLocaleLowerCase().includes(needle));
}

/** The code of the error a walk rejects with when its pages name different
 * accounts: another window signed in partway. */
export const ACCOUNT_CHANGED = "ACCOUNT_CHANGED";

/** Follow list_pages cursors for the switcher. A Page moved by an edit during
 * pagination can appear twice; the first (newest) occurrence wins. `signal`
 * goes with each request (request.mjs `tool`), so cancelling aborts the one
 * in flight; no further page is asked for and the walk rejects with its
 * reason. Every page must name the same `principal` as the first; a walk that
 * changes account partway rejects with an ACCOUNT_CHANGED error. */
export async function listAllPages(call, { limit = 100, maxRequests = 10, signal } = {}) {
  const seen = new Set();
  const pages = [];
  let first, cursor;
  for (let request = 0; request < maxRequests; request++) {
    signal?.throwIfAborted();
    const result = await call("list_pages", { limit, ...(cursor ? { cursor } : {}) }, { signal });
    signal?.throwIfAborted();
    if (first && result.principal !== first.principal)
      throw Object.assign(Error("The account changed while Pages were listed. Try again."), {
        code: ACCOUNT_CHANGED,
      });
    first ??= result;
    for (const page of result.pages ?? []) {
      if (seen.has(page.page_id)) continue;
      seen.add(page.page_id);
      pages.push(page);
    }
    cursor = result.next_cursor;
    if (typeof cursor !== "string") break;
  }
  return { ...first, pages };
}
