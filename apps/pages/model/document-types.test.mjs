import assert from "node:assert/strict";
import test from "node:test";
import {
  DOCUMENT_TYPES,
  BUILD_FORMATS,
  UNSTAMPED_RECORD_FORMATS,
  WRITTEN_FORMATS,
  documentFormatsUnsupported,
  encodeDeclaredFormats,
  formatPairs,
  formatsByType,
  missingFormats,
  pageDocuments,
  parseDeclaredFormats,
  parseDocumentDescriptor,
  readableFormats,
  recordDocumentFormats,
  recordFormatsWritten,
} from "./document-types.mjs";

test("the registry names Page format 2 and comments format 1", () => {
  assert.deepEqual(DOCUMENT_TYPES, {
    "pages.page": { 2: { type: "pages.page", format: 2 } },
    "pages.comments": { 1: { type: "pages.comments", format: 1 } },
  });
  assert.ok(Object.isFrozen(DOCUMENT_TYPES));
  for (const formats of Object.values(DOCUMENT_TYPES)) {
    assert.ok(Object.isFrozen(formats));
    for (const descriptor of Object.values(formats)) assert.ok(Object.isFrozen(descriptor));
  }
});

test("descriptors project the existing IDs, with optional comments", () => {
  assert.deepEqual(pageDocuments(WRITTEN_FORMATS, "existing-page"), {
    page: { id: "existing-page", type: "pages.page", format: 2 },
  });
  const documents = pageDocuments(WRITTEN_FORMATS, "existing-page", "existing-comments");
  assert.deepEqual(documents, {
    page: { id: "existing-page", type: "pages.page", format: 2 },
    comments: { id: "existing-comments", type: "pages.comments", format: 1 },
  });
  for (const descriptor of Object.values(documents)) {
    const withExtraField = { ...descriptor, future: "ignored" };
    assert.deepEqual(parseDocumentDescriptor(withExtraField), descriptor);
    assert.deepEqual(withExtraField, { ...descriptor, future: "ignored" });
  }
  documents.page.format = 99;
  assert.equal(pageDocuments(WRITTEN_FORMATS, "another-page").page.format, 2);
});

test("descriptors carry the formats they are given, not the build's", () => {
  assert.deepEqual(
    pageDocuments({ "pages.page": 99, "pages.comments": 7 }, "page-id", "comments-id"),
    {
      page: { id: "page-id", type: "pages.page", format: 99 },
      comments: { id: "comments-id", type: "pages.comments", format: 7 },
    },
  );
});

test("a host record's formats are its documentFormats stamp", () => {
  assert.deepEqual(WRITTEN_FORMATS, { "pages.page": 2, "pages.comments": 1 });
  assert.ok(Object.isFrozen(WRITTEN_FORMATS));
  const stamped = { pageId: "p", documentFormats: { "pages.page": 99, "pages.comments": 1 } };
  assert.deepEqual(recordDocumentFormats(stamped), stamped.documentFormats);
  assert.equal(recordFormatsWritten(stamped), false);
  assert.equal(recordFormatsWritten({ documentFormats: { ...WRITTEN_FORMATS } }), true);
});

test("an unstamped record reads as the formats this build writes", () => {
  // UNSTAMPED_RECORD_FORMATS names pages.page 2 and pages.comments 1. The
  // build that changes either format deletes it, and this test with it.
  assert.deepEqual(UNSTAMPED_RECORD_FORMATS, WRITTEN_FORMATS);
  assert.deepEqual(recordDocumentFormats({ pageId: "p" }), WRITTEN_FORMATS);
  assert.equal(recordFormatsWritten({ pageId: "p" }), true);
});

test("a record names exactly the registered types at their written formats", () => {
  for (const documentFormats of [
    { "pages.page": 2 },
    { "pages.comments": 1 },
    { "pages.page": 2, "pages.comments": 2 },
    { "pages.page": 1, "pages.comments": 1 },
    { "pages.page": "2", "pages.comments": 1 },
    { "pages.page": 2, "pages.comments": 1, "pages.future": 1 },
    { "pages.page": 2, "pages.future": 1 },
    {},
    [],
    null,
    "pages.page:2",
  ])
    assert.equal(recordFormatsWritten({ documentFormats }), false, JSON.stringify(documentFormats));
});

test("an unopened record's refusal is a 409 stored_form_unsupported", () => {
  const error = documentFormatsUnsupported();
  assert.equal(error.status, 409);
  assert.equal(error.code, "stored_form_unsupported");
  assert.doesNotMatch(error.message, /reload/i);
});

