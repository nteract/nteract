import assert from "node:assert/strict";
import test from "node:test";
import {
  DOCUMENT_TYPES,
  currentFormats,
  BUILD_FORMATS,
  encodeDeclaredFormats,
  formatsByType,
  missingFormats,
  pageDocuments,
  parseDeclaredFormats,
  parseDocumentDescriptor,
  readableFormats,
} from "./document-types.mjs";

test("the registry names only the existing Page and comments formats", () => {
  assert.deepEqual(DOCUMENT_TYPES, {
    "pages.page": { 1: { type: "pages.page", format: 1 } },
    "pages.comments": { 1: { type: "pages.comments", format: 1 } },
  });
  assert.ok(Object.isFrozen(DOCUMENT_TYPES));
  for (const formats of Object.values(DOCUMENT_TYPES)) {
    assert.ok(Object.isFrozen(formats));
    for (const descriptor of Object.values(formats)) assert.ok(Object.isFrozen(descriptor));
  }
});

test("descriptors project the existing IDs, with optional comments", () => {
  assert.deepEqual(pageDocuments("existing-page"), {
    page: { id: "existing-page", type: "pages.page", format: 1 },
  });
  const documents = pageDocuments("existing-page", "existing-comments");
  assert.deepEqual(documents, {
    page: { id: "existing-page", type: "pages.page", format: 1 },
    comments: { id: "existing-comments", type: "pages.comments", format: 1 },
  });
  for (const descriptor of Object.values(documents)) {
    const withExtraField = { ...descriptor, future: "ignored" };
    assert.deepEqual(parseDocumentDescriptor(withExtraField), descriptor);
    assert.deepEqual(withExtraField, { ...descriptor, future: "ignored" });
  }
  documents.page.format = 99;
  assert.equal(pageDocuments("another-page").page.format, 1);
});

test("descriptor parsing rejects unknown types and formats without coercion", () => {
  const known = { id: "existing", type: "pages.page", format: 1 };
  for (const type of [
    "pages.future",
    "pages.project",
    "pages.page@1",
    "constructor",
    "__proto__",
    "",
  ])
    assert.equal(parseDocumentDescriptor({ ...known, type }), null, type);
  for (const type of Object.keys(DOCUMENT_TYPES))
    for (const format of [0, -1, 2, 1.5, "1", null, undefined, NaN, Infinity, 2 ** 53])
      assert.equal(parseDocumentDescriptor({ ...known, type, format }), null, `${type}@${format}`);
});

test("descriptor parsing rejects malformed values and preserves opaque IDs", () => {
  for (const value of [
    null,
    undefined,
    true,
    1,
    "pages.page@1",
    [],
    {},
    { type: "pages.page", format: 1 },
  ])
    assert.equal(parseDocumentDescriptor(value), null);
  for (const id of ["", null, undefined, 1, {}, []])
    assert.equal(parseDocumentDescriptor({ id, type: "pages.page", format: 1 }), null);
  const descriptor = { id: "host-owned-id", type: "pages.comments", format: 1 };
  assert.deepEqual(parseDocumentDescriptor(descriptor), descriptor);
  assert.notEqual(parseDocumentDescriptor(descriptor), descriptor);
});

test("a build reads and writes the formats the registry lists", () => {
  assert.deepEqual(formatsByType(), { "pages.page": [1], "pages.comments": [1] });
  assert.deepEqual(readableFormats(), [
    { type: "pages.page", format: 1 },
    { type: "pages.comments", format: 1 },
  ]);
  assert.deepEqual(currentFormats(), readableFormats());
  assert.equal(BUILD_FORMATS, "pages.comments:1,pages.page:1");
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

test("no formats value is a build from before the parameter: format 1 only", () => {
  const undeclared = parseDeclaredFormats(undefined);
  assert.deepEqual(undeclared, [
    { type: "pages.page", format: 1 },
    { type: "pages.comments", format: 1 },
  ]);
  assert.deepEqual(missingFormats(undeclared, currentFormats()), []);
  const format2 = [{ type: "pages.page", format: 2 }];
  assert.deepEqual(missingFormats(undeclared, format2), format2);
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
    { type: "pages.page", format: 1 },
    { type: "pages.comments", format: 1 },
  ];
  assert.deepEqual(missingFormats(readableFormats(), required), []);
  assert.deepEqual(missingFormats([{ type: "pages.page", format: 1 }], required), [
    { type: "pages.comments", format: 1 },
  ]);
  assert.deepEqual(missingFormats([{ type: "pages.page", format: 2 }], required), required);
  assert.deepEqual(missingFormats([], required), required);
});
