import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import featureFile from "./features.json" with { type: "json" };
import { MARK_REGISTRY } from "./marks.mjs";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import {
  BUILD_FEATURES,
  FEATURE_REGISTRY,
  MALFORMED_FEATURE,
  SCHEMA_GATE_INITIAL,
  documentFeatures,
  featureRegistry,
  installFeatureRegistryForTests,
  markFeatures,
  missingFeatures,
  parseDeclaredFeatures,
  requireSupportedSchema,
  schemaGate,
  schemaGateStep,
  spanFeatures,
  stampFeatures,
  unsupportedFeatures,
} from "./schema-features.mjs";

// A test-only registry: highlight and native tables become non-baseline.
const FIXTURE = featureRegistry(
  {
    version: 1,
    features: [
      { id: "test-highlight", description: "Highlights, for tests." },
      { id: "test-tables", description: "Native tables, for tests.", blocks: ["table"] },
    ],
  },
  {
    marks: MARK_REGISTRY.marks.map((mark) =>
      mark.name === "highlight" ? { ...mark, feature: "test-highlight" } : mark,
    ),
  },
);

function withFixture(t) {
  t.after(installFeatureRegistryForTests(FIXTURE));
}

const identity = { principal: "account:one", displayName: "One", driver: "Browser" };
function page(markdown = "We ship on Friday.") {
  return A.change(A.from(createPageData({ pageId: "page_fixture", title: "Plan" })), (draft) =>
    initializePage(draft, markdown),
  );
}
function edit(doc, operations) {
  return A.change(doc, (draft) =>
    applyPageOperation(draft, { operation: "edit_page", arguments: { operations } }),
  );
}
function patch(doc, operations) {
  return A.change(doc, (draft) =>
    applyPageOperation(draft, { operation: "patch_page", arguments: { operations } }),
  );
}
const stamped = (features) =>
  A.change(page(), (draft) => {
    draft.schema = { features };
  });

test("today's registry is all baseline", () => {
  assert.deepEqual(featureFile.features, []);
  assert.deepEqual(BUILD_FEATURES, []);
  assert.equal(
    MARK_REGISTRY.marks.some((mark) => mark.feature !== undefined),
    false,
  );
  assert.equal(FEATURE_REGISTRY.marks.size + FEATURE_REGISTRY.blocks.size, 0);
});

test("the registry refuses ids and references that don't line up", () => {
  const marks = { marks: [{ name: "em" }] };
  for (const [features, markFile, message] of [
    [{ features: [{ id: "Bad", description: "x" }] }, marks, /Invalid schema feature id/],
    [
      {
        features: [
          { id: "a", description: "x" },
          { id: "a", description: "y" },
        ],
      },
      marks,
      /listed twice/,
    ],
    [{ features: [{ id: "a" }] }, marks, /needs a description/],
    [
      {
        features: [
          { id: "a", description: "x", blocks: ["table"] },
          { id: "b", description: "y", blocks: ["table"] },
        ],
      },
      marks,
      /two schema features/,
    ],
    [{ features: [] }, { marks: [{ name: "em", feature: "nope" }] }, /unknown schema feature/],
  ])
    assert.throws(() => featureRegistry(features, markFile), message);
  assert.deepEqual(FIXTURE.ids, ["test-highlight", "test-tables"]);
});

test("an unstamped document is editable and reports no features", () => {
  const doc = page();
  assert.equal(doc.schema, undefined);
  assert.deepEqual(documentFeatures(doc), []);
  assert.deepEqual(unsupportedFeatures(doc), []);
  assert.deepEqual(schemaGate(doc), { editable: true, unsupported: [], refused: false });
  assert.doesNotThrow(() => requireSupportedSchema(doc));
});

test("the reader gate is the stamp minus the build's features", () => {
  const doc = stamped(["test-tables", "future-feature", "test-tables"]);
  assert.deepEqual(documentFeatures(doc), ["future-feature", "test-tables"]);
  assert.deepEqual(unsupportedFeatures(doc), ["future-feature", "test-tables"]);
  assert.deepEqual(unsupportedFeatures(doc, ["test-tables"]), ["future-feature"]);
  assert.deepEqual(unsupportedFeatures(doc, ["future-feature", "test-tables"]), []);
  assert.deepEqual(schemaGate(doc, ["test-tables"]), {
    editable: false,
    unsupported: ["future-feature"],
    refused: false,
  });
  assert.equal(schemaGate(doc, ["future-feature", "test-tables"]).editable, true);
  // Other keys under schema are ignored; only feature ids gate.
  const extended = A.change(page(), (draft) => {
    draft.schema = { note: "later" };
  });
  assert.deepEqual(unsupportedFeatures(extended), []);
});

