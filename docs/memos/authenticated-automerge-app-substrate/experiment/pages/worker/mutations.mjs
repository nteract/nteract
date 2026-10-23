import * as A from "@automerge/automerge";
import { assertDocumentLimits, assertIntentSize } from "../model/limits.mjs";

function reject(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
export function mutationKey(args) {
  if (
    typeof args.idempotency_key !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(args.idempotency_key)
  )
    reject(400, "idempotency_key must contain 8–128 letters, digits, underscores or hyphens");
  return `host/operation/${args.idempotency_key}`;
}
export async function fingerprint(operation, args, identity) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ operation, args, principal: identity.principal, driver: identity.driver }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function existingIntent(storage, key, digest) {
  const entry = await storage.get(key);
  if (entry && entry.fingerprint !== digest)
    reject(409, "idempotency_key was used for a different request");
  return entry;
}
export async function reserveCapacity(storage) {
  if ((await storage.list({ prefix: "host/operation/", limit: 1000 })).size >= 1000)
    reject(409, "This prototype retains at most 1000 operation receipts per document or catalog");
}
export function requireHeads(doc, heads) {
  if (
    !Array.isArray(heads) ||
    !heads.length ||
    heads.some((head) => typeof head !== "string" || !/^[a-f0-9]{64}$/.test(head))
  )
    reject(400, "base_heads from read_page are required");
  const current = A.getHeads(doc).sort();
  if (
    heads.length !== current.length ||
    [...heads].sort().some((head, index) => head !== current[index])
  )
    reject(409, "Page changed; read_page again before editing");
}

/** Record exact CRDT changes before applying them. Retrying or recovering this
 * intent reuses the same operation IDs instead of repeating a text replacement.
 * Receipts remain until document deletion; the cap refuses new operations.
 */
export async function documentMutation({
  storage,
  handle,
  operation,
  args,
  identity,
  apply,
  flush,
}) {
  const key = mutationKey(args);
  const digest = await fingerprint(operation, args, identity);
  let entry = await existingIntent(storage, key, digest);
  if (!entry) {
    await reserveCapacity(storage);
    const before = handle.doc();
    requireHeads(before, args.base_heads);
    let result;
    // No await between the head guard and construction of the immutable edit.
    // Later concurrent WebSocket changes merge when this recorded edit applies.
    const after = A.change(A.clone(before), (doc) => {
      result = apply(doc);
    });
    assertDocumentLimits(after);
    entry = {
      fingerprint: digest,
      pending: true,
      changes: A.getChanges(before, after),
      receipt: { page_id: before.page_id, heads: A.getHeads(after), result: result ?? null },
    };
    assertIntentSize(key, entry.changes, {
      fingerprint: entry.fingerprint,
      pending: entry.pending,
      receipt: entry.receipt,
    });
    // The immutable edit may depend on freshly received WebSocket changes.
    // Persist that captured base before its replayable intent can survive a crash.
    // Concurrent changes may advance the handle; they cannot remove this base.
    await flush();
    await storage.put(key, entry);
  }
  if (entry.pending) {
    await handle.update((doc) => A.applyChanges(doc, entry.changes)[0]);
    if (!A.hasHeads(handle.doc(), entry.receipt.heads))
      throw new Error("Recorded edit dependencies are unavailable");
    await flush();
    entry = { fingerprint: digest, pending: false, receipt: entry.receipt };
    await storage.put(key, entry);
    await storage.sync();
  } else {
    // A prior attempt may have written the receipt before its barrier failed.
    await storage.sync();
  }
  return entry.receipt;
}

export async function recoverDocumentMutations(storage, handle, flush) {
  const pending = [...(await storage.list({ prefix: "host/operation/" }))].filter(
    ([, entry]) => entry.pending && entry.changes,
  );
  if (!pending.length) return;
  // Storage key ordering is unrelated to causal order. Apply the whole set so
  // dependencies can resolve before any receipt is declared durable.
  await handle.update(
    (doc) =>
      A.applyChanges(
        doc,
        pending.flatMap(([, entry]) => entry.changes),
      )[0],
  );
  if (pending.some(([, entry]) => !A.hasHeads(handle.doc(), entry.receipt.heads)))
    throw new Error("Recorded edit dependencies are unavailable");
  await flush();
  for (const [key, entry] of pending)
    await storage.put(key, {
      fingerprint: entry.fingerprint,
      pending: false,
      receipt: entry.receipt,
    });
  await storage.sync();
}
