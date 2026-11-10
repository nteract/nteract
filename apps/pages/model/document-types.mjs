// Host-owned document identities, independent of Automerge content and the
// additive schema-feature gates. Project content uses pages.page too.
// A build reads every format registered here and writes the highest one of
// each type.
export const DOCUMENT_TYPES = Object.freeze({
  "pages.page": Object.freeze({
    1: Object.freeze({ type: "pages.page", format: 1 }),
  }),
  "pages.comments": Object.freeze({
    1: Object.freeze({ type: "pages.comments", format: 1 }),
  }),
});

/** The format this build writes for `type`: the highest one registered. */
function currentFormat(type) {
  return Math.max(...Object.keys(DOCUMENT_TYPES[type]).map(Number));
}

/** Project the host's existing IDs without minting, persisting or converting
 * documents. Omit comments when the host has no comments handle to advertise. */
export function pageDocuments(documentId, commentsDocumentId) {
  return {
    page: { id: documentId, ...DOCUMENT_TYPES["pages.page"][currentFormat("pages.page")] },
    ...(commentsDocumentId !== undefined && {
      comments: {
        id: commentsDocumentId,
        ...DOCUMENT_TYPES["pages.comments"][currentFormat("pages.comments")],
      },
    }),
  };
}

/** The formats this build reads, by type: `{ "pages.page": [1], ... }`. A
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

/** The format this build writes for each of `types`, as `{ type, format }` pairs. */
export function currentFormats(types) {
  return types.map((type) => ({ type, format: currentFormat(type) }));
}

/** Query-string form of a reader's formats: `pages.comments:1,pages.page:1`,
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
/** A client's declared formats from the `formats` query value. No value
 * declares nothing. A malformed value is null. A well-formed type this build
 * does not know is kept: a client may read types this host has none of. */
export function parseDeclaredFormats(value) {
  if (value === undefined) return [];
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
