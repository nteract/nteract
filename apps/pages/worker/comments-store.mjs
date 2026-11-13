// The host's names for the comments document. The derivation itself, shared
// with the sources and view documents and with the viewer, is in
// shared/document-ids.mjs.
import { COMMENTS_LABEL, derivedDocUuid, derivedDocumentId } from "../shared/document-ids.mjs";

export { COMMENTS_LABEL, derivedDocUuid, derivedDocumentId };

/** The comments document UUID for a Page. */
export const commentsDocUuid = (pageId) => derivedDocUuid(COMMENTS_LABEL, pageId);

/** The Automerge Repo document ID for a comments document UUID. */
export const commentsDocumentId = derivedDocumentId;
