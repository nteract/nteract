import * as A from "@automerge/automerge";
import { IndexedDBByteStore } from "@automerge/automerge-repo-subduction";

const store = new IndexedDBByteStore({ database: "pages-local-catalog-v1" });
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const prefix = (identity) => `account/${encodeURIComponent(identity.principal)}/`;
const key = (identity, pageId) => `${prefix(identity)}${pageId}`;

export function encodeSnapshot(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function decodeSnapshot(value) {
  return Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
}
export async function readLocalPage(identity, pageId) {
  if (!identity?.principal) return null;
  const value = await store.load(key(identity, pageId));
  if (!value) return null;
  const page = JSON.parse(decoder.decode(value));
  if (page.principal !== identity.principal || page.page_id !== pageId)
    throw Error("Local Page account does not match");
  return page.deleted ? null : page;
}
export async function writeLocalPage(identity, page) {
  if (!identity?.principal || page.principal !== identity.principal)
    throw Error("Local Page account does not match");
  // Cache checkpoints are shared by independent tab replicas. Merge inside one
  // IndexedDB transaction so a slower tab cannot overwrite another draft's
  // unsynced history. Native per-tab databases remain the live storage owners.
  return store.run("readwrite", (records, done, fail) => {
    const request = records.get(key(identity, page.page_id));
    request.onsuccess = () => {
      try {
        let next = page;
        if (request.result) {
          const previous = JSON.parse(decoder.decode(request.result));
          // A deletion occupies this same key permanently. IndexedDB serializes
          // these read/write transactions across tabs, so an older checkpoint
          // can neither replace the marker nor recreate a forgotten Page.
          if (previous.deleted)
            throw Object.assign(Error("Page was deleted"), {
              code: "LOCAL_PAGE_DELETED",
              status: 410,
            });
          if (previous.document_id !== page.document_id)
            throw Error("Local Page document identity does not match");
          next = { ...page, registered: previous.registered || page.registered };
          if (previous.snapshot !== page.snapshot) {
            const incoming = A.load(decodeSnapshot(page.snapshot));
            const existing = A.load(decodeSnapshot(previous.snapshot));
            if (!A.hasHeads(incoming, A.getHeads(existing))) {
              const merged = A.merge(incoming, existing);
              next = {
                ...next,
                snapshot: encodeSnapshot(A.save(merged)),
                title: merged.title,
                pending: true,
              };
            }
          }
        }
        records.put(encoder.encode(JSON.stringify(next)), key(identity, page.page_id));
        done(next);
      } catch (error) {
        fail(error);
      }
    };
    return request;
  });
}
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
        page?.principal === identity.principal && !page.deleted && (!pendingOnly || page.pending),
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
