// Host-owned document identities, independent of Automerge content and the
// additive schema-feature gates. Project content uses pages.page too.
export const DOCUMENT_TYPES = Object.freeze({
  "pages.page": Object.freeze({
    1: Object.freeze({ type: "pages.page", format: 1 }),
  }),
  "pages.comments": Object.freeze({
    1: Object.freeze({ type: "pages.comments", format: 1 }),
  }),
});

/** Project the host's existing IDs without minting, persisting or converting
 * documents. Omit comments when the host has no comments handle to advertise. */
export function pageDocuments(documentId, commentsDocumentId) {
  return {
    page: { id: documentId, ...DOCUMENT_TYPES["pages.page"][1] },
    ...(commentsDocumentId !== undefined && {
      comments: { id: commentsDocumentId, ...DOCUMENT_TYPES["pages.comments"][1] },
    }),
  };
}

/** Read a known descriptor value; null means malformed or unregistered.
 * This does not grant access, validate document bytes or refuse a connection.
 * IDs are opaque nonempty strings here; their codec belongs to the host. */
export function parseDocumentDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, type, format } = value;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof type !== "string" ||
    !Number.isSafeInteger(format) ||
    !Object.hasOwn(DOCUMENT_TYPES, type) ||
    !Object.hasOwn(DOCUMENT_TYPES[type], format)
  )
    return null;
  return { id, ...DOCUMENT_TYPES[type][format] };
}
