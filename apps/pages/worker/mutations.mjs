import * as A from "@automerge/automerge";
import { assertDocumentLimits, assertIntentSize } from "../model/limits.mjs";
import { openingTitleWarning } from "../model/title-warning.mjs";
import { guardPassageEdits, PASSAGE_OPS } from "../model/passage-edits.mjs";
import { requireSupportedSchema } from "../model/schema-features.mjs";
import {
  INTERNAL_PREFIX,
  inspectOperation,
  journalTime,
  listOperationEntries,
  receiptHorizon,
  receiptKey,
  reserveOperation,
  revisionClock,
  validNonce,
} from "./operation-journal.mjs";
import { fencedHeads, parseRevision, revisionPlan } from "./revisions.mjs";

/** The document a journal entry writes. */
export const PAGE_DOC = "page";
export const COMMENTS_DOC = "comments";
const entryDoc = (entry) => entry?.doc ?? PAGE_DOC;

function reject(status, message, code, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) error.details = details;
  throw error;
}
/** The journal key of a client write: the caller's nonce, scoped by the
 * host to the authenticated account and the receipt lane (`page`,
 * `comments`, `catalog`, `project`, `lifecycle`). */
export function operationKey(args, identity, lane) {
  return receiptKey({ principal: identity?.principal, lane, nonce: args?.nonce });
}
/** Refuse a write without a well-formed nonce, before any other work. */
export function requireNonce(args) {
  if (!validNonce(args?.nonce))
    reject(
      400,
      "nonce must be 6–64 letters, digits, underscores or hyphens, new for each request",
      "invalid_nonce",
    );
}
/** `agent` is the client's resolved `{ name?, model? }` assertion, for a write
 * that stores it. Without one the digest covers the request alone. */
export async function fingerprint(operation, args, identity, agent) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      operation,
      args,
      principal: identity.principal,
      driver: identity.driver,
      ...(agent && { agent }),
    }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
/** The warnings a batch's edits carry (`result.edits[i].warnings`), each with
 * the index of the edit that raised it and the id it named. */
function editWarnings(result) {
  if (!Array.isArray(result?.edits)) return [];
  return result.edits.flatMap((edit, edit_index) =>
    (edit?.warnings ?? []).map((warning) => ({ ...warning, edit_index, node_id: edit.node_id })),
  );
}
/** Refuse unless `heads` are exactly `doc`'s heads. The refusal carries the
 * live heads in `details.current_heads`; the host names them as a revision
 * handle before the caller sees them. */
export function requireHeads(doc, heads) {
  if (
    !Array.isArray(heads) ||
    !heads.length ||
    heads.some((head) => typeof head !== "string" || !/^[a-f0-9]{64}$/.test(head))
  )
    reject(400, "A revision from read_page is required", "invalid_revision");
  const current = A.getHeads(doc).sort();
  if (
    heads.length !== current.length ||
    [...heads].sort().some((head, index) => head !== current[index])
  )
    reject(409, "Page changed; read_page again before editing", "stale_revision", {
      current_heads: current,
    });
}
/** edit_page's base revision: always required. */
const requiredRevision = (args) => {
  if (args.revision === undefined)
    reject(400, "revision from read_page is required", "invalid_revision");
  return args.revision;
};

