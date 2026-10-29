/** Keep catalog order and identity intact while filtering display titles. */
export function matchingPages(pages, query) {
  const needle = query.trim().toLocaleLowerCase();
  return pages.filter((page) => (page.title || "Untitled").toLocaleLowerCase().includes(needle));
}

/** Follow list_pages cursors for the switcher. A Page moved by an edit during
 * pagination can appear twice; the first (newest) occurrence wins. */
export async function listAllPages(call, { limit = 100, maxRequests = 10 } = {}) {
  const seen = new Set();
  const pages = [];
  let first, cursor;
  for (let request = 0; request < maxRequests; request++) {
    const result = await call("list_pages", { limit, ...(cursor ? { cursor } : {}) });
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
