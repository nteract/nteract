import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import {
  listPageSources,
  readPageSource,
  resolvePageBinding,
  setPageSource,
  sourceChangeRefusal,
} from "./page-sources.mjs";

const first = "a".repeat(64),
  second = "b".repeat(64),
  third = "c".repeat(64);
const args = { source_id: "usage", name: "Tool usage", asset_id: first, expected_revision: null };
const initial = () => A.change(A.from({ sources: {} }), (doc) => setPageSource(doc, args));

test("peer admission refuses root, nested, hidden and deleted source writes but allows prose", () => {
  const base = initial();
  for (const mutate of [
    (doc) => {
      doc.sources.usage.name = "Forged";
    },
    (doc) => {
      doc.sources.usage.current.asset_id = second;
    },
    (doc) => {
      delete doc.sources;
    },
    (doc) => {
      doc.sources = {};
    },
  ]) {
    const changed = A.change(A.clone(base), mutate);
    assert.equal(
      sourceChangeRefusal(changed, A.getChanges(base, changed)).code,
      "request_rejected",
    );
  }
  const prose = A.change(A.clone(base), (doc) => {
    doc.title = "Allowed";
  });
  assert.equal(sourceChangeRefusal(prose, A.getChanges(base, prose)), null);
  const left = A.change(A.clone(base), (doc) => {
    doc.sources = {};
  });
  const right = A.change(A.clone(base), (doc) => {
    doc.sources.usage.name = "Hidden change";
  });
  const merged = A.merge(left, right);
  assert.equal(sourceChangeRefusal(merged, A.getChanges(base, right)).code, "request_rejected");
});

test("named source rename and refresh preserve bindings through save/reload; pins retain their asset", () => {
  let doc = initial();
  const binding = { source_id: "usage" };
  doc = A.change(doc, (draft) =>
    setPageSource(draft, { ...args, name: "Renamed", expected_revision: "1" }),
  );
  assert.equal(resolvePageBinding(doc, binding).asset_id, first);
  doc = A.change(doc, (draft) =>
    setPageSource(draft, { ...args, asset_id: second, expected_revision: "2" }),
  );
  const loaded = A.load(A.save(doc));
  assert.deepEqual(resolvePageBinding(loaded, binding), {
    source_id: "usage",
    asset_id: second,
    source_revision: "3",
  });
  assert.deepEqual(resolvePageBinding(loaded, { asset_id: first }), { asset_id: first });
  assert.equal(listPageSources(loaded).length, 1);
});

test("concurrent refresh merge never tears asset/revision pairs, and distinct sources survive", () => {
  const base = initial();
  const left = A.change(A.clone(base), (doc) => {
    setPageSource(doc, { ...args, asset_id: second, expected_revision: "1" });
    setPageSource(doc, { ...args, source_id: "daily" });
  });
  const right = A.change(A.clone(base), (doc) => {
    setPageSource(doc, { ...args, asset_id: third, expected_revision: "1" });
    setPageSource(doc, { ...args, source_id: "latency" });
  });
  const merged = A.merge(left, right);
  const value = readPageSource(merged, "usage");
  assert.ok([second, third].includes(value.asset_id));
  assert.equal(value.source_revision, "2");
  assert.equal(listPageSources(merged).length, 3);
  // Conflicting candidates remain recoverable; host serialization must prevent
  // presenting both peer refreshes as accepted against the same revision.
  assert.equal(Object.keys(A.getConflicts(merged.sources.usage, "current")).length, 2);
});

test("stale, ambiguous and unsafe input is refused without modifying content", () => {
  const doc = initial();
  const before = A.getHeads(doc);
  assert.throws(() => A.change(A.clone(doc), (draft) => setPageSource(draft, args)), {
    code: "stale_source",
  });
  for (const source_id of ["__proto__", "constructor", "prototype", "", "a/b"])
    assert.throws(() => readPageSource(doc, source_id), { code: "invalid_source" });
  for (const binding of [{}, { source_id: "usage", asset_id: first }, { asset_id: "bad" }])
    assert.throws(() => resolvePageBinding(doc, binding), { code: "invalid_binding" });
  assert.throws(() => resolvePageBinding(doc, { source_id: "missing" }), {
    code: "source_not_found",
  });
  assert.deepEqual(A.getHeads(doc), before);
});
