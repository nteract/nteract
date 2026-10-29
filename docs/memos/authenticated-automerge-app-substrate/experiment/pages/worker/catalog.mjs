/** A host-owned, last-observed title projection. Owned listings avoid opening documents; shared references are checked by the host. */
export function catalogTitle(title) {
  return typeof title === "string" ? title.slice(0, 500) : "Untitled";
}
export async function listCatalog(storage) {
  const [entries, shared] = await Promise.all([
    storage.list({ prefix: "page/", limit: 100 }),
    storage.list({ prefix: "shared/", limit: 100 }),
  ]);
  return [...entries.values(), ...shared.values()]
    .filter((entry) => !entry.pending)
    .map(({ page_id, title, created_at, updated_at, shared }) => ({
      page_id,
      title: catalogTitle(title),
      created_at,
      updated_at,
      ...(shared ? { shared: true } : {}),
    }));
}
export async function refreshCatalogTitle(storage, { page_id, title, observed_at }) {
  const key = `page/${page_id}`;
  const entry = await storage.get(key);
  // A late title update must never resurrect a deleted page or overwrite a
  // more recently observed projection. Ownership lives in the Page, not here.
  if (!entry || entry.pending || (entry.updated_at && entry.updated_at > observed_at)) return;
  if (entry.title !== title) await storage.put(key, { ...entry, title, updated_at: observed_at });
}
