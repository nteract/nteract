import * as A from "@automerge/automerge";
import { changeHistory, projectReadChanges } from "../model/read-changes.mjs";

const DEFAULT_BYTES = 128 * 1024;
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** Change-feed refusals that reach the caller with their own code. */
export const CHANGE_ERROR_CODES = new Set([
  "invalid_change_selector",
  "resync_required",
  "changes_budget_exceeded",
]);
const invalid = (message) => {
  throw Object.assign(Error(message), { status: 400, code: "invalid_change_selector" });
};

/** A captured revision supplies the complete net delta. `since_revision`
 * and `since_comment_revision` resolve through the host's handle table
 * (`revisions`, as readTool takes it); a handle it no longer holds is
 * `resync_required`. The result names the current revisions as handles.
 * Oversized results fail as a whole; current heads never imply a partial delta.
 * `writers(changes)` resolves the decoded changes since the baseline to a
 * function from one change to its writer (worker/host-writers.mjs
 * resolveWriters); without it the result has no
 * attribution. The changes are decoded once, after the argument and revision
 * checks, and not at all past ATTRIBUTION_MAX_CHANGES.
 */
export async function readChangesTool(
  doc,
  args,
  { revisions, recovery, historyIncomplete, commentsDoc, writers } = {},
) {
  const heads = A.getHeads(doc);
  let maxBytes = DEFAULT_BYTES,
    payload,
    status = 200;
  try {
    if (!args || typeof args !== "object" || Array.isArray(args))
      invalid("Change-read arguments must be an object");
    if (
      Object.keys(args).some(
        (key) =>
          ![
            "page_id",
            "since_revision",
            "since_comment_revision",
            "comments",
            "max_bytes",
          ].includes(key),
      )
    )
      invalid("Unknown change-read argument");
    if (
      args.max_bytes !== undefined &&
      (!Number.isSafeInteger(args.max_bytes) || args.max_bytes < 4096 || args.max_bytes > 262144)
    )
      invalid("max_bytes must be an integer from 4096 to 262144");
    maxBytes = args.max_bytes ?? DEFAULT_BYTES;
    if (args.since_revision === undefined) invalid("since_revision from a read is required");
    const since = await revisions.heads("page", args.since_revision, "since_revision");
    const sinceComments =
      args.since_comment_revision === undefined
        ? undefined
        : await revisions.heads("comments", args.since_comment_revision, "since_comment_revision");
    // Every argument is refused before a change is decoded.
    if (args.comments !== undefined && !["none", "summary", "all"].includes(args.comments))
      invalid("comments must be none, summary or all");
    const history = writers ? changeHistory(doc, since) : undefined;
    const resolve = history?.changes && (await writers(history.changes));
    const {
      since_heads: _since,
      heads: _heads,
      comment_heads: _commentHeads,
      ...delta
    } = projectReadChanges(
      doc,
      {
        since_heads: since,
        ...(sinceComments !== undefined && { since_comment_heads: sinceComments }),
        comments: args.comments,
        max_bytes: maxBytes,
      },
      commentsDoc,
      history ? { history, writerOf: (change) => resolve?.(change) ?? null } : {},
    );
    payload = { ...delta, since_revision: args.since_revision };
  } catch (error) {
    if (!CHANGE_ERROR_CODES.has(error.code)) throw error;
    status = error.status;
    payload = {
      page_id: doc.page_id,
      error: error.message,
      code: error.code,
      ...(error.code === "changes_budget_exceeded" && {
        max_bytes: maxBytes,
        ...(error.details?.counts && { counts: error.details.counts }),
      }),
    };
  }
  const [revision, comment_revision] = await revisions.handles([
    ["page", heads],
    ...(commentsDoc ? [["comments", A.getHeads(commentsDoc)]] : []),
  ]);
  const common = {
    revision,
    ...(comment_revision && { comment_revision }),
    ...(recovery && { recovery }),
    ...(historyIncomplete && { history_incomplete: historyIncomplete }),
  };
  let body = { ...payload, ...common };
  // The MCP transport adds its public Page URL to this JSON envelope.
  const fits = (value) => bytes(value) + 512 <= maxBytes;
  if (!fits(body)) {
    status = 413;
    body = {
      page_id: doc.page_id,
      error:
        "Changes exceed max_bytes. Increase the budget, use comments:none, or resynchronize with read_page and its section/node selectors. No partial delta was returned.",
      code: "changes_budget_exceeded",
      max_bytes: maxBytes,
      ...(payload.changes && {
        counts: { changes: payload.changes.length, comments: payload.comments?.length ?? 0 },
      }),
      ...common,
    };
    if (!fits(body))
      body = {
        error: "Revision metadata exceeds max_bytes; retry with a larger budget.",
        code: "read_metadata_budget_exceeded",
        max_bytes: maxBytes,
      };
  }
  return { status, body };
}