/** Journal the exact CRDT edit, then apply it through the host's queue. An
 * exact retry returns the journaled receipt and never repeats the edit.
 *
 * The entry moves absent → pending → applied → completed. The pending entry
 * holds the change bytes and the revision handles its receipt reports, all
 * in one multi-key put; a restart replays it (recoverDocumentMutations).
 *
 * `doc` names the document `handle` holds (PAGE_DOC or COMMENTS_DOC); the
 * entry records it, so startup recovery replays each entry into its own
 * document, and its receipt names the after-revision as `revision` (Page) or
 * `comment_revision` (comments). `lane` scopes the nonce (defaults to
 * `doc`). `baseRevision(args)` returns the Page revision handle the intent
 * depends on, or undefined for one that depends on none; edit_page requires
 * one. A named revision is fenced by the journal's horizon (fencedHeads),
 * then checked: `guard(args, baseHeads)` replaces the exact-heads check for
 * a guarded intent (comments use model/comment-guard.mjs). `receiptFields
 * (plan)` adds fields to a new intent's receipt, computed after the guard
 * and minting through `plan`; they're journaled, so an exact retry returns
 * them unchanged. `onHeads(heads)` receives the document heads the receipt
 * describes. `pageHeads()` returns the live Page heads a revision refusal
 * names; it defaults to `handle`'s heads when `handle` holds the Page.
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
  hostActorPrefix,
  // The host's own migration: its key is in the reserved internal key space,
  // with its own journal capacity (operation-journal.mjs).
  internal = false,
  doc = PAGE_DOC,
  lane = doc,
  pageId = handle.doc().page_id,
  baseRevision = requiredRevision,
  guard,
  receiptFields,
  onHeads,
  pageHeads = () => (doc === PAGE_DOC ? A.getHeads(handle.doc()) : undefined),
  agent,
}) {
  requireNonce(args);
  const key = internal
    ? `${INTERNAL_PREFIX}${args.nonce}`
    : await operationKey(args, identity, lane);
  const digest = await fingerprint(operation, args, identity, agent);
  const inspected = await inspectOperation(storage, { key, digest });
  let entry = inspected.entry;
  if (entry && entryDoc(entry) !== doc)
    throw new Error("A journal entry names another document than its lane");
  let recorded = false;
  if (!entry) {
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
    if (
      targetScope &&
      (!Array.isArray(args.operations) ||
        !args.operations.length ||
        !args.operations.every((item) => PASSAGE_OPS.has(item?.op)))
    )
      throw Object.assign(
        Error(
          "Target conflict scope is available only for replace_match, format_match and set_node batches",
        ),
        {
          status: 400,
          code: "invalid_edit_selector",
        },
      );
    const base = baseRevision(args);
    if (base !== undefined) parseRevision(base, PAGE_DOC);
    // A write against a revision the journal may have forgotten receipts
    // for is refused before any other check (operation-journal.mjs). The
    // refusal names the live heads so the caller gets the current revision.
    const baseHeads =
      base === undefined
        ? undefined
        : await fencedHeads(storage, PAGE_DOC, base, (await revisionClock(storage)).horizon).catch(
            (error) => {
              const current_heads = error?.code === "resync_required" && pageHeads();
              if (current_heads) error.details = { current_heads };
              throw error;
            },
          );
    if (prepare) {
      if (targetScope) guardPassageEdits(handle.doc(), baseHeads, args.operations);
      else if (guard) guard(args, baseHeads);
      else requireHeads(handle.doc(), baseHeads);
      await prepare();
    }
    const before = handle.doc();
    // Browser edits can land while prepare awaits; check the exact base again.
    requireSupportedSchema(before);
    const guarded = targetScope ? guardPassageEdits(before, baseHeads, args.operations) : null;
    // A guarded intent (a comment) checks its own preconditions: only a
    // passage comment depends on text the caller read.
    const guardedArgs = !targetScope && guard ? guard(args, baseHeads) : null;
    if (!targetScope && !guard) requireHeads(before, baseHeads);
    const effectiveArgs = guarded
      ? { ...args, operations: guarded.operations }
      : (guardedArgs ?? args);
    let result, after;
    // Each host mutation has a fresh actor so concurrent producers can build
    // candidates from the same heads without reusing an (actor, seq). SyncHost
    // refuses host-prefixed actors from browsers, without a per-edit claim.
    const actor =
      hostActorPrefix &&
      hostActorPrefix +
        Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
    const candidate = A.clone(before, actor ? { actor } : undefined);
    // No await between the head guard and immutable edit construction.
    try {
      after = A.change(candidate, (doc) => {
        result = apply(doc, effectiveArgs);
      });
      assertDocumentLimits(after);
      // Warnings describe this exact result, including on retries after later edits.
      // Capture them before the journal budget/barrier, never from the live handle.
      // Per-edit warnings (a replace_match that dropped partial marks) also
      // appear here, naming their edit, so a caller reads one list.
      const warnings =
        operation === "edit_page"
          ? [openingTitleWarning(after), ...editWarnings(result)].filter(Boolean)
          : [];
      const heads = A.getHeads(after);
      entry = {
        fingerprint: digest,
        pending: true,
        ...(doc !== PAGE_DOC && { doc }),
        heads,
        changes: A.getChanges(before, after),
        receipt: { page_id: pageId, result: result ?? null },
      };
      assertIntentSize(key, entry.changes, {
        fingerprint: entry.fingerprint,
        pending: entry.pending,
        heads,
        receipt: entry.receipt,
      });
      // Persist the captured dependency base before the journal can survive a
      // crash.
      await flush();
      entry = await reserveOperation(storage, { key, entry });
      // The receipt's handles are minted at the entry's journal time and
      // written in the same put as the pending entry.
      // The observed revision comes first: it precedes the result. When the
      // Page didn't move, it is the base revision itself.
      const recordedAt = entry.recordedAt ?? (await journalTime(storage));
      const plan = revisionPlan(storage, recordedAt, await receiptHorizon(storage, recordedAt));
      const observed =
        guarded && (guarded.rebased ? await plan.handle(PAGE_DOC, guarded.current_heads) : base);
      entry.receipt = {
        page_id: pageId,
        [doc === PAGE_DOC ? "revision" : "comment_revision"]: await plan.handle(doc, heads),
        result: result ?? null,
        ...(guarded && {
          concurrency: {
            rebased: guarded.rebased,
            base_revision: base,
            observed_revision: observed,
          },
        }),
        ...(warnings.length ? { warnings } : {}),
        ...(receiptFields && (await receiptFields(plan))),
      };
      await storage.put({ [key]: entry, ...plan.writes });
      await storage.sync();
      await plan.settle();
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
    await handle.update((doc) => A.applyChanges(doc, entry.changes)[0], { internal });
    if (!A.hasHeads(handle.doc(), entry.heads))
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
  onHeads?.(entry.heads);
  return entry.receipt;
}

/** Replay every pending entry for document `doc` into `handle`. */
export async function recoverDocumentMutations(storage, handle, flush, doc = PAGE_DOC) {
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
    if (pending.some(([, entry]) => !A.hasHeads(candidate, entry.heads)))
      throw new Error("Recorded edit dependencies are unavailable");
    // Apply the validated closure in causal order, preserving the capability
    // of each journal entry rather than exempting a mixed recovery batch.
    const internalHashes = new Set(
      pending
        .filter(([key]) => key.startsWith(INTERNAL_PREFIX))
        .flatMap(([, entry]) => entry.changes.map((bytes) => A.decodeChange(bytes).hash)),
    );
    for (const bytes of A.getChanges(base, candidate))
      await handle.update((doc) => A.applyChanges(doc, [bytes])[0], {
        internal: internalHashes.has(A.decodeChange(bytes).hash),
      });
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
}
