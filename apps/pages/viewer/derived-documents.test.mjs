// The viewer derives a Page's sources document id the way its host names it.
import test from "node:test";
import assert from "node:assert/strict";
import { SOURCES_MODULE } from "../worker/document-modules.mjs";
import { derivedDocUuid, derivedDocumentId } from "../worker/comments-store.mjs";
import { SOURCES_LABEL, sourcesDocumentId } from "./derived-documents.mjs";

test("the sources document id is the one the host derives for the Page", async () => {
  assert.equal(SOURCES_LABEL, SOURCES_MODULE.derived.label);
  const pageId = crypto.randomUUID();
  const host = derivedDocumentId(await derivedDocUuid(SOURCES_MODULE.derived.label, pageId));
  assert.equal(await sourcesDocumentId(pageId), host);
  assert.notEqual(await sourcesDocumentId(crypto.randomUUID()), host);
});
