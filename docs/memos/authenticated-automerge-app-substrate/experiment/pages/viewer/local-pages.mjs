import * as A from "@automerge/automerge";
import { mergeLocalEdits } from "./local-edits.mjs";
import {
  archiveSnapshot,
  decoder,
  encoder,
  key,
  store,
  withGrantRevision,
} from "./local-catalog.mjs";
export { listLocalPages, retireLocalPage } from "./local-catalog.mjs";
const accessChanged = () =>
  Object.assign(Error("Page access changed in another tab; your draft is kept locally"), {
    code: "LOCAL_PAGE_ACCESS_CHANGED",
    status: 409,
  });
const pageDeleted = () =>
  Object.assign(Error("Page was deleted"), { code: "LOCAL_PAGE_DELETED", status: 410 });
const accessRevoked = () =>
  Object.assign(
    Error("You no longer have access to this Page; its local copy is in the recovery archive"),
    { code: "LOCAL_PAGE_REVOKED", status: 403 },
  );

// Retire the previous key's cache without importing its potentially unaccepted
// edits into a new signer. Retired snapshots remain separate recovery records.
export async function prepareLocalPageReload(identity, page, access, replicaKey) {
  if (!identity?.principal || identity.principal !== page.principal)
    throw Error("Local Page account does not match");
  return store.run("readwrite", (records, done, fail) => {
    const request = records.get(key(identity, page.page_id));
    request.onsuccess = () => {
      try {
        const previous = request.result ? JSON.parse(decoder.decode(request.result)) : page;
        if (previous.deleted) throw pageDeleted();
        if (previous.revoked) throw accessRevoked();
        if ((previous.access?.revision ?? 0) > access.revision) throw accessChanged();
        let sequence = previous.recovery_sequence ?? 0;
        if (previous.snapshot) archiveSnapshot(records, identity, previous, ++sequence);
        if (page.snapshot && page.snapshot !== previous.snapshot)
          archiveSnapshot(records, identity, page, ++sequence);
        const next = withGrantRevision(
          {
            ...previous,
            recovery_sequence: sequence,
            access,
            replicaKey,
            resetReplica: true,
            pending: false,
            canWrite: false,
            snapshot: undefined,
          },
          previous,
          { access },
        );
        records.put(encoder.encode(JSON.stringify(next)), key(identity, page.page_id));
        done(next);
      } catch (error) {
        fail(error);
      }
    };
    return request;
  });
}
export async function listLocalRecoveries(identity, pageId) {
  if (!identity?.principal) return [];
  const keys = await store.list(`recovery/${encodeURIComponent(identity.principal)}/${pageId}/`);
  const records = await Promise.all(
    keys.map(async (key) => JSON.parse(decoder.decode(await store.load(key)))),
  );
  // The transaction-owned sequence orders same-millisecond archives across tabs.
  return records.sort(
    (a, b) =>
      (a.recovery_sequence ?? 0) - (b.recovery_sequence ?? 0) ||
      (a.archived_at ?? a.updated_at ?? "").localeCompare(b.archived_at ?? b.updated_at ?? ""),
  );
}

