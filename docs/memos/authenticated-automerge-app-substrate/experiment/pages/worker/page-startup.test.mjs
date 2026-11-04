import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import {
  pageStartup,
  recordAnswerable,
  recordFallback,
  startupOf,
  storedTitleProjection,
} from "./page-startup.mjs";

const TABLE = new URL("../test/fixtures/machines/page-startup.json", import.meta.url);

test("the page-startup table covers every state and event", async () => {
  await runTable(pageStartup, loadTable(TABLE));
});

const record = {
  pageId: "33333333-3333-4333-8333-333333333333",
  owner: "user:anaconda:owner",
  documentId: "document",
  comments_doc: "c0000000-0000-4000-8000-000000000001",
  recordStorage: "buffered",
  deleted: false,
};
const projection = { title: "Launch plan", observed_at: "2026-10-20T10:00:00.000Z", keep: true };

test("only a current record without a creation intent starts lazily", () => {
  assert.equal(startupOf(undefined, undefined), "missing");
  assert.equal(startupOf(undefined, { metadata: record }), "eager");
  assert.equal(startupOf(record, { metadata: record }), "eager");
  assert.equal(startupOf(record, undefined), "lazy");
  assert.equal(startupOf({ ...record, recordStorage: undefined }, undefined), "lazy");
  assert.equal(startupOf({ ...record, recordStorage: "local" }, undefined), "lazy");
  assert.equal(startupOf({ ...record, recordStorage: "automerge" }, undefined), "lazy");
  // The boot refuses this mode; it fails in the constructor, as before.
  assert.equal(startupOf({ ...record, recordStorage: "remote" }, undefined), "eager");
  // The boot writes the comments document's name into an older record.
  const { comments_doc: _comments, ...unnamed } = record;
  assert.equal(recordAnswerable(unnamed), false);
  assert.equal(startupOf(unnamed, undefined), "eager");
  assert.equal(recordAnswerable({ ...record, documentId: undefined }), false);
  assert.equal(recordAnswerable(null), false);
});

test("a check falls back to the loaded host whenever the record can't answer it", () => {
  const inputs = { record, creation: undefined, projection, reportPending: undefined };
  assert.equal(recordFallback(inputs), null);
  assert.equal(recordFallback({ ...inputs, creation: { metadata: record } }), "creation_intent");
  assert.equal(recordFallback({ ...inputs, record: undefined }), "no_record");
  assert.equal(
    recordFallback({ ...inputs, record: { ...record, comments_doc: undefined } }),
    "legacy_record",
  );
  assert.equal(recordFallback({ ...inputs, reportPending: true }), "index_report_pending");
  assert.equal(recordFallback({ ...inputs, projection: undefined }), "no_stored_title");
  assert.equal(
    recordFallback({ ...inputs, projection: { ...projection, observed_at: "yesterday" } }),
    "no_stored_title",
  );
  // A trashed or deleted record needs no title: the caller refuses or boots.
  for (const state of [
    { deleted: true, trash: { trashed_at: "2026-10-20T10:00:00.000Z" } },
    { deleted: true },
  ])
    assert.equal(
      recordFallback({ ...inputs, record: { ...record, ...state }, projection: undefined }),
      null,
    );
});

test("a stored projection stands in for the title only with its observation time", () => {
  assert.deepEqual(storedTitleProjection(projection), projection);
  // A record from before `keep` existed still stands in; writers keep their time.
  const { keep: _keep, ...unflagged } = projection;
  assert.deepEqual(storedTitleProjection(unflagged), unflagged);
  assert.equal(storedTitleProjection({ ...projection, title: 7 }), null);
  assert.equal(storedTitleProjection({ title: "Launch plan" }), null);
  assert.equal(storedTitleProjection(undefined), null);
});
