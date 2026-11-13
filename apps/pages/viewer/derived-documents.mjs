// The ids of documents a Page's host derives from the Page id, as the viewer
// looks them up. The host names each by the same derivation
// (worker/comments-store.mjs derivedDocUuid with its module's label), so the
// viewer can find a document on the live connection without waiting for a
// discovery to name it. derived-documents.test.mjs checks each label against
// the host's.
import { derivedDocUuid, derivedDocumentId } from "../worker/comments-store.mjs";

/** The label the sources document's id derives from (worker/
 * document-modules.mjs SOURCES_MODULE.derived.label). */
export const SOURCES_LABEL = "pages-sources";

/** The Automerge document id of `pageId`'s sources document, whether or not
 * the host has created it. */
export async function sourcesDocumentId(pageId) {
  return derivedDocumentId(await derivedDocUuid(SOURCES_LABEL, pageId));
}
