import * as A from "@automerge/automerge";
import { projectReadChanges } from "../model/read-changes.mjs";

const DEFAULT_BYTES = 128 * 1024;
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const knownErrors = new Set([
  "invalid_change_selector",
  "resync_required",
  "changes_budget_exceeded",
]);
const invalid = (message) => {
  throw Object.assign(Error(message), { status: 400, code: "invalid_change_selector" });
};

/** A captured revision supplies the complete net delta and its edit authority.
 * Oversized results fail as a whole; current heads never imply a partial delta.
 */
export async function readChangesTool(
  doc,
  args,
  { issueAuthority, recovery, historyIncomplete, commentsDoc } = {},
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
          !["page_id", "since_heads", "since_comment_heads", "comments", "max_bytes"].includes(key),
      )
    )
      invalid("Unknown change-read argument");
    if (
      args.max_bytes !== undefined &&
      (!Number.isSafeInteger(args.max_bytes) || args.max_bytes < 4096 || args.max_bytes > 262144)
    )
      invalid("max_bytes must be an integer from 4096 to 262144");
    maxBytes = args.max_bytes ?? DEFAULT_BYTES;
    payload = projectReadChanges(
      doc,
      {
        since_heads: args.since_heads,
        ...(args.since_comment_heads !== undefined && {
          since_comment_heads: args.since_comment_heads,
        }),
        comments: args.comments,
        max_bytes: maxBytes,
      },
      commentsDoc,
    );
  } catch (error) {
    if (!knownErrors.has(error.code)) throw error;
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
  const authority = await issueAuthority();
  const common = {
    heads,
    ...(commentsDoc && { comment_heads: A.getHeads(commentsDoc) }),
    ...authority,
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
