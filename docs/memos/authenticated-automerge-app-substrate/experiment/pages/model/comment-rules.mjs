/** Who may do what to a comment thread. One table for the tools, the viewer
 * and the native authority check (comment-authority.mjs), so the three agree.
 *
 * Roles are the Page grant's role: owner, editor, commenter, viewer, none.
 * Owners, editors and commenters hold the `comment` capability.
 *
 * | Action          | Who                                                  |
 * | --------------- | ---------------------------------------------------- |
 * | add, reply      | anyone who can comment                               |
 * | resolve, reopen | anyone who can comment                               |
 * | edit            | the message's author                                 |
 * | delete_message  | the message's author                                 |
 * | delete_thread   | owners and editors, or the thread's author           |
 * | move anchor     | the thread's author (no tool moves one today)        |
 *
 * Authorship is the authenticated principal, never a display name or session
 * label, so two sessions of one account share their comments.
 */
export const COMMENTING_ROLES = Object.freeze(["owner", "editor", "commenter"]);
export const THREAD_MODERATORS = Object.freeze(["owner", "editor"]);
export const COMMENT_ACTIONS = Object.freeze([
  "add",
  "reply",
  "resolve",
  "reopen",
  "edit",
  "delete_message",
  "delete_thread",
  "move_anchor",
]);

const principalOf = (entity) => {
  const value = entity?.author?.principal;
  return value === undefined || value === null ? "" : String(value);
};

/** Decide one action. `thread` and `message` are the stored entities the
 * action touches (absent for add). Returns `{ allowed: true }` or
 * `{ allowed: false, code, message }`. Pure. */
export function commentDecision({ action, role, principal, thread, message }) {
  if (!COMMENT_ACTIONS.includes(action))
    return {
      allowed: false,
      code: "invalid_comment_selector",
      message: "Unsupported comment action",
    };
  if (!COMMENTING_ROLES.includes(role))
    return {
      allowed: false,
      code: "comment_access_denied",
      message: "Commenting needs comment access to this Page",
    };
  switch (action) {
    case "add":
    case "reply":
    case "resolve":
    case "reopen":
      return { allowed: true };
    case "edit":
    case "delete_message":
      return principal && principalOf(message) === principal
        ? { allowed: true }
        : {
            allowed: false,
            code: "comment_not_author",
            message: "Only a message's author can edit or delete it",
          };
    case "delete_thread":
      return THREAD_MODERATORS.includes(role) || (principal && principalOf(thread) === principal)
        ? { allowed: true }
        : {
            allowed: false,
            code: "comment_not_author",
            message: "Only the thread's author, an editor or the owner can delete a thread",
          };
    case "move_anchor":
      return principal && principalOf(thread) === principal
        ? { allowed: true }
        : {
            allowed: false,
            code: "comment_not_author",
            message: "Only the thread's author can move its anchor",
          };
  }
}

/** Throw the refusal for `decision` as a 403 the tools return. */
export function requireCommentDecision(decision) {
  if (decision.allowed) return;
  throw Object.assign(Error(decision.message), {
    status: decision.code === "invalid_comment_selector" ? 400 : 403,
    code: decision.code,
  });
}
