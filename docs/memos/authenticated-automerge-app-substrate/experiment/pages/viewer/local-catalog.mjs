// The local Page catalog in IndexedDB: one JSON record per Page this browser
// holds for an account. Listing and forgetting Pages read and write JSON only,
// so the viewer shell imports this module without loading Automerge or
// Subduction WASM. local-pages.mjs owns the snapshot reads and merges, through
// this module's one store instance.
import { IndexedDBByteStore } from "@automerge/automerge-repo-subduction";

export const store = new IndexedDBByteStore({ database: "pages-local-catalog-v1" });
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
const prefix = (identity) => `account/${encodeURIComponent(identity.principal)}/`;
export const key = (identity, pageId) => `${prefix(identity)}${pageId}`;

export async function listLocalPages(identity, { pendingOnly = false } = {}) {
  if (!identity?.principal) return [];
  const keys = await store.list(prefix(identity));
  const pages = await Promise.all(
    keys.map(async (key) => {
      const value = await store.load(key);
      return value ? JSON.parse(decoder.decode(value)) : null;
    }),
  );
  return pages
    .filter(
      (page) =>
        page?.principal === identity.principal &&
        !page.deleted &&
        // A local replica of a trashed Page is kept for restore; Trash lists it.
        !page.access?.trashed &&
        (!pendingOnly || page.pending),
    )
    .map(({ page_id, title, created_at, updated_at, pending, registered }) => ({
      page_id,
      title,
      created_at,
      updated_at,
      pending,
      registered,
    }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
export async function forgetLocalPage(identity, pageId) {
  if (identity?.principal)
    await store.save(
      key(identity, pageId),
      encoder.encode(
        JSON.stringify({
          principal: identity.principal,
          page_id: pageId,
          deleted: true,
        }),
      ),
    );
}
