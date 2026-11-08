import { REJECTION, admitCommentChanges } from "../model/comment-authority.mjs";
import { Refusal } from "./host.mjs";

/** Codes that mean the principal authored a change the comment rules forbid. */
export const BLOCKING = new Set(
  Object.values(REJECTION).filter(
    (code) =>
      ![
        REJECTION.MISSING_DEPENDENCIES,
        REJECTION.INVALID_PRINCIPAL,
        REJECTION.MALFORMED_CHANGE,
        REJECTION.OUTDATED_FORM,
        REJECTION.ASSERTIONS_UNAVAILABLE,
      ].includes(code),
  ),
);

/**
 * SyncHost `admit` hook for the comments document: the comment rules
 * (model/comment-authority.mjs), run on the changes a sync message would
 * add, before anything is stored. A blocking
 * refusal is fatal; the host's `refused` hook records the block. `isBlocked`
 * says whether a principal's comment writes are already blocked.
 */
export function commentAdmission({
  isBlocked = () => false,
  allowNewAssertions = () => false,
} = {}) {
  return (conn, doc, live, fresh, preview, actorPrincipal) => {
    if (doc.kind !== "comments") return preview;
    if (isBlocked(conn))
      throw new Refusal("comments_blocked", "Comment writes are blocked for this account", {
        fatal: true,
      });
    const result = admitCommentChanges(live, fresh, conn.principal, {
      role: conn.role,
      actorPrincipal,
      allowNewAssertions: allowNewAssertions(),
      ...(conn.features && { features: conn.features }),
    });
    if (!result.ok)
      throw new Refusal(result.reason.code, result.reason.message, {
        fatal: BLOCKING.has(result.reason.code),
      });
    return result.next;
  };
}
