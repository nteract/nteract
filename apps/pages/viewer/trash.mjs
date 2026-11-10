import { retryKey } from "../model/retry-key.mjs";
import { readLocalGrant, retireLocalPage } from "./local-catalog.mjs";

/** Browser Trash operations. Each mutation prepares fresh catalog retry
 * authority from list_pages, like Page deletion and creation.
 */
async function catalogAuthority(tool) {
  const prepared = await tool("list_pages");
  if (typeof prepared?.retry_token !== "string") throw Error("Could not prepare the request");
  return {
    retry_token: prepared.retry_token,
    idempotency_key: await retryKey(prepared.retry_token),
  };
}

/** Leave every session of a Page that just moved to Trash through the
 * session host's drain. The reload gate then waits for their checkpoints,
 * and a failed checkpoint leaves its recovery export, as when leaving any
 * Page. */
export function closeTrashedSessions(host, sessions, options) {
  return Promise.all(
    [...new Set(sessions.filter(Boolean))].map((session) => host.leave(session, options)),
  );
}

/** delete_page fences on the heads this tab has seen, so a peer's edit that
 * lands first refuses the move with stale_heads. The host's message is for
 * agents ("read_page again"); a person gets one they can act on. */
export function moveToTrashError(error) {
  return error?.code === "stale_heads"
    ? Object.assign(Error("Someone edited this Page while it was moving to Trash. Try again."), {
        code: error.code,
        status: error.status,
      })
    : error;
}

/** A superseded result was not applied; the Page changed since the request. */
function applied(result) {
  if (result?.superseded || result?.applied === false)
    throw Error("This Page changed since you opened Trash. Refresh and try again.");
  return result;
}

/** The largest Page limit any account can have (worker/page-quota.mjs
 * MAX_PAGE_QUOTA). A paused account can move every active Page to Trash, so
 * its Trash can hold twice that. */
export const MAX_PAGE_QUOTA = 10_000;
/** A safety bound on list_pages requests for one Trash listing: four times
 * what the largest possible Trash needs at 100 Pages per request, so short
 * pages never reach it. */
export const TRASH_REQUESTS = ((2 * MAX_PAGE_QUOTA) / 100) * 4;

/** Every Page in the caller's Trash, following cursors until there are none.
 * A listing that would need more than TRASH_REQUESTS requests throws rather
 * than show part of Trash as all of it. */
export async function listTrash(tool) {
  const pages = [];
  let cursor;
  for (let request = 0; request < TRASH_REQUESTS; request++) {
    const result = await tool("list_pages", {
      in_trash: true,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (Array.isArray(result?.pages)) pages.push(...result.pages);
    cursor = result?.next_cursor;
    if (typeof cursor !== "string") return pages;
  }
  throw Error("Trash has more Pages than this view can list.");
}

export async function restorePage(tool, pageId, principal) {
  return applied(
    await tool("restore_page", {
      page_id: pageId,
      expected_principal: principal,
      ...(await catalogAuthority(tool)),
    }),
  );
}

/** The grant of this browser's copy of a Page (`{ grant, revision }`), read
 * before a permanent deletion so retirePurgedPage leaves a checkpoint a newer
 * grant wrote. */
export function purgeGrant(identity, pageId) {
  return readLocalGrant(identity, pageId).catch(() => undefined);
}
/** After a permanent deletion, move this browser's copy of the Page to the
 * recovery archive and mark it deleted, in one transaction. Nothing renders
 * it again; Download previous local draft still can. */
export function retirePurgedPage(identity, pageId, { grant, revision } = {}) {
  if (!identity?.principal) return Promise.resolve(null);
  return retireLocalPage(identity, pageId, { reason: "deleted", grant, revision });
}

export function previewPurge(tool, pageId, principal) {
  return tool("purge_page", { page_id: pageId, action: "preview", expected_principal: principal });
}

export async function confirmPurge(tool, preview, principal) {
  return applied(
    await tool("purge_page", {
      page_id: preview.page_id,
      action: "confirm",
      preview_token: preview.preview_token,
      expected_principal: principal,
      ...(await catalogAuthority(tool)),
    }),
  );
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const person = (collaborator) =>
  collaborator.display_name || collaborator.email || collaborator.principal;

/** Plain-language consequences shown before permanent deletion. Titles and
 * names are rendered as text, never as markup.
 */
export function purgeSummary(preview) {
  const collaborators = Array.isArray(preview?.collaborators) ? preview.collaborators : [];
  const lines = [
    `${plural(preview?.comment_count ?? 0, "comment")} will be deleted.`,
    collaborators.length
      ? `${plural(collaborators.length, "collaborator")} will lose access: ${collaborators
          .map(person)
          .join(", ")}.`
      : "No collaborators will lose access.",
  ];
  if (preview?.pending_invitations)
    lines.push(`${plural(preview.pending_invitations, "pending invitation")} will be cancelled.`);
  return lines;
}

export function trashedDate(value, locale) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
