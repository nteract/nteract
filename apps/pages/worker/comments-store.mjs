import { interpretAsDocumentId } from "@automerge/automerge-repo";

/**
 * Naming the documents a Page's host derives from the Page ID: its comments
 * document and its sources document.
 *
 * Each is named by a deployment-relative UUID. There is no hostname and no
 * origin: these documents belong to the deployment that holds the Page. The
 * UUID is derived from the Page ID and the document's label, so a host that
 * creates the document, crashes, and creates it again gets the same document,
 * and its deterministic genesis (model/comments-doc.mjs,
 * model/sources-doc.mjs) stores the same first change.
 *
 * The Page record names the comments document's UUID as `comments_doc`. A
 * Page record written without the field by a racing update still finds the
 * same document next time. The sources document's UUID is not stored: the
 * record names the `pages.sources` type once the document exists.
 */

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The UUID of the document `label` derives for a Page: SHA-256 of the label
 * and the Page ID, shaped as a version 4 UUID. */
export async function derivedDocUuid(label, pageId) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${label}\0${pageId}`)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The Automerge Repo document ID for a derived document's UUID. */
export function derivedDocumentId(uuid) {
  if (!UUID.test(String(uuid))) throw Error("Invalid derived document id");
  return interpretAsDocumentId(
    Uint8Array.from(String(uuid).replaceAll("-", "").match(/../g), (pair) => parseInt(pair, 16)),
  );
}

/** The label the comments document's UUID derives from. */
export const COMMENTS_LABEL = "pages-comments";

/** The comments document UUID for a Page. */
export const commentsDocUuid = (pageId) => derivedDocUuid(COMMENTS_LABEL, pageId);

/** The Automerge Repo document ID for a comments document UUID. */
export const commentsDocumentId = derivedDocumentId;