test("a malformed stamp fails closed", () => {
  for (const schema of ["text", { features: "x" }, { features: [1] }]) {
    const doc = A.change(page(), (draft) => {
      draft.schema = schema;
    });
    assert.deepEqual(unsupportedFeatures(doc, FIXTURE.ids), [MALFORMED_FEATURE]);
    assert.throws(() => A.change(doc, (draft) => stampFeatures(draft, ["test-tables"])), {
      message: /malformed/,
    });
  }
});

test("the host refuses a write it can't express, with a code", () => {
  const doc = stamped(["future-feature"]);
  assert.throws(
    () => requireSupportedSchema(doc),
    (error) =>
      error.status === 409 &&
      error.code === "unsupported_schema_feature" &&
      error.details.features.join() === "future-feature" &&
      /future-feature/.test(error.message),
  );
  assert.doesNotThrow(() => requireSupportedSchema(doc, ["future-feature"]));
});

test("span and mark features follow the registry", () => {
  const spans = [
    { type: "block", value: { type: "table-cell", parents: ["table", "table-row"], attrs: {} } },
    { type: "text", value: "x", marks: { highlight: "yellow", strong: true } },
  ];
  assert.deepEqual(spanFeatures(spans, FIXTURE), ["test-highlight", "test-tables"]);
  assert.deepEqual(spanFeatures(spans), []);
  assert.deepEqual(markFeatures(["strong", "highlight"], FIXTURE), ["test-highlight"]);
  assert.deepEqual(markFeatures(["highlight"]), []);
});

test("baseline content never writes a stamp", (t) => {
  withFixture(t);
  let doc = page("Some **bold** and *em* text with [a link](https://example.org).");
  const id = orderedBlockIds(doc)[0];
  doc = patch(doc, [{ op: "format_match", block_id: id, match_text: "text", add: { code: true } }]);
  doc = A.change(doc, (draft) =>
    applyPageOperation(draft, {
      operation: "manage_page_comment",
      arguments: { action: "add", block_id: id, body: "**Looks** good", body_format: "markdown" },
      identity,
    }),
  );
  assert.equal(doc.schema, undefined);
});

test("a writer stamps a feature in the same change as the content needing it", (t) => {
  withFixture(t);
  const cases = [
    [
      "create",
      () => A.from(createPageData({ pageId: "page_fixture", title: "Plan" })),
      (draft) => initializePage(draft, "A <mark>flagged</mark> idea."),
      ["test-highlight"],
    ],
    [
      "insert_markdown",
      () => page(),
      (draft) =>
        applyPageOperation(draft, {
          operation: "edit_page",
          arguments: { operations: [{ op: "insert_markdown", markdown: "| a | b |\n| - | - |" }] },
        }),
      ["test-tables"],
    ],
    [
      "format_match",
      () => page(),
      (draft) =>
        applyPageOperation(draft, {
          operation: "patch_page",
          arguments: {
            operations: [
              {
                op: "format_match",
                block_id: orderedBlockIds(draft)[0],
                match_text: "Friday",
                add: { highlight: "green" },
              },
            ],
          },
        }),
      ["test-highlight"],
    ],
    [
      "comment",
      () => page(),
      (draft) =>
        applyPageOperation(draft, {
          operation: "manage_page_comment",
          arguments: {
            action: "add",
            block_id: orderedBlockIds(draft)[0],
            body: "Is <mark>this</mark> final?",
            body_format: "markdown",
          },
          identity,
        }),
      ["test-highlight"],
    ],
  ];
  for (const [name, start, write, expected] of cases) {
    const before = start();
    const after = A.change(before, write);
    assert.deepEqual(documentFeatures(after), expected, name);
    const changes = A.getChanges(before, after);
    assert.equal(changes.length, 1, `${name} writes one change`);
    // The change that carries the stamp also carries the content.
    const content = A.load(A.save(before));
    const [applied] = A.applyChanges(content, changes);
    assert.deepEqual(documentFeatures(applied), expected, name);
  }
});

