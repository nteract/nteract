// A view's own document (model/view-doc.mjs) and the spec check its write
// runs (shared/view-spec.mjs). The host contract is worker/views.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  checkView,
  readView,
  setView,
  validateViewOperation,
  viewGenesis,
  viewSummary,
} from "./view-doc.mjs";
import { setSources, sourcesGenesis } from "./sources-doc.mjs";
import { checkChartSpec } from "../shared/chart-spec.mjs";
import { VIEW_SPEC_MAX_BYTES, checkViewSpec } from "../shared/view-spec.mjs";

const uuid = "11111111-1111-4111-8111-111111111111";
const by = { principal: "account:a", displayName: "A", driver: "Agent" };
const SPEC = { data: { name: "usage" }, mark: "bar", encoding: { x: { field: "day" } } };
const op = (fields = {}) => ({
  op: "set_view",
  view_id: "daily",
  title: "Daily",
  media_type: "application/vnd.vegalite.v6+json",
  spec: SPEC,
  data: { usage: { source_id: "usage" } },
  view_revision: null,
  ...fields,
});
/** A sources document whose `usage` source has revisions "1" to `count`. */
function sources(count = 2) {
  let doc = sourcesGenesis("22222222-2222-4222-8222-222222222222");
  for (let n = 1; n <= count; n++)
    doc = A.change(doc, (draft) =>
      setSources(
        draft,
        [
          {
            op: "set_source",
            source_id: "usage",
            name: "Usage",
            asset_id: String(n % 10).repeat(64),
            source_revision: n === 1 ? null : String(n - 1),
          },
        ],
        {
          mediaTypes: new Map([[String(n % 10).repeat(64), "application/vnd.apache.parquet"]]),
          by,
        },
      ),
    );
  return doc;
}

test("a view's genesis is fixed by its id and holds no view", () => {
  const [a, b] = [viewGenesis(uuid), viewGenesis(uuid)];
  assert.deepEqual(A.getHeads(a), A.getHeads(b));
  assert.equal(readView(a, "daily"), undefined);
  assert.equal(viewSummary(a, "daily"), undefined);
  assert.throws(() => viewGenesis("not-a-uuid"));
});

test("setView writes the view, mints revisions and replaces the spec as text", () => {
  const sourcesDoc = sources();
  let doc = A.change(viewGenesis(uuid), (draft) => {
    assert.deepEqual(setView(draft, op(), { sourcesDoc, by }), {
      op: "set_view",
      view_id: "daily",
      view_revision: "1",
    });
  });
  assert.deepEqual(viewSummary(doc, "daily"), {
    view_id: "daily",
    title: "Daily",
    media_type: "application/vnd.vegalite.v6+json",
    revision: "1",
    data: { usage: { source_id: "usage" } },
  });
  assert.deepEqual(readView(doc, "daily").spec, SPEC);
  const before = A.getHeads(doc);
  const spec = { ...SPEC, mark: "line" };
  doc = A.change(doc, (draft) =>
    setView(
      draft,
      op({ spec, view_revision: "1", data: { usage: { source_id: "usage", revision: "1" } } }),
      {
        sourcesDoc,
        by,
      },
    ),
  );
  const view = readView(doc, "daily");
  assert.equal(view.revision, "2");
  assert.deepEqual(view.spec, spec);
  assert.deepEqual(view.data, { usage: { source_id: "usage", revision: "1" } });
  // The spec is edited in place: the patch splices text rather than setting
  // a new value.
  const patches = A.diff(doc, before, A.getHeads(doc));
  assert.ok(patches.some((patch) => patch.action === "splice" && patch.path[0] === "spec"));
  assert.ok(!patches.some((patch) => patch.action === "put" && patch.path[0] === "spec"));
});

test("a padded title is stored and read trimmed, and a stored title is bounded before any trim", () => {
  const sourcesDoc = sources();
  const doc = A.change(viewGenesis(uuid), (draft) =>
    setView(draft, op({ title: "  Daily  " }), { sourcesDoc, by }),
  );
  assert.equal(doc.title, "Daily");
  assert.equal(readView(doc, "daily").title, "Daily");

  const stored = (title) =>
    A.change(A.clone(doc), (draft) => {
      draft.title = title;
    });
  // A record the writer never stores: its trimmed text is what a reader sees.
  assert.equal(readView(stored(" Daily "), "daily").title, "Daily");
  assert.equal(readView(stored(`D${" ".repeat(199)}`), "daily").title, "D");
  for (const title of [`D${" ".repeat(200)}`, `D${" ".repeat(10_000)}`, "   "])
    assert.throws(() => readView(stored(title), "daily"), { code: "invalid_view" });
});

