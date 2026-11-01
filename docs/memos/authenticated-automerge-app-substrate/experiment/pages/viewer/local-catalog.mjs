// The local Page catalog in IndexedDB: one JSON record per Page this browser
// holds for an account. Listing and retiring Pages read and write JSON only,
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
        // An access marker holds no copy; its recovery records stay unlisted.
        !page.revoked &&
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
/** The grant generation a replica key names ("3:writer" is 3). An unknown
 * key compares as no generation, which no comparison finds newer. */
export function grantGeneration(replicaKey) {
  const match = /^(\d+):/.exec(typeof replicaKey === "string" ? replicaKey : "");
  return match ? Number(match[1]) : NaN;
}
/** The grant of this account's stored checkpoint, `{ grant, revision }`
 * (its replica key and grant revision), or undefined. */
export async function readLocalGrant(identity, pageId) {
  if (!identity?.principal) return undefined;
  const value = await store.load(key(identity, pageId));
  if (!value) return undefined;
  const page = JSON.parse(decoder.decode(value));
  if (page.principal !== identity.principal) return undefined;
  return { grant: page.replicaKey, revision: page.grant_revision };
}
/** The host access revision a readable grant carries, or undefined. */
export const grantRevisionOf = (access) =>
  access?.canRead && Number.isSafeInteger(access.revision) ? access.revision : undefined;
/** `next` with `grant_revision`: the highest readable grant revision any
 * writer of this entry held, or none when no writer reported one. */
export function withGrantRevision(next, ...sources) {
  const revisions = sources
    .flatMap((source) => [source?.grant_revision, grantRevisionOf(source?.access)])
    .filter(Number.isSafeInteger);
  const { grant_revision: _, ...rest } = next;
  return revisions.length ? { ...rest, grant_revision: Math.max(...revisions) } : rest;
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
 * replica's, which can hold edits the stored checkpoint lacks.
 * `comments_snapshot` is the live replica's comments document, which holds
 * its comments, unsent ones included, and `comments_document_id` names it.
 * The stored checkpoint carries its own pair, so every record holds both
 * documents. The live copy is archived when either document differs from the
 * stored one. `drafts` are unsent comment drafts from the UI: they ride on
 * the last record archived here, or on a record of their own.
 *
 * A deletion marker is permanent. An access marker records only identity: the
 * next checkpoint written with `regrant` (a host-verified open) replaces it,
 * and every other write archives its snapshot and fails with
 * LOCAL_PAGE_REVOKED. With nothing stored and nothing to archive, an access
 * refusal writes nothing.
 *
 * `grant` is the replica key the refused session opened under and
 * `revision` the host access revision it last held. The stored entry belongs
 * to a newer grant when its replica key names a later member generation, or
 * its `grant_revision` (writeLocalPage) is greater: company sharing and owner
 * access stay at generation 0 and change only the revision. Then the refusal
 * is stale for it: only the caller's own copy and drafts are archived, the
 * entry keeps its content and grant fields, and no marker is written. A field
 * either side lacks, such as a legacy entry's `grant_revision`, never makes
 * the entry newer.
 *
 * Everything lands in one transaction, the entry's advanced
 * `recovery_sequence` included, so later archives sort after these. Resolves
 * with the marker, `{ superseded: true }` for a newer grant's entry, or null.
 */
export async function retireLocalPage(
  identity,
  pageId,
  {
    reason,
    snapshot,
    title,
    drafts,
    grant,
    revision,
    comments_snapshot: commentsSnapshot,
    comments_document_id: commentsDocumentId,
  } = {},
) {
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
        // A marker names no grant. A newer grant's entry can be its reset
        // marker, before that grant's first checkpoint.
        const superseded =
          !!previous &&
          !previous.deleted &&
          !previous.revoked &&
          (grantGeneration(previous.replicaKey) > grantGeneration(grant) ||
            (Number.isSafeInteger(previous.grant_revision) &&
              Number.isSafeInteger(revision) &&
              previous.grant_revision > revision));
        const copies = [];
        if (previous?.snapshot && !superseded) copies.push({ ...previous, retired: reason });
        // The live copy's comments are its own. Without them, it keeps the
        // stored checkpoint's, unless that belongs to a newer grant.
        const {
          comments_snapshot: storedComments,
          comments_document_id: storedCommentsId,
          comment_saved_heads: _,
          ...liveBase
        } = base;
        const liveComments = commentsSnapshot
          ? {
              comments_snapshot: commentsSnapshot,
              comments_document_id: commentsDocumentId ?? storedCommentsId,
            }
          : !superseded && storedComments
            ? { comments_snapshot: storedComments, comments_document_id: storedCommentsId }
            : {};
        if (
          snapshot &&
          (snapshot !== previous?.snapshot ||
            (commentsSnapshot !== undefined && commentsSnapshot !== storedComments))
        )
          copies.push({
            ...liveBase,
            ...(title !== undefined && { title }),
            snapshot,
            ...liveComments,
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
        if (superseded) {
          if (copies.length)
            records.put(
              encoder.encode(JSON.stringify({ ...previous, recovery_sequence: sequence })),
              key(identity, pageId),
            );
          done({ superseded: true });
          return;
        }
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