test("descriptor parsing rejects unknown types and formats without coercion", () => {
  const known = { id: "existing", type: "pages.page", format: 2 };
  for (const type of [
    "pages.future",
    "pages.project",
    "pages.page@1",
    "constructor",
    "__proto__",
    "",
  ])
    assert.equal(parseDocumentDescriptor({ ...known, type }), null, type);
  const unregistered = { "pages.page": 1, "pages.comments": 2 };
  for (const [type, format] of Object.entries(unregistered))
    assert.equal(parseDocumentDescriptor({ ...known, type, format }), null, `${type}@${format}`);
  for (const type of Object.keys(DOCUMENT_TYPES))
    for (const format of [0, -1, 1.5, "1", null, undefined, NaN, Infinity, 2 ** 53])
      assert.equal(parseDocumentDescriptor({ ...known, type, format }), null, `${type}@${format}`);
});

test("descriptor parsing rejects malformed values and preserves opaque IDs", () => {
  for (const value of [
    null,
    undefined,
    true,
    1,
    "pages.page@2",
    [],
    {},
    { type: "pages.page", format: 2 },
  ])
    assert.equal(parseDocumentDescriptor(value), null);
  for (const id of ["", null, undefined, 1, {}, []])
    assert.equal(parseDocumentDescriptor({ id, type: "pages.page", format: 2 }), null);
  const descriptor = { id: "host-owned-id", type: "pages.comments", format: 1 };
  assert.deepEqual(parseDocumentDescriptor(descriptor), descriptor);
  assert.notEqual(parseDocumentDescriptor(descriptor), descriptor);
});

test("a build reads and writes the formats the registry lists", () => {
  assert.deepEqual(formatsByType(), { "pages.page": [2], "pages.comments": [1] });
  assert.deepEqual(readableFormats(), [
    { type: "pages.page", format: 2 },
    { type: "pages.comments", format: 1 },
  ]);
  assert.deepEqual(formatPairs(WRITTEN_FORMATS), readableFormats());
  assert.equal(BUILD_FORMATS, "pages.comments:1,pages.page:2");
});

test("declared formats encode sorted and parse back", () => {
  const formats = [
    { type: "pages.page", format: 1 },
    { type: "pages.comments", format: 1 },
    { type: "pages.page", format: 2 },
  ];
  const value = encodeDeclaredFormats(formats);
  assert.equal(value, "pages.comments:1,pages.page:1,pages.page:2");
  assert.deepEqual(parseDeclaredFormats(value), [
    { type: "pages.comments", format: 1 },
    { type: "pages.page", format: 1 },
    { type: "pages.page", format: 2 },
  ]);
  assert.deepEqual(missingFormats(parseDeclaredFormats(BUILD_FORMATS), readableFormats()), []);
});

test("no formats value parses to null", () => {
  assert.equal(parseDeclaredFormats(undefined), null);
});

test("declared formats that are malformed parse to null", () => {
  const tooMany = Array.from({ length: 33 }, (_, i) => `pages.t${i}:1`).join(",");
  for (const value of [
    null,
    1,
    ["pages.page:1"],
    "",
    "pages.page",
    "pages.page:",
    ":1",
    "pages.page:x",
    "pages.page:1.5",
    "pages.page:0",
    "pages.page:-1",
    "pages.page:01",
    "pages.page:1,",
    ",pages.page:1",
    "pages.page:1,,pages.comments:1",
    "pages.page:1,pages.page:1",
    "pages.page:1:1",
    "Pages.Page:1",
    tooMany,
  ])
    assert.equal(parseDeclaredFormats(value), null, String(value));
});

test("a well-formed type this build does not know is not malformed", () => {
  assert.deepEqual(parseDeclaredFormats("pages.future:3,pages.page:1"), [
    { type: "pages.future", format: 3 },
    { type: "pages.page", format: 1 },
  ]);
});

test("missing formats are the required pairs the client does not list", () => {
  const required = [
    { type: "pages.page", format: 2 },
    { type: "pages.comments", format: 1 },
  ];
  assert.deepEqual(missingFormats(readableFormats(), required), []);
  assert.deepEqual(missingFormats([{ type: "pages.page", format: 2 }], required), [
    { type: "pages.comments", format: 1 },
  ]);
  assert.deepEqual(missingFormats([{ type: "pages.page", format: 1 }], required), required);
  assert.deepEqual(missingFormats([], required), required);
});
