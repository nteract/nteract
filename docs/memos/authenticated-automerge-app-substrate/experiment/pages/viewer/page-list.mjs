/** Keep catalog order and identity intact while filtering display titles. */
export function matchingPages(pages, query) {
  const needle = query.trim().toLocaleLowerCase();
  return pages.filter((page) => (page.title || "Untitled").toLocaleLowerCase().includes(needle));
}
