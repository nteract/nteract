// The local Page catalog in IndexedDB: one JSON record per Page this browser
// holds for an account. Listing and retiring Pages read and write JSON only,
// so the viewer shell imports this module without loading Automerge or
// Subduction WASM. local-pages.mjs owns the snapshot reads and merges, through
// this module's one store instance.
import { IndexedDBByteStore } from "@automerge/automerge-repo-subduction";
import { readRefusalFence } from "./refusal-fence.mjs";

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
        // An access marker holds no copy; its recovery records stay unlisted.
        !page.revoked &&
        // A refused copy whose archive failed stays out of sight too.
        !readRefusalFence(identity, page.page_id) &&
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
const recoveryKey = (identity, pageId) =>
  `recovery/${encodeURIComponent(identity.principal)}/${pageId}/${crypto.randomUUID()}`;
/** Add one recovery record for `page` inside a readwrite transaction.
 * `sequence` orders records written across tabs. */
export function archiveSnapshot(records, identity, page, sequence) {
  records.put(
    encoder.encode(
      JSON.stringify({
        ...page,
        recovery_sequence: sequence,
        archived_at: new Date().toISOString(),
      }),
    ),
    recoveryKey(identity, page.page_id),
  );
}

/**
 * Move this account's local copy of a Page into the recovery archive and leave
 * a marker in its place, so nothing renders the copy again. `reason` is
 * `access` (the host refused this account) or `deleted` (the Page is gone,
 * including a permanent deletion from Trash). `snapshot` is the live
 * replica's, which can hold edits the stored checkpoint lacks; both are
 * archived when they differ. `drafts` are unsent comment drafts from the UI:
 * they ride on the last record archived here, or on a record of their own.
 *
 * A deletion marker is permanent. An access marker records only identity: the
 * next checkpoint written with `regrant` (a host-verified open) replaces it,
 * and every other write archives its snapshot and fails with
 * LOCAL_PAGE_REVOKED. With nothing stored and nothing to archive, an access
 * refusal writes nothing. Everything lands in one transaction. Resolves with
 * the marker, or null.
 */
export async function retireLocalPage(identity, pageId, { reason, snapshot, title, drafts } = {}) {
  if (!identity?.principal) throw Error("Local Page account does not match");
  if (reason !== "access" && reason !== "deleted") throw Error("Unknown retirement reason");
  return store.run("readwrite", (records, done, fail) => {
    const request = records.get(key(identity, pageId));
    request.onsuccess = () => {
      try {
        const previous = request.result ? JSON.parse(decoder.decode(request.result)) : null;
        if (previous && (previous.principal !== identity.principal || previous.page_id !== pageId))
          throw Error("Local Page account does not match");
        let sequence = previous?.recovery_sequence ?? 0;
        const base = previous ?? { principal: identity.principal, page_id: pageId };
        const copies = [];
        if (previous?.snapshot) copies.push({ ...previous, retired: reason });
        if (snapshot && snapshot !== previous?.snapshot)
          copies.push({
            ...base,
            ...(title !== undefined && { title }),
            snapshot,
            retired: reason,
          });
        if (drafts?.length) {
          if (copies.length) copies[copies.length - 1].comment_drafts = drafts;
          else
            copies.push({
              principal: identity.principal,
              page_id: pageId,
              ...(base.title !== undefined && { title: base.title }),
              comment_drafts: drafts,
              retired: reason,
            });
        }
        for (const copy of copies) archiveSnapshot(records, identity, copy, ++sequence);
        let marker;
        if (previous?.deleted || reason === "deleted")
          marker = {
            principal: identity.principal,
            page_id: pageId,
            deleted: true,
            recovery_sequence: sequence,
          };
        else if (previous || copies.length)
          marker = {
            principal: identity.principal,
            page_id: pageId,
            ...(base.document_id && { document_id: base.document_id }),
            revoked: true,
            recovery_sequence: sequence,
          };
        if (marker) records.put(encoder.encode(JSON.stringify(marker)), key(identity, pageId));
        done(marker ?? null);
      } catch (error) {
        fail(error);
      }
    };
    return request;
  });
}
