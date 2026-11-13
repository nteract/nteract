// Host-owned document identities, independent of Automerge content and the
// additive schema-feature gates. Project content uses pages.page too.
// A build reads every format registered here and writes the highest one of
// each type.
export const DOCUMENT_TYPES = Object.freeze({
  "pages.page": Object.freeze({
    3: Object.freeze({ type: "pages.page", format: 3 }),
  }),
  "pages.comments": Object.freeze({
    2: Object.freeze({ type: "pages.comments", format: 2 }),
  }),
  "pages.sources": Object.freeze({
    1: Object.freeze({ type: "pages.sources", format: 1 }),
  }),
  "pages.view": Object.freeze({
    1: Object.freeze({ type: "pages.view", format: 1 }),
  }),
});

/** The format this build writes for `type`: the highest one registered. */
function currentFormat(type) {
  return Math.max(...Object.keys(DOCUMENT_TYPES[type]).map(Number));
}

/** The format this build writes for each type, `{ type: format }`. */
export const WRITTEN_FORMATS = Object.freeze(
  Object.fromEntries(Object.keys(DOCUMENT_TYPES).map((type) => [type, currentFormat(type)])),
);

/** The types every Page holds a document of. A type registered beside them
 * is one a Page may hold, such as `pages.sources` or `pages.view`, and a
 * record without it is still opened. The record names `pages.sources` once
 * the sources document exists; it never names `pages.view`, whose documents
 * the host lists under `host/view/` instead. */
export const MEMBER_TYPES = Object.freeze(["pages.page", "pages.comments"]);

/** `documentFormats` for a new Page: each member type at its written format.
 * A Page host record stores it from the Page's creation or registration on. */
export const MEMBER_FORMATS = Object.freeze(
  Object.fromEntries(MEMBER_TYPES.map((type) => [type, WRITTEN_FORMATS[type]])),
);

/** The formats a Page host record says its documents are in, `{ type:
 * format }`: its `documentFormats`, or null for a record without one. The
 * only reader of that field. */
export function recordDocumentFormats(record) {
  return Object.hasOwn(record, "documentFormats") ? record.documentFormats : null;
}

/** Whether a host record's documents are in the formats this build writes:
 * it names every member type, and every type it names is registered at its
 * written format. The host opens the documents of no other record. Registering
 * a new type therefore leaves existing records open. `written` and `members`
 * default to this build's. */
export function recordFormatsWritten(record, written = WRITTEN_FORMATS, members = MEMBER_TYPES) {
  const formats = recordDocumentFormats(record);
  if (!formats || typeof formats !== "object" || Array.isArray(formats)) return false;
  return (
    members.every((type) => Object.hasOwn(formats, type)) &&
    Object.keys(formats).every(
      (type) => Object.hasOwn(written, type) && formats[type] === written[type],
    )
  );
}

/** The refusal for a request that would open, read or write the documents
 * of a record recordFormatsWritten rejects. The owner still lists, trashes,
 * restores and permanently deletes the Page. */
export function documentFormatsUnsupported() {
  return Object.assign(
    Error(
      "This Page is stored in a format this version of Pages doesn't open. Its owner can delete it.",
    ),
    { status: 409, code: "document_format_unsupported" },
  );
}

/** `{ type, format }` pairs of a `{ type: format }` map. */
export function formatPairs(formats) {
  return Object.entries(formats).map(([type, format]) => ({ type, format }));
}

/** Project the host's existing IDs at `formats` (a record's, from
 * recordDocumentFormats) without minting, persisting or converting
 * documents. Omit comments when the host has no comments handle to
 * advertise, sources when the Page has no sources document, and views when
 * it has none. `viewDocumentIds` is `{ [view_id]: documentId }`; each view's
 * format is stored with the host's key for it, not in `formats`. */
export function pageDocuments(
  formats,
  documentId,
  commentsDocumentId,
  sourcesDocumentId,
  viewDocumentIds,
) {
  return {
    page: { id: documentId, type: "pages.page", format: formats["pages.page"] },
    ...(commentsDocumentId !== undefined && {
      comments: {
        id: commentsDocumentId,
        type: "pages.comments",
        format: formats["pages.comments"],
      },
    }),
    ...(sourcesDocumentId !== undefined && {
      sources: {
        id: sourcesDocumentId,
        type: "pages.sources",
        format: formats["pages.sources"],
      },
    }),
    ...(viewDocumentIds && Object.keys(viewDocumentIds).length && { views: viewDocumentIds }),
  };
}

/** The formats this build reads, by type: `{ "pages.page": [3], ... }`. A
 * build receipt records this as `document_formats`. */
export function formatsByType() {
  return Object.fromEntries(
    Object.entries(DOCUMENT_TYPES).map(([type, formats]) => [
      type,
      Object.keys(formats).map(Number),
    ]),
  );
}

/** The `{ type, format }` pairs this build reads. */
export function readableFormats() {
  return Object.entries(formatsByType()).flatMap(([type, formats]) =>
    formats.map((format) => ({ type, format })),
  );
}

/** Query-string form of a reader's formats: `pages.comments:2,pages.page:3`,
 * sorted so one build always sends one value. */
export function encodeDeclaredFormats(formats) {
  return formats
    .map(({ type, format }) => `${type}:${format}`)
    .sort()
    .join(",");
}

/** What this build sends as `formats` on a Page's socket. */
export const BUILD_FORMATS = encodeDeclaredFormats(readableFormats());

const MAX_DECLARED_FORMATS = 32;
const DECLARED_FORMAT = /^([a-z][a-z0-9.-]{0,63}):([1-9][0-9]{0,8})$/;
/** A client's formats from the `formats` query value. A missing or malformed
 * value is null. A well-formed type this build does not know is kept: a
 * client may read types this host has none of. */
export function parseDeclaredFormats(value) {
  if (typeof value !== "string") return null;
  const pairs = value.split(",");
  if (pairs.length > MAX_DECLARED_FORMATS || new Set(pairs).size !== pairs.length) return null;
  const formats = [];
  for (const pair of pairs) {
    const match = DECLARED_FORMAT.exec(pair);
    if (!match) return null;
    formats.push({ type: match[1], format: Number(match[2]) });
  }
  return formats;
}

/** The `required` pairs that `declared` does not list. */
export function missingFormats(declared, required) {
  return required.filter(
    (need) => !declared.some(({ type, format }) => type === need.type && format === need.format),
  );
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
