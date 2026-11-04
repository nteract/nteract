/** Keep catalog order and identity intact while filtering display titles. */
export function matchingPages(pages, query) {
  const needle = query.trim().toLocaleLowerCase();
  return pages.filter((page) => (page.title || "Untitled").toLocaleLowerCase().includes(needle));
}

/** Follow list_pages cursors for the switcher. A Page moved by an edit during
 * pagination can appear twice; the first (newest) occurrence wins. Once
 * `signal` aborts, no further page is asked for and the walk rejects with its
 * reason. Every page must name the same `principal` as the first; a walk that
 * changes account partway rejects. */
export async function listAllPages(call, { limit = 100, maxRequests = 10, signal } = {}) {
  const seen = new Set();
  const pages = [];
  let first, cursor;
  for (let request = 0; request < maxRequests; request++) {
    signal?.throwIfAborted();
    const result = await call("list_pages", { limit, ...(cursor ? { cursor } : {}) });
    signal?.throwIfAborted();
    if (first && result.principal !== first.principal)
      throw Error("The account changed while Pages were listed. Try again.");
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
