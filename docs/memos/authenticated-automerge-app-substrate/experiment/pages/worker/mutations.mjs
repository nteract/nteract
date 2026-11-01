import * as A from "@automerge/automerge";
import { assertDocumentLimits, assertIntentSize } from "../model/limits.mjs";
import { openingTitleWarning } from "../model/title-warning.mjs";
import { guardPassageEdits } from "../model/passage-edits.mjs";
import { requireSupportedSchema } from "../model/schema-features.mjs";
import {
  INTERNAL_PREFIX,
  inspectOperation,
  reserveOperation,
  listOperationEntries,
} from "./operation-journal.mjs";

/** The document a journal entry writes. Entries without `doc` predate the
 * comments document and wrote the Page. */
export const PAGE_DOC = "page";
export const COMMENTS_DOC = "comments";
const entryDoc = (entry) => entry?.doc ?? PAGE_DOC;

function reject(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}
export function mutationKey(args) {
  if (
    typeof args.idempotency_key !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(args.idempotency_key)
  )
    reject(
      400,
      "idempotency_key must contain 8–128 letters, digits, underscores or hyphens",
      "invalid_idempotency_key",
    );
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
export function requireHeads(doc, heads) {
  if (
    !Array.isArray(heads) ||
    !heads.length ||
    heads.some((head) => typeof head !== "string" || !/^[a-f0-9]{64}$/.test(head))
  )
    // The same code target-scoped edits use for malformed base_heads.
    reject(400, "base_heads from read_page are required", "invalid_edit_selector");
  const current = A.getHeads(doc).sort();
  if (
    heads.length !== current.length ||
    [...heads].sort().some((head, index) => head !== current[index])
  )
    reject(409, "Page changed; read_page again before editing", "stale_heads");
}

/** Journal the exact CRDT edit under shared native history admission. Retrying
 * never repeats the semantic operation; terminal receipts retain retry metadata.
 *
 * `doc` names the document `handle` holds (PAGE_DOC or COMMENTS_DOC); the
 * entry records it, so startup recovery replays each entry into its own
 * document. `scope` and `pageId` default to the Page document's own ID; a
 * comments document passes the Page's. `guard(args)` replaces the exact-heads
 * check: it validates the intent against the caller's snapshot and returns
 * the arguments to apply (comment intents use model/comment-guard.mjs).
 */
export async function documentMutation({
  storage,
  handle,
  operation,
  args,
  identity,
  prepare,
  apply,
  flush,
  admission,
  // The host's own migration: its key is in the reserved internal key space,
  // with its own journal capacity (operation-journal.mjs).
  internal = false,
  doc = PAGE_DOC,
  pageId = handle.doc().page_id,
  scope = `page:${pageId}`,
  guard,
}) {
  const key = internal
    ? `${INTERNAL_PREFIX}${mutationKey(args).slice("host/operation/".length)}`
    : mutationKey(args);
  const digest = await fingerprint(operation, args, identity);
  const inspected = await inspectOperation(storage, {
    key,
    digest,
    retryToken: args.retry_token,
    scope,
    principal: identity.principal,
    pendingEntry: admission?.pending(key),
  });
  let entry = inspected.entry;
  let recorded = false;
  if (!entry) {
    if (admission?.hasPending)
      throw Object.assign(Error("Finish the pending operation before starting another edit"), {
        status: 429,
        code: "pending_operation_capacity",
      });
    // A new intent never edits a Page stamped with a schema feature this build
    // can't express. A recorded receipt still replays.
    requireSupportedSchema(handle.doc());
    // Check external prerequisites only for new intents. A retry must replay
    // its original bytes/receipt even if an external service is unavailable.
    const targetScope = args.conflict_scope === "target";
    if (args.conflict_scope !== undefined && !["page", "target"].includes(args.conflict_scope))
      throw Object.assign(Error("conflict_scope must be page or target"), {
        status: 400,
        code: "invalid_edit_selector",
      });
    if (targetScope && operation !== "patch_page")
      throw Object.assign(
        Error(
          "Target conflict scope is available only for patch_page replace_match and format_match batches",
        ),
        {
          status: 400,
          code: "invalid_edit_selector",
        },
      );
    if (prepare) {
      if (targetScope) guardPassageEdits(handle.doc(), args.base_heads, args.operations);
      else if (guard) guard(args);
      else requireHeads(handle.doc(), args.base_heads);
      await prepare();
    }
    const before = handle.doc();
    // Native edits can land while prepare awaits; check the exact base again.
    requireSupportedSchema(before);
    const guarded = targetScope
      ? guardPassageEdits(before, args.base_heads, args.operations)
      : null;
    // A guarded intent (a comment) checks its own preconditions: only a
    // passage comment depends on text the caller read.
    const guardedArgs = !targetScope && guard ? guard(args) : null;
    if (!targetScope && !guard) requireHeads(before, args.base_heads);
    const effectiveArgs = guarded
      ? { ...args, operations: guarded.operations }
      : (guardedArgs ?? args);
    let result, after;
    const candidate = A.clone(before);
    // No await between the head guard and immutable edit construction.
    try {
      after = A.change(candidate, (doc) => {
        result = apply(doc, effectiveArgs);
      });
      assertDocumentLimits(after);
      // Warnings describe this exact result, including on retries after later edits.
      // Capture them before the journal budget/barrier, never from the live handle.
      const warning = ["edit_page", "patch_page"].includes(operation)
        ? openingTitleWarning(after)
        : null;
      entry = {
        fingerprint: digest,
        pending: true,
        ...(doc !== PAGE_DOC && { doc }),
        changes: A.getChanges(before, after),
        receipt: {
          page_id: pageId,
          heads: A.getHeads(after),
          result: result ?? null,
          ...(guarded && {
            concurrency: {
              rebased: guarded.rebased,
              base_heads: guarded.base_heads,
              observed_heads: guarded.current_heads,
            },
          }),
          ...(warning ? { warnings: [warning] } : {}),
        },
      };
      assertIntentSize(key, entry.changes, {
        fingerprint: entry.fingerprint,
        pending: entry.pending,
        receipt: entry.receipt,
        retry: inspected.retry,
      });
      // Persist the captured dependency base before the journal can survive a
      // crash. Native admission may advance meanwhile; reserve checks its union.
      await flush();
      entry = await reserveOperation(storage, { key, entry, retry: inspected.retry });
      const persist = async () => {
        await storage.put(key, entry);
        await storage.sync();
      };
      if (admission) await admission.reserve(key, entry, after, before, persist);
      else await persist();
      recorded = true;
    } finally {
      A.free(after ?? candidate);
    }
  }
  if (entry.pending) {
    // Also retries an ambiguous intent put from the admission cache. Do not
    // replace these bytes with a newly authored edit if storage.get was empty.
    if (!recorded) {
      await storage.put(key, entry);
      await storage.sync();
    }
    if (admission) await admission.replay(key, entry, handle);
    else await handle.update((doc) => A.applyChanges(doc, entry.changes)[0]);
    if (!A.hasHeads(handle.doc(), entry.receipt.heads))
      throw new Error("Recorded edit dependencies are unavailable");
    await flush();
    entry = { ...entry, pending: false };
    delete entry.changes;
    await storage.put(key, entry);
    await storage.sync();
  } else {
    // A prior attempt may have written the receipt before its barrier failed.
    await storage.sync();
  }
  await admission?.release(key);
  return entry.receipt;
}

/** Finish one recorded, still-pending journal entry by its key: apply its
 * recorded changes (a no-op where the handle holds them), flush, and record
 * the receipt as terminal. The host uses it to keep retrying an internal
 * migration whose recovery at startup failed. A missing or terminal entry
 * only releases the key. */
export async function replayRecordedMutation({ storage, handle, key, flush, admission }) {
  const entry = await storage.get(key);
  if (entry?.pending && entry.changes) {
    if (admission) await admission.replay(key, entry, handle);
    else await handle.update((doc) => A.applyChanges(doc, entry.changes)[0]);
    if (!A.hasHeads(handle.doc(), entry.receipt.heads))
      throw new Error("Recorded edit dependencies are unavailable");
    await flush();
    const completed = { ...entry, pending: false };
    delete completed.changes;
    await storage.put(key, completed);
    await storage.sync();
  }
  await admission?.release(key);
}

/** Replay every pending entry for document `doc` into `handle`. */
export async function recoverDocumentMutations(storage, handle, flush, admission, doc = PAGE_DOC) {
  const pending = [...(await listOperationEntries(storage))].filter(
    ([, entry]) => entry.pending && entry.changes && entryDoc(entry) === doc,
  );
  if (!pending.length) return;
  // Journal order is not causal order. Validate the entire dependency closure
  // on a disposable clone before exposing any pending edit in the live handle.
  const changes = pending.flatMap(([, entry]) => entry.changes);
  const base = handle.doc();
  const candidate = A.applyChanges(A.clone(base), changes)[0];
  try {
    if (pending.some(([, entry]) => !A.hasHeads(candidate, entry.receipt.heads)))
      throw new Error("Recorded edit dependencies are unavailable");
    if (admission) {
      // Every reservation is restored before native connections can open. The
      // union is checked at the same boundary as incoming browser records.
      for (const [key, entry] of pending)
        await admission.reserve(key, entry, candidate, base, async () => {});
      await admission.apply(
        pending.map(([key]) => key),
        changes,
        handle,
      );
    } else await handle.update((doc) => A.applyChanges(doc, changes)[0]);
  } finally {
    A.free(candidate);
  }
  await flush();
  for (const [key, entry] of pending) {
    const completed = { ...entry, pending: false };
    delete completed.changes;
    await storage.put(key, completed);
  }
  await storage.sync();
  for (const [key] of pending) await admission?.release(key);
}
