// The view projection: a ready view document, one that isn't on this Page,
// one this build can't read, and malformed ones, and the stream over a view
// replica that emits only when the drawing would change.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { BehaviorSubject } from "rxjs";
import { Store } from "./store.mjs";
import {
  VIEW_MEDIA_TYPE,
  VIEW_SENTENCES,
  projectView,
  viewProjection,
  viewStore,
} from "./view-store.mjs";

const spec = {
  mark: "bar",
  data: { name: "sales" },
  encoding: {
    x: { field: "region", type: "nominal" },
    y: { field: "total", type: "quantitative" },
  },
};
/** A view document as the host writes it: `spec` is Automerge text. */
const viewDoc = (fields = {}) =>
  A.from({
    title: "Sales by region",
    media_type: VIEW_MEDIA_TYPE,
    spec: JSON.stringify(spec),
    data: { sales: { source_id: "sales" } },
    revision: "1",
    producer: { kind: "agent", at: "2026-11-12T00:00:00.000Z", by: { principal: "a" } },
    ...fields,
  });

test("a ready view document projects its title, parsed spec, bindings and revision", () => {
  const projection = projectView("sales", viewDoc());
  assert.equal(projection.status, "ready");
  const { view } = projection;
  assert.equal(view.view_id, "sales");
  assert.equal(view.title, "Sales by region");
  assert.equal(projectView("sales", viewDoc({ title: " Sales " })).view.title, "Sales");
  assert.equal(view.media_type, VIEW_MEDIA_TYPE);
  assert.deepEqual(view.spec, spec);
  assert.deepEqual({ ...view.data }, { sales: { source_id: "sales" } });
  assert.equal(view.revision, "1");
  const pinned = projectView(
    "sales",
    viewDoc({ data: { sales: { source_id: "sales", revision: "3" } } }),
  );
  assert.deepEqual({ ...pinned.view.data }, { sales: { source_id: "sales", revision: "3" } });
});

test("a view the host holds no document for isn't on this Page", () => {
  for (const state of [{ name: "absent" }, { name: "absent", id: "x", cooling: true }])
    assert.deepEqual(viewProjection("sales", state, undefined), {
      status: "unavailable",
      reason: "missing",
      sentence: VIEW_SENTENCES.missing,
    });
  // While the replica still looks, the view is pending, not missing.
  for (const name of ["closed", "opening", "retrying"])
    assert.deepEqual(viewProjection("sales", { name }, undefined), { status: "pending" });
});

test("a view this build can't read says so", () => {
  assert.equal(viewProjection("sales", { name: "unserved" }).reason, "unreadable");
  assert.equal(viewProjection("sales", { name: "unreadable" }).reason, "unreadable");
  const other = projectView("sales", viewDoc({ media_type: "application/vnd.vegalite.v7+json" }));
  assert.equal(other.reason, "unreadable");
  assert.equal(other.sentence, "This build can't show application/vnd.vegalite.v7+json.");
  assert.equal(viewProjection("sales", { name: "failed" }).reason, "failed");
  assert.equal(viewProjection("sales", { name: "retired" }).reason, "closed");
});

test("a malformed view document draws nothing and says it can't be read", () => {
  const malformed = [
    viewDoc({ title: "" }),
    viewDoc({ title: "x".repeat(201) }),
    viewDoc({ title: `x${" ".repeat(200)}` }),
    viewDoc({ title: `x${" ".repeat(10_000)}` }),
    viewDoc({ title: 7 }),
    viewDoc({ spec: "{not json" }),
    viewDoc({ spec: "[1, 2]" }),
    viewDoc({ revision: "01" }),
    viewDoc({ revision: 1 }),
    viewDoc({ data: [] }),
    viewDoc({ data: { sales: { source_id: "Sales" } } }),
    viewDoc({ data: { sales: { source_id: "sales", revision: "x" } } }),
    viewDoc({ data: { sales: { source_id: "sales", extra: true } } }),
    viewDoc({ media_type: 3 }),
  ];
  for (const doc of malformed)
    assert.deepEqual(projectView("sales", doc), {
      status: "unavailable",
      reason: "malformed",
      sentence: VIEW_SENTENCES.malformed,
    });
  assert.equal(projectView("sales", null).reason, "missing", "no record holds no view");
});

test("the stream emits the current projection, then only changes that draw differently", () => {
  const state = new Store({ name: "closed" });
  const doc$ = new BehaviorSubject(undefined);
  const seen = [];
  viewStore("sales", { state$: state, doc$ }).subscribe((p) => seen.push(p));
  assert.deepEqual(
    seen.map((p) => p.status),
    ["pending"],
  );
  state.update(() => ({ name: "opening", attempt: 1, id: "d", via: "derived" }));
  assert.equal(seen.length, 1, "still pending");
  let doc = viewDoc();
  state.update(() => ({ name: "ready", id: "d" }));
  doc$.next(doc);
  assert.equal(seen.at(-1).status, "ready");
  const count = seen.length;
  // A change that leaves the view the same (the producer) emits nothing.
  doc = A.change(doc, (d) => {
    d.producer.at = "2026-11-12T00:00:01.000Z";
  });
  doc$.next(doc);
  assert.equal(seen.length, count);
  // The host rewrites the view: a new revision draws again.
  doc = A.change(doc, (d) => {
    A.updateText(d, ["spec"], JSON.stringify({ ...spec, mark: "line" }));
    d.revision = "2";
  });
  doc$.next(doc);
  assert.equal(seen.length, count + 1);
  assert.equal(seen.at(-1).view.spec.mark, "line");
  assert.equal(seen.at(-1).view.revision, "2");
});

test("a data name no host write stores makes the view malformed", () => {
  // Automerge refuses a `__proto__` key, so this value is a plain object; a
  // `constructor` key could reach the viewer from a stored document.
  const plain = {
    ...JSON.parse(JSON.stringify(viewDoc())),
    data: JSON.parse('{"__proto__": {"source_id": "sales"}}'),
  };
  assert.equal(projectView("sales", plain).reason, "malformed");
  const stored = projectView("sales", viewDoc({ data: { constructor: { source_id: "costs" } } }));
  assert.equal(stored.reason, "malformed");
});

test("a stored view document with no revision yet isn't on this Page until its write lands", () => {
  for (const doc of [{}, A.from({}), A.from({ title: "Only a title", spec: "", data: {} })])
    assert.equal(projectView("sales", doc).reason, "missing");
  assert.equal(viewProjection("sales", { name: "ready", id: "d" }, {}).reason, "missing");
});