export function encodeSnapshot(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function decodeSnapshot(value) {
  return Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
}
/** The stored checkpoint, or null. A deletion or access marker
 * (retireLocalPage) reads as null unless `markers` asks for it. */
export async function readLocalPage(identity, pageId, { markers = false } = {}) {
  if (!identity?.principal) return null;
  const value = await store.load(key(identity, pageId));
  if (!value) return null;
  const page = JSON.parse(decoder.decode(value));
  if (page.principal !== identity.principal || page.page_id !== pageId)
    throw Error("Local Page account does not match");
  return (page.deleted || page.revoked) && !markers ? null : page;
}
/** Write a checkpoint, merging it into the stored one. `replica` is the
 * writing session's native replica; it decides that replica's localEdits
 * entries (local-edits.mjs). `regrant` says the host has just verified this
 * account's access, so the checkpoint may replace an access marker. */
export async function writeLocalPage(identity, page, { replica, regrant = false } = {}) {
  if (!identity?.principal || page.principal !== identity.principal)
    throw Error("Local Page account does not match");
  // Cache checkpoints are shared by independent tab replicas. Merge inside one
  // IndexedDB transaction so a slower tab cannot overwrite another draft's
  // unsynced history. Native per-tab databases remain the live storage owners.
  const result = await store.run("readwrite", (records, done, fail) => {
    const request = records.get(key(identity, page.page_id));
    request.onsuccess = () => {
      try {
        let next = { ...page };
        const stored = request.result ? JSON.parse(decoder.decode(request.result)) : undefined;
        if (stored) {
          const previous = stored;
          // A deletion occupies this same key permanently. IndexedDB serializes
          // these read/write transactions across tabs, so an older checkpoint
          // can neither replace the marker nor recreate a forgotten Page.
          if (previous.deleted) throw pageDeleted();
          if (previous.revoked) {
            // Only a host-verified open replaces an access marker. Any other
            // writer is a tab that hasn't seen the refusal yet: keep its
            // copy beside the others, then report the refusal.
            if (regrant) {
              const next = withGrantRevision(
                { ...page, recovery_sequence: previous.recovery_sequence ?? 0 },
                page,
              );
              delete next.registrationSupersedes;
              records.put(encoder.encode(JSON.stringify(next)), key(identity, page.page_id));
              done(next);
              return;
            }
            const sequence = (previous.recovery_sequence ?? 0) + 1;
            if (page.snapshot) {
              archiveSnapshot(records, identity, { ...page, retired: "access" }, sequence);
              records.put(
                encoder.encode(JSON.stringify({ ...previous, recovery_sequence: sequence })),
                key(identity, page.page_id),
              );
            }
            done({ revoked: true });
            return;
          }
          if (previous.document_id !== page.document_id)
            throw Error("Local Page document identity does not match");
          // A delayed writer from a retired grant must not merge its old history
          // back into the current grant's checkpoint. Commit a recovery copy,
          // then report the mismatch after the transaction has completed.
          if (previous.replicaKey && previous.replicaKey !== page.replicaKey) {
            const sequence = (previous.recovery_sequence ?? 0) + 1;
            archiveSnapshot(records, identity, page, sequence);
            records.put(
              encoder.encode(JSON.stringify({ ...previous, recovery_sequence: sequence })),
              key(identity, page.page_id),
            );
            done({ accessChanged: true });
            return;
          }
          next = {
            ...page,
            registered: previous.registered || page.registered,
            // Independent tabs may prepare different tokens concurrently. The
            // first stored registration wins; every tab sends that exact body.
            ...(previous.registration?.retry_token &&
              (previous.registered ||
                page.registrationSupersedes !== previous.registration.idempotency_key) && {
                registration: previous.registration,
              }),
            recovery_sequence: previous.recovery_sequence ?? 0,
          };
          if (
            (previous.access?.revision ?? -1) > (page.access?.revision ?? -1) ||
            ((previous.access?.revision ?? -1) === (page.access?.revision ?? -1) &&
              previous.access?.role === "none")
          )
            next = { ...next, access: previous.access, canWrite: false };
          let diverged = false;
          if (!previous.resetReplica && previous.snapshot !== page.snapshot) {
            const incoming = A.load(decodeSnapshot(page.snapshot));
            const existing = A.load(decodeSnapshot(previous.snapshot));
            if (!A.hasHeads(incoming, A.getHeads(existing))) {
              diverged = true;
              const merged = A.merge(incoming, existing);
              next = {
                ...next,
                snapshot: encodeSnapshot(A.save(merged)),
                title: merged.title,
                pending: true,
              };
            }
          }
          // Which edits are this browser's own survives every checkpoint
          // write, including a slower tab's (local-edits.mjs).
          const localEdits = mergeLocalEdits(previous.localEdits, page.localEdits, {
            diverged,
            replica,
          });
          if (localEdits) next = { ...next, localEdits };
        }
        // Which host grant the checkpoint belongs to: the highest readable
        // access revision its writers held. A refused writer never raises it.
        next = withGrantRevision(next, stored, page);
        // The compare-and-swap authority is only for this checkpoint write;
        // stale tabs must explicitly reconcile before replacing another token.
        delete next.registrationSupersedes;
        records.put(encoder.encode(JSON.stringify(next)), key(identity, page.page_id));
        done(next);
      } catch (error) {
        fail(error);
      }
    };
    return request;
  });
  if (result?.accessChanged) throw accessChanged();
  if (result?.revoked) throw accessRevoked();
  return result;
}