test("checkView refuses unknown sources, unheld pinned revisions and stale revisions", () => {
  const sourcesDoc = sources(2);
  const refusal = (fields, doc) => {
    try {
      checkView(doc, op(fields), { sourcesDoc });
    } catch (error) {
      return error.code;
    }
    return null;
  };
  assert.equal(refusal({}), null);
  assert.equal(refusal({ data: { usage: { source_id: "usage", revision: "2" } } }), null);
  assert.equal(refusal({ data: { usage: { source_id: "nope" } } }), "unknown_source");
  assert.equal(
    refusal({ data: { usage: { source_id: "usage", revision: "3" } } }),
    "unknown_source_revision",
  );
  assert.equal(refusal({ view_revision: "1" }), "view_not_found");
  const doc = A.change(viewGenesis(uuid), (draft) => setView(draft, op(), { sourcesDoc, by }));
  assert.equal(refusal({}, doc), "stale_view");
  assert.equal(refusal({ view_revision: "2" }, doc), "stale_view");
  assert.equal(refusal({ view_revision: "1" }, doc), null);
  // No sources document at all: every binding is unknown.
  assert.throws(
    () => checkView(undefined, op(), {}),
    (error) => error.code === "unknown_source",
  );
});

test("a pinned revision the source's history dropped can't be bound", () => {
  // The history keeps the newest 50 states.
  const sourcesDoc = sources(52);
  assert.throws(
    () =>
      checkView(undefined, op({ data: { usage: { source_id: "usage", revision: "2" } } }), {
        sourcesDoc,
      }),
    (error) => error.code === "unknown_source_revision",
  );
  assert.doesNotThrow(() =>
    checkView(undefined, op({ data: { usage: { source_id: "usage", revision: "3" } } }), {
      sourcesDoc,
    }),
  );
});

test("checkViewSpec runs checkChartSpec and its refusal reaches the caller as it is", () => {
  const data = { usage: { source_id: "usage" } };
  assert.deepEqual(checkViewSpec(SPEC, data), { ok: true, names: ["usage"] });
  for (const spec of [
    { ...SPEC, data: { url: "https://example.com/x.json" } },
    { ...SPEC, data: { values: [{ a: 1 }] } },
    { ...SPEC, transform: [{ calculate: "fetch('x')", as: "y" }] },
  ]) {
    const chart = checkChartSpec(spec, { datasets: ["usage"] });
    assert.equal(chart.ok, false);
    assert.deepEqual(checkViewSpec(spec, data), chart);
  }
  // A name the spec reads that data lacks.
  assert.deepEqual(checkViewSpec(SPEC, { other: { source_id: "usage" } }), {
    ok: false,
    error: 'The spec reads "usage", but data doesn\'t map it to a source.',
  });
  // Without data, the spec alone.
  assert.deepEqual(checkViewSpec(SPEC), { ok: true, names: ["usage"] });
  // A name data binds that the spec doesn't read.
  assert.deepEqual(checkViewSpec(SPEC, { ...data, extra: { source_id: "usage" } }), {
    ok: false,
    error: 'data names "extra", but the spec doesn\'t read it.',
  });
  assert.equal(checkViewSpec([], data).ok, false);
  assert.equal(checkViewSpec("{}", data).ok, false);
  const huge = { ...SPEC, description: "x".repeat(VIEW_SPEC_MAX_BYTES) };
  assert.deepEqual(checkViewSpec(huge, data), {
    ok: false,
    error: "spec must be 64 KiB or smaller.",
  });
});

test("a set_view refusal names the field it is about and the rule it broke", () => {
  const message = (fields) => {
    try {
      validateViewOperation(op(fields));
    } catch (error) {
      assert.equal(error.code, "invalid_view");
      return error.message;
    }
    assert.fail(`expected a refusal for ${JSON.stringify(fields)}`);
  };
  // A spec that can't draw is the problem, whatever data holds.
  for (const data of [{}, null, undefined, { usage: { source_id: "usage" } }]) {
    assert.equal(
      message({ spec: { ...SPEC, data: { url: "https://example.com/x.json" } }, data }),
      "A chart can't load data from a URL (at data).",
    );
    assert.equal(
      message({ spec: { ...SPEC, data: { values: [] } }, data }),
      "A chart reads named data, not inline values (at data).",
    );
    assert.match(message({ spec: { ...SPEC, mark: "bogus" }, data }), /^A chart's mark must be /);
  }
  // Empty data names what the spec reads.
  assert.equal(
    message({ data: {} }),
    'data must map each data name the spec reads ("usage") to a source: {"usage": {"source_id": "<source_id>"}}',
  );
  // A binding without a source_id says so, and never prints "undefined".
  assert.equal(
    message({ data: { usage: {} } }),
    "data.usage needs a source_id: a source this Page holds",
  );
  assert.equal(
    message({ data: { usage: { source_id: 7 } } }),
    "data.usage.source_id must be a string matching ^[a-z][a-z0-9_-]{0,63}$",
  );
  for (const fields of [{ data: { usage: {} } }, { data: { usage: { source_id: null } } }])
    assert.doesNotMatch(message(fields), /undefined|null/);
  assert.equal(
    message({ data: { other: { source_id: "usage" } } }),
    'The spec reads "usage", but data doesn\'t map it to a source.',
  );
});
