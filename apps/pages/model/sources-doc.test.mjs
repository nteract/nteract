import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import {
  MAX_SOURCES,
  listSources,
  readSource,
  setSources,
  sourcesGenesis,
  validateSourceBatch,
} from "./sources-doc.mjs";

const PARQUET = "application/vnd.apache.parquet";
const first = "a".repeat(64),
  second = "b".repeat(64),
  third = "c".repeat(64);
const uuid = "5e0c1a4e-7d2b-4c1e-9f3a-0b1c2d3e4f50";
const mediaTypes = new Map([first, second, third].map((id) => [id, PARQUET]));
const op = (fields = {}) => ({
  op: "set_source",
  source_id: "usage",
  name: "Tool usage",
  asset_id: first,
  source_revision: null,
  ...fields,
});
const write = (doc, operations, principal = "user:test:owner") =>
  A.change(doc, (draft) => {
    setSources(draft, operations, { mediaTypes, principal });
  });
const initial = () => write(A.clone(sourcesGenesis(uuid)), [op()]);

test("the genesis is a pure function of the document id", () => {
  const one = sourcesGenesis(uuid);
  const two = sourcesGenesis(uuid);
  assert.deepEqual(A.getHeads(one), A.getHeads(two));
  assert.deepEqual(A.save(one), A.save(two));
  assert.deepEqual({ ...one }, { sources: {} });
  assert.notDeepEqual(
    A.getHeads(sourcesGenesis("5e0c1a4e-7d2b-4c1e-9f3a-0b1c2d3e4f51")),
    A.getHeads(one),
  );
  assert.throws(() => sourcesGenesis("not-a-uuid"), /Invalid sources document id/);
});

test("create, rename and refresh mint one revision per write and survive save and load", () => {
  let doc = initial();
  assert.deepEqual(readSource(doc, "usage"), {
    source_id: "usage",
    name: "Tool usage",
    source_revision: "1",
    asset_id: first,
    media_type: PARQUET,
    producer: { kind: "upload", principal: "user:test:owner" },
  });
  doc = write(doc, [op({ name: "  Renamed  ", source_revision: "1" })]);
  assert.equal(readSource(doc, "usage").name, "Renamed");
  assert.equal(readSource(doc, "usage").source_revision, "2");
  assert.equal(readSource(doc, "usage").asset_id, first);
  doc = write(doc, [op({ name: "Renamed", asset_id: second, source_revision: "2" })], "user:b");
  const loaded = A.load(A.save(doc));
  assert.deepEqual(readSource(loaded, "usage"), {
    source_id: "usage",
    name: "Renamed",
    source_revision: "3",
    asset_id: second,
    media_type: PARQUET,
    producer: { kind: "upload", principal: "user:b" },
  });
  assert.deepEqual(listSources(loaded), [
    {
      source_id: "usage",
      name: "Renamed",
      source_revision: "3",
      asset_id: second,
      media_type: PARQUET,
    },
  ]);
});

test("a write records the media type it is given, not one the caller names", () => {
  const types = new Map([[first, "application/x-other"]]);
  const doc = A.change(A.clone(sourcesGenesis(uuid)), (draft) => {
    setSources(draft, [op()], { mediaTypes: types, principal: "p" });
  });
  assert.equal(readSource(doc, "usage").media_type, "application/x-other");
  assert.throws(
    () =>
      A.change(A.clone(sourcesGenesis(uuid)), (draft) => {
        setSources(draft, [op()], { mediaTypes: new Map(), principal: "p" });
      }),
    /no checked media type/,
  );
});

test("a stale, missing or ambiguous revision is refused with the current one", () => {
  const doc = initial();
  for (const [revision, code, current] of [
    [null, "stale_source", "1"],
    ["2", "stale_source", "1"],
  ])
    assert.throws(
      () => write(A.clone(doc), [op({ source_revision: revision })]),
      (error) =>
        error.code === code &&
        error.status === 409 &&
        error.details.source_id === "usage" &&
        error.details.source_revision === current,
    );
  assert.throws(
    () => write(A.clone(doc), [op({ source_id: "missing", source_revision: "1" })]),
    (error) =>
      error.code === "source_not_found" &&
      error.status === 404 &&
      error.details.source_revision === null,
  );
});