test("replace_match carries a shared non-baseline mark and its stamp", (t) => {
  withFixture(t);
  let doc = page("A <mark>flagged</mark> idea.");
  assert.deepEqual(documentFeatures(doc), ["test-highlight"]);
  // A document stamped by an earlier writer keeps its id; replace_match re-adds
  // nothing when the id is already present.
  const id = orderedBlockIds(doc)[0];
  const heads = A.getHeads(doc);
  doc = patch(doc, [
    { op: "replace_match", block_id: id, match_text: "flagged", replacement: "noted" },
  ]);
  assert.deepEqual(documentFeatures(doc), ["test-highlight"]);
  assert.deepEqual(
    A.diff(doc, heads, A.getHeads(doc)).filter((patch) => patch.path[0] === "schema"),
    [],
  );
});

test("ids are never removed, even when the content that needed them is gone", (t) => {
  withFixture(t);
  let doc = page("A <mark>flagged</mark> idea.\n\n| a | b |\n| - | - |");
  assert.deepEqual(documentFeatures(doc), ["test-highlight", "test-tables"]);
  const id = orderedBlockIds(doc)[0];
  doc = edit(doc, [{ op: "replace_block_markdown", block_id: id, markdown: "Plain now." }]);
  doc = edit(doc, [{ op: "delete_block", block_id: id }]);
  assert.deepEqual(documentFeatures(doc), ["test-highlight", "test-tables"]);
});

test("concurrent first stamps both survive, and the next writer consolidates them", () => {
  // Both writers create `schema` on an unstamped Page. Automerge shows one
  // value and keeps the other as a conflict; the reader reads both.
  const base = page();
  const left = A.change(A.clone(base), (draft) => stampFeatures(draft, ["zeta", "alpha"]));
  const right = A.change(A.clone(base), (draft) => stampFeatures(draft, ["alpha", "mid"]));
  const merged = A.merge(left, right);
  assert.ok(A.getConflicts(merged, "schema"));
  assert.deepEqual(documentFeatures(merged), ["alpha", "mid", "zeta"]);
  assert.deepEqual(unsupportedFeatures(merged, ["alpha", "zeta"]), ["mid"]);
  // A writer adds only what is missing and copies the conflict's ids into the
  // visible list, keeping it sorted.
  const next = A.change(merged, (draft) => {
    assert.deepEqual(stampFeatures(draft, ["mid", "beta"]), ["beta"]);
  });
  assert.deepEqual(documentFeatures(next), ["alpha", "beta", "mid", "zeta"]);
  assert.deepEqual([...next.schema.features], ["alpha", "beta", "mid", "zeta"]);
});

test("concurrent features lists under one schema both survive", () => {
  const base = A.change(page(), (draft) => {
    draft.schema = {};
  });
  const left = A.change(A.clone(base), (draft) => stampFeatures(draft, ["left"]));
  const right = A.change(A.clone(base), (draft) => stampFeatures(draft, ["right"]));
  assert.deepEqual(documentFeatures(A.merge(left, right)), ["left", "right"]);
});

test("any write repairs concurrent first stamps in its own change, without a new feature", (t) => {
  withFixture(t);
  const base = page();
  const left = A.change(A.clone(base), (draft) => stampFeatures(draft, ["test-tables"]));
  const right = A.change(A.clone(base), (draft) => stampFeatures(draft, ["test-highlight"]));
  const merged = A.merge(left, right);
  assert.ok(A.getConflicts(merged, "schema"));
  assert.equal(merged.schema.features.length, 1, "the visible list is incomplete");
  // A baseline host write: a title change touches no rich text.
  const repaired = edit(A.clone(merged), [{ op: "set_title", title: "Renamed" }]);
  assert.equal(A.getChanges(merged, repaired).length, 1);
  assert.deepEqual([...repaired.schema.features], ["test-highlight", "test-tables"]);
  assert.deepEqual(documentFeatures(repaired), ["test-highlight", "test-tables"]);
  // A write with nothing to repair leaves the stamp alone.
  const heads = A.getHeads(repaired);
  const later = edit(repaired, [{ op: "set_title", title: "Again" }]);
  assert.deepEqual(
    A.diff(later, heads, A.getHeads(later)).filter((patch) => patch.path[0] === "schema"),
    [],
  );
  // The repair alone, with no ids, as the browser runs it after every change.
  const direct = A.change(merged, (draft) => assert.deepEqual(stampFeatures(draft), []));
  assert.deepEqual([...direct.schema.features], ["test-highlight", "test-tables"]);
  // Unstamped documents get no stamp from a baseline write.
  assert.equal(edit(page(), [{ op: "set_title", title: "x" }]).schema, undefined);
});

