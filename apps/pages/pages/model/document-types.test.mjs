import assert from "node:assert/strict";
import test from "node:test";
import { DOCUMENT_TYPES, pageDocuments, parseDocumentDescriptor } from "./document-types.mjs";

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