test("every malformed field is invalid_source, before anything is written", () => {
  for (const bad of [
    { source_id: "Usage" },
    { source_id: "1usage" },
    { source_id: "a/b" },
    { source_id: "" },
    { source_id: "a".repeat(65) },
    { source_id: "__proto__" },
    { source_id: "constructor" },
    { source_id: 7 },
    { name: "" },
    { name: "   " },
    { name: "x".repeat(201) },
    { name: 3 },
    { asset_id: "bad" },
    { asset_id: "A".repeat(64) },
    { source_revision: "0" },
    { source_revision: "01" },
    { source_revision: 1 },
    { source_revision: undefined },
    { expected_revision: null },
    { media_type: PARQUET },
  ]) {
    const operation = op(bad);
    if (Object.hasOwn(bad, "source_revision") && bad.source_revision === undefined)
      delete operation.source_revision;
    assert.throws(
      () => validateSourceBatch([operation]),
      (error) => error.code === "invalid_source" && error.status === 400,
      JSON.stringify(bad),
    );
  }
  assert.throws(() => validateSourceBatch([]), { code: "invalid_source" });
  assert.throws(() => validateSourceBatch([op(), op({ name: "Again" })]), {
    code: "invalid_source",
    message: "A batch cannot set the same source twice",
  });
  assert.deepEqual(validateSourceBatch([op(), op({ source_id: "b", asset_id: first })]), [first]);
});

test("a Page holds at most 64 sources; changing one at the cap still works", () => {
  const operations = Array.from({ length: MAX_SOURCES }, (_, i) =>
    op({ source_id: `s${i}`, asset_id: first }),
  );
  let doc = write(A.clone(sourcesGenesis(uuid)), operations);
  assert.equal(listSources(doc).length, MAX_SOURCES);
  const heads = A.getHeads(doc);
  assert.throws(() => write(A.clone(doc), [op({ source_id: "one-more" })]), {
    code: "invalid_source",
  });
  assert.deepEqual(A.getHeads(doc), heads);
  doc = write(doc, [op({ source_id: "s0", asset_id: second, source_revision: "1" })]);
  assert.equal(readSource(doc, "s0").asset_id, second);
});

test("a failed operation leaves the batch's earlier operations unapplied", () => {
  const doc = initial();
  const heads = A.getHeads(doc);
  assert.throws(
    () =>
      write(A.clone(doc), [
        op({ source_id: "daily", asset_id: second }),
        op({ source_revision: "9" }),
      ]),
    { code: "stale_source" },
  );
  assert.deepEqual(A.getHeads(doc), heads);
  assert.deepEqual(
    listSources(doc).map((source) => source.source_id),
    ["usage"],
  );
});

test("reads refuse malformed and unknown ids; a Page with no document lists none", () => {
  const doc = initial();
  for (const id of ["__proto__", "constructor", "prototype", "", "a/b", true])
    assert.throws(() => readSource(doc, id), { code: "invalid_source" });
  assert.throws(() => readSource(doc, "missing"), { code: "source_not_found", status: 404 });
  assert.deepEqual(listSources(undefined), []);
  assert.throws(() => readSource(undefined, "usage"), { code: "source_not_found" });
});

test("concurrent host candidates never tear an asset from its media type, and distinct sources survive", () => {
  const base = initial();
  const left = write(A.clone(base), [
    op({ asset_id: second, source_revision: "1" }),
    op({ source_id: "daily" }),
  ]);
  const right = write(A.clone(base), [
    op({ asset_id: third, source_revision: "1" }),
    op({ source_id: "latency" }),
  ]);
  const merged = A.merge(left, right);
  const value = readSource(merged, "usage");
  assert.ok([second, third].includes(value.asset_id));
  assert.equal(value.media_type, PARQUET);
  assert.equal(value.source_revision, "2");
  assert.equal(listSources(merged).length, 3);
  // Both candidates stay recoverable as conflicts. The host writes one
  // source at a time in the Page's queue, so it never accepts both.
  assert.equal(Object.keys(A.getConflicts(merged.sources.usage, "current")).length, 2);
});

test("a stored record no host write produces reads as invalid_source", () => {
  const doc = A.change(A.clone(sourcesGenesis(uuid)), (draft) => {
    draft.sources.broken = { name: "x", revision: "1", current: { asset_id: first } };
  });
  assert.throws(() => readSource(doc, "broken"), { code: "invalid_source" });
  assert.throws(() => listSources(doc), { code: "invalid_source" });
});