test("declared build features parse strictly", () => {
  assert.deepEqual(parseDeclaredFeatures(undefined), []);
  assert.deepEqual(parseDeclaredFeatures(null), []);
  assert.deepEqual(parseDeclaredFeatures(""), []);
  assert.deepEqual(parseDeclaredFeatures("b,a,b"), ["a", "b"]);
  for (const bad of ["A", "a,,b", "a b", ",", Array(65).fill("a").join(",")])
    assert.equal(parseDeclaredFeatures(bad), null, bad);
  assert.deepEqual(missingFeatures(["b", "a", "a"], ["b"]), ["a"]);
});

// States × events for the viewer's schema gate (schemaGateStep).
test("schema gate: every state and event", () => {
  const unstamped = page();
  const stampedDoc = stamped(["future"]);
  const moreDoc = stamped(["future", "later"]);
  const build = ["known"];
  const editable = SCHEMA_GATE_INITIAL;
  const readOnly = schemaGateStep(editable, { type: "observe", doc: stampedDoc }, build).gate;
  const refusedGate = schemaGateStep(editable, { type: "refused" }, build).gate;
  const states = {
    editable,
    "read-only (stamp)": readOnly,
    "read-only (host refused)": refusedGate,
  };
  const events = {
    "open or change with no unknown stamp": { type: "observe", doc: unstamped },
    "open with an unknown stamp": { type: "observe", doc: stampedDoc },
    "remote stamp adds another id": { type: "observe", doc: moreDoc },
    "host refuses a receipt": { type: "refused" },
    "local edit attempted": { type: "edit" },
    reload: { type: "reload" },
  };
  // [editable after, unsupported after, refused after, edit allowed]
  const expected = {
    editable: {
      "open or change with no unknown stamp": [true, [], false, true],
      "open with an unknown stamp": [false, ["future"], false, false],
      "remote stamp adds another id": [false, ["future", "later"], false, false],
      "host refuses a receipt": [false, [], true, false],
      "local edit attempted": [true, [], false, true],
      reload: [true, [], false, true],
    },
    "read-only (stamp)": {
      "open or change with no unknown stamp": [false, ["future"], false, false],
      "open with an unknown stamp": [false, ["future"], false, false],
      "remote stamp adds another id": [false, ["future", "later"], false, false],
      "host refuses a receipt": [false, ["future"], true, false],
      "local edit attempted": [false, ["future"], false, false],
      reload: [true, [], false, true],
    },
    "read-only (host refused)": {
      "open or change with no unknown stamp": [false, [], true, false],
      "open with an unknown stamp": [false, ["future"], true, false],
      "remote stamp adds another id": [false, ["future", "later"], true, false],
      "host refuses a receipt": [false, [], true, false],
      "local edit attempted": [false, [], true, false],
      reload: [true, [], false, true],
    },
  };
  for (const [stateName, state] of Object.entries(states))
    for (const [eventName, event] of Object.entries(events)) {
      const { gate, allowed } = schemaGateStep(state, event, build);
      assert.deepEqual(
        [gate.editable, [...gate.unsupported], gate.refused, allowed],
        expected[stateName][eventName],
        `${stateName} × ${eventName}`,
      );
    }
  // An unchanged gate keeps its identity, so the session emits nothing.
  assert.equal(
    schemaGateStep(readOnly, { type: "observe", doc: stampedDoc }, build).gate,
    readOnly,
  );
  assert.throws(() => schemaGateStep(editable, { type: "nope" }), /Unknown schema gate event/);
  // A build that has every stamped id stays editable.
  assert.equal(
    schemaGateStep(editable, { type: "observe", doc: moreDoc }, ["future", "later"]).gate,
    editable,
  );
});
