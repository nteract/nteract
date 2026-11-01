import { documentIdToBinary, interpretAsDocumentId } from "@automerge/automerge-repo";
import { logicalId } from "./policy.mjs";

/**
 * Naming a Page's comments document.
 *
 * The Page record names it by a deployment-relative UUID, `comments_doc`.
 * There is no hostname and no origin: comments belong to the deployment that
 * holds the Page. The UUID is derived from the Page ID, so a host that creates
 * the document, crashes, and creates it again gets the same document, and its
 * deterministic genesis (model/comments-doc.mjs) stores the same first change.
 * A Page record written without the field by a racing update still finds the
 * same document next time.
 */

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The comments document UUID for a Page: SHA-256 of a fixed label and the
 * Page ID, shaped as a version 4 UUID. */
export async function commentsDocUuid(pageId) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pages-comments\0${pageId}`)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The Automerge Repo document ID for a comments document UUID. */
export function commentsDocumentId(uuid) {
  if (!UUID.test(String(uuid))) throw Error("Invalid comments document id");
  return interpretAsDocumentId(
    Uint8Array.from(String(uuid).replaceAll("-", "").match(/../g), (pair) => parseInt(pair, 16)),
  );
}

/** The native tree the policy and storage name it by. */
export function commentsTreeOf(uuid) {
  return logicalId(documentIdToBinary(commentsDocumentId(uuid)));
}
