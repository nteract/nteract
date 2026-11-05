import * as A from "@automerge/automerge";
import { applyComment } from "./comments.mjs";
import { commentsGenesis } from "./comments-doc.mjs";

/** Tests only. A Page's comments document, as the host creates it. */
export function newCommentsDoc(uuid = crypto.randomUUID()) {
  return A.clone(commentsGenesis(uuid));
}

/** Tests only. One comment action on `comments`, anchored in `page`.
 * Returns `{ comments, result }`; `comments` is the next document. */
export function comment(
  page,
  comments,
  input,
  identity = {},
  { role = "editor", ...options } = {},
) {
  let result;
  const next = A.change(comments, (draft) => {
    result = applyComment(
      draft,
      input,
      { principal: "user:test", displayName: "Test", driver: "Test", ...identity },
      undefined,
      { page, role, ...options },
    );
  });
  return { comments: next, result };
}
