import * as A from "@automerge/automerge";
import { threadsOf } from "../model/comments.mjs";

/** Host-owned Trash records and permanent-deletion previews.
 *
 * A trashed Page record keeps `deleted: true` (see pageState in access.mjs).
 * `trash` records who trashed it and when. Each trash record identifies its
 * root Page. This implementation trashes and restores individual Pages.
 * `lifecycleRevision` counts trash, restore and purge transitions.
 *
 * Retention: Trash has no automatic expiry. A Page stays in Trash until its
 * owner restores it or permanently deletes it.
 */
export const PURGE_PREVIEW_TTL_MS = 10 * 60 * 1000;
const TOKEN_PREFIX = "pp1";

export function trashRecord({ pageId, principal, now, receipt }) {
  return {
    trashed_at: now,
    trashed_by: principal,
    reason: "page",
    root_page_id: pageId,
    receipt,
  };
}

export function publicTrash(metadata) {
  const trash = metadata.trash;
  return {
    state: "trashed",
    trashed_at: trash.trashed_at,
    trashed_by: trash.trashed_by,
    trash_root_id: trash.root_page_id,
    reason: trash.reason,
  };
}

/** Members in `acl` who lose access when what it guards is permanently
 * deleted, in principal order. */
export function collaboratorsOf(acl) {
  return Object.entries(acl?.members ?? {})
    .filter(([, member]) => ["viewer", "commenter", "editor"].includes(member?.role))
    .map(([principal, member]) => ({
      principal,
      role: member.role,
      ...(typeof member.displayName === "string" && { display_name: member.displayName }),
      ...(typeof member.email === "string" && { email: member.email }),
    }))
    .sort((a, b) => a.principal.localeCompare(b.principal));
}

/** How many of `acl`'s invitations are still pending at `now`. */
export const pendingInvitations = (acl, now = Date.now()) =>
  Object.values(acl?.invites ?? {}).filter((invite) => invite?.expiresAt > now).length;

/** The discussion deleted with a document: `commentsDoc` is its comments
 * document. */
export function discussionOf(doc, commentsDoc) {
  const threads = Object.values(threadsOf(doc, commentsDoc));
  return {
    comment_threads: threads.length,
    comment_count: threads.reduce(
      (count, thread) =>
        count +
        Object.values(thread?.messages ?? {}).filter((message) => !message?.deletedAt).length,
      0,
    ),
  };
}

/** Collaborators who lose access when the Page is permanently deleted, and
 * the discussion deleted with it: `commentsDoc` is the Page's comments
 * document. */
export function purgeImpact(metadata, doc, commentsDoc) {
  return {
    title: typeof doc.title === "string" ? doc.title : "Untitled",
    ...discussionOf(doc, commentsDoc),
    collaborators: collaboratorsOf(metadata.acl),
    pending_invitations: pendingInvitations(metadata.acl),
    domain_view: metadata.acl?.domainView?.domain ?? null,
  };
}

const encoder = new TextEncoder();
const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const fromBase64url = (value) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );

async function previewKey(storage) {
  let secret = await storage.get("host/purge-preview-secret");
  if (!(secret instanceof Uint8Array) || secret.byteLength !== 32) {
    secret = crypto.getRandomValues(new Uint8Array(32));
    await storage.put("host/purge-preview-secret", secret);
  }
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** Everything a preview describes. Any change to it invalidates the token. */
function previewBinding(metadata, doc, principal) {
  return bindingOf({
    page: metadata.pageId,
    principal,
    heads: [...A.getHeads(doc)].sort(),
    acl: metadata.acl ?? null,
    trashed_at: metadata.trash.trashed_at,
    revision: metadata.lifecycleRevision ?? 0,
  });
}

/** A digest of `facts`: the state a deletion preview describes. */
export async function bindingOf(facts) {
  const bytes = encoder.encode(JSON.stringify(facts));
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** A preview token for `binding`, signed with this object's preview secret
 * and valid for PURGE_PREVIEW_TTL_MS. */
export async function issuePreviewToken(storage, binding, now = Date.now()) {
  const payload = { binding, expires_at: now + PURGE_PREVIEW_TTL_MS };
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await previewKey(storage), encoder.encode(body)),
  );
  return {
    preview_token: `${TOKEN_PREFIX}.${body}.${base64url(signature)}`,
    preview_expires_at: new Date(payload.expires_at).toISOString(),
  };
}

export async function issuePurgePreview(storage, metadata, doc, principal, now = Date.now()) {
  return issuePreviewToken(storage, await previewBinding(metadata, doc, principal), now);
}

/** Check a preview token against the current record and document:
 * `valid`, `invalid` (malformed or forged), `expired`, or `changed`. */
export async function checkPurgePreview(
  storage,
  metadata,
  doc,
  principal,
  token,
  now = Date.now(),
) {
  return checkPreviewToken(storage, await previewBinding(metadata, doc, principal), token, now);
}

/** Check a preview token against the binding of the current state: `valid`,
 * `invalid` (malformed or forged), `expired`, or `changed`. */
export async function checkPreviewToken(storage, binding, token, now = Date.now()) {
  const [prefix, body, signature, extra] = typeof token === "string" ? token.split(".") : [];
  if (prefix !== TOKEN_PREFIX || !body || !signature || extra !== undefined) return "invalid";
  let payload;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await previewKey(storage),
      fromBase64url(signature),
      encoder.encode(body),
    );
    if (!valid) throw Error("signature");
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
  } catch {
    return "invalid";
  }
  if (!Number.isFinite(payload?.expires_at) || payload.expires_at <= now) return "expired";
  if (payload.binding !== binding) return "changed";
  return "valid";
}
