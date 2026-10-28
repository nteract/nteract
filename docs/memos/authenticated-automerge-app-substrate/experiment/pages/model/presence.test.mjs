import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { enableRich, textPath } from "./richtext.mjs";
import {
  createProgressTargets,
  resolveProgressTargets,
  resolvePeerSelection,
  validatePeerSelection,
} from "./presence.mjs";

function fixture(markdown = "Before **🌊 passage** and after.") {
  return A.change(A.from({ blocks: {}, comments: {} }), (doc) => {
    doc.blocks.one = { id: "one", kind: "markdown", markdown };
    enableRich(doc, "one");
    doc.blocks.two = { id: "two", kind: "markdown", markdown: "Other passage" };
    enableRich(doc, "two");
  });
}
const targets = (doc, match_text = "🌊 passage", extra = {}) =>
  createProgressTargets(doc, [{ block_id: "one", match_text, ...extra }], A.getHeads(doc));
const expectedError = (status, code) => (error) => error.status === status && error.code === code;
function selection(doc, text, { backward = false, caret = false, id = "one" } = {}) {
  const start = doc.blocks[id].richText.indexOf(text),
    end = caret ? start : start + text.length,
    path = textPath(id);
  assert.ok(start >= 0);
  return {
    block_id: id,
    start: A.getCursor(doc, path, start, "after"),
    end: A.getCursor(doc, path, end, caret ? "after" : "before"),
    backward,
    heads: A.getHeads(doc),
  };
}

test("progress captures visible text across marks without changing document state or heads", () => {
  const doc = fixture("Before **🌊** *passage* and after."),
    heads = A.getHeads(doc),
    changes = A.getAllChanges(doc),
    content = JSON.stringify(doc),
    anchors = targets(doc),
    result = resolveProgressTargets(doc, anchors);
  assert.deepEqual(result, [
    {
      block_id: "one",
      status: "attached",
      start_utf16: doc.blocks.one.richText.indexOf("🌊"),
      end_utf16: doc.blocks.one.richText.indexOf("🌊") + "🌊 passage".length,
      quote: "🌊 passage",
    },
  ]);
  assert.equal(anchors[0].target.anchor.textObjectId, A.getObjectId(doc.blocks.one, "richText"));
  assert.deepEqual(A.getHeads(doc), heads);
  assert.deepEqual(A.getAllChanges(doc), changes);
  assert.equal(JSON.stringify(doc), content);
});

test("targets require current exact heads and bounded distinct passages", () => {
  const doc = fixture();
  assert.deepEqual(createProgressTargets(doc, undefined), []);
  assert.deepEqual(createProgressTargets(doc, []), []);
  for (const expected of [undefined, [], ["bad"], [...A.getHeads(doc), ...A.getHeads(doc)]])
    assert.throws(
      () => createProgressTargets(doc, [{ block_id: "one", match_text: "Before" }], expected),
      expectedError(400, "invalid_presence_target"),
    );
  assert.throws(
    () => createProgressTargets(doc, [{ block_id: "one", match_text: "Before" }], ["f".repeat(64)]),
    expectedError(409, "presence_revision_changed"),
  );
  for (const input of [
    null,
    {},
    new Array(4).fill({ block_id: "one", match_text: "Before" }),
    [{ block_id: "one", match_text: "" }],
    [{ block_id: "one", match_text: "x".repeat(1025) }],
    [{ block_id: "one", match_text: "Before", context_before: "x".repeat(257) }],
    [{ block_id: "one", match_text: "Before", principal: "forged" }],
    [{ block_id: "one", match_text: "\ud83c" }],
    [
      { block_id: "one", match_text: "Before" },
      { block_id: "one", match_text: "Before", context_after: "passage" },
    ],
  ])
    assert.throws(
      () => createProgressTargets(doc, input, A.getHeads(doc)),
      expectedError(400, "invalid_presence_target"),
    );
  assert.throws(
    () => targets(doc, "Before", { block_id: "__proto__" }),
    expectedError(404, "presence_target_not_found"),
  );
});

test("context disambiguates repeated passages and cannot cross rich structural boundaries", () => {
  const doc = fixture("First apple, middle apple, last apple.\n\nOther paragraph.");
  assert.throws(() => targets(doc, "apple"), /found 3 matches/);
  const chosen = targets(doc, "apple", { context_before: "middle", context_after: ", last" });
  assert.equal(
    resolveProgressTargets(doc, chosen)[0].start_utf16,
    doc.blocks.one.richText.indexOf("apple", doc.blocks.one.richText.indexOf("apple") + 1),
  );
  assert.throws(() => targets(doc, "Other", { context_before: "last apple" }), /found 0 matches/);
  assert.throws(() => targets(doc, doc.blocks.one.richText), /found 0 matches/);
  const image = fixture("Before ![image](https://example.com/image.png) after.");
  assert.throws(() => targets(image, "after", { context_before: "Before" }), /found 0 matches/);
});

test("progress follows surviving UTF-16 anchors through surrounding and internal edits", () => {
  let doc = fixture();
  const anchor = targets(doc),
    original = resolveProgressTargets(doc, anchor)[0];
  doc = A.change(doc, (draft) => {
    A.splice(draft, textPath("one"), original.start_utf16, 0, "🌳 ");
    const at = draft.blocks.one.richText.indexOf("passage");
    A.splice(draft, textPath("one"), at, 0, "shared ");
  });
  const current = resolveProgressTargets(doc, anchor)[0];
  assert.equal(current.status, "attached");
  assert.equal(current.start_utf16, original.start_utf16 + 3);
  assert.equal(current.quote, "🌊 shared passage");
});

test("deleted final characters, replaced text objects, and deleted blocks detach without rematching", () => {
  for (const change of [
    (draft, range) => A.splice(draft, textPath("one"), range.end_utf16 - 1, 1, ""),
    (draft, range) =>
      A.splice(draft, textPath("one"), range.start_utf16, range.end_utf16 - range.start_utf16, ""),
    (draft) => {
      draft.blocks.one.richText = "🌊 passage repeated replacement";
    },
    (draft) => {
      delete draft.blocks.one;
    },
  ]) {
    const doc = fixture("🌊 passage and a second 🌊 passage"),
      anchor = targets(doc, "🌊 passage", { context_after: "and a second" }),
      range = resolveProgressTargets(doc, anchor)[0],
      after = A.change(doc, (draft) => change(draft, range));
    assert.deepEqual(resolveProgressTargets(after, anchor), [
      { block_id: "one", status: "detached" },
    ]);
  }
});

test("bounded public progress quotes preserve Unicode and private anchors keep original target", () => {
  const text = `${"a".repeat(255)}🌊${"b".repeat(20)}`,
    doc = fixture(text),
    anchor = targets(doc, text),
    result = resolveProgressTargets(doc, anchor)[0];
  assert.equal(anchor[0].quote, text);
  assert.equal(result.quote, "a".repeat(255));
  assert.equal(result.end_utf16 - result.start_utf16, text.length);
});

test("peer payload validation sanitizes labels and bounds all native coordinates", () => {
  const doc = fixture(),
    valid = selection(doc, "🌊 passage");
  assert.deepEqual(
    validatePeerSelection({ ...valid, principal: "forged", driver: "Pretend" }),
    valid,
  );
  for (const invalid of [
    null,
    [],
    { ...valid, block_id: "" },
    { ...valid, start: "x".repeat(513) },
    { ...valid, backward: "yes" },
    { ...valid, heads: [] },
    { ...valid, heads: ["bad"] },
    { ...valid, heads: [valid.heads[0], valid.heads[0]] },
  ]) {
    assert.equal(validatePeerSelection(invalid), null);
    assert.equal(resolvePeerSelection(doc, invalid), null);
  }
});

test("peer selections report UTF-16 coordinates, direction and collapsed caret separately", () => {
  const doc = fixture(),
    start = doc.blocks.one.richText.indexOf("🌊"),
    selectionResult = resolvePeerSelection(doc, selection(doc, "🌊 passage", { backward: true }));
  assert.deepEqual(selectionResult, {
    block_id: "one",
    status: "attached",
    kind: "selection",
    start_utf16: start,
    end_utf16: start + "🌊 passage".length,
    caret_utf16: start,
    backward: true,
    quote: "🌊 passage",
  });
  assert.deepEqual(resolvePeerSelection(doc, selection(doc, "🌊 passage", { caret: true })), {
    block_id: "one",
    status: "attached",
    kind: "caret",
    start_utf16: start,
    end_utf16: start,
    caret_utf16: start,
    backward: false,
  });
});

test("unknown peer heads remain pending until their document changes arrive", () => {
  const original = fixture(),
    remote = A.change(A.clone(original), (draft) => {
      A.splice(draft, textPath("one"), draft.blocks.one.richText.length, 0, " New text 🌳");
    }),
    value = selection(remote, "New text 🌳");
  assert.deepEqual(resolvePeerSelection(original, value), { block_id: "one", status: "pending" });
  assert.equal(resolvePeerSelection(A.merge(original, remote), value).quote, "New text 🌳");
});

test("peer selections use their causal text object and do not relocate after replacement", () => {
  const original = fixture(),
    value = selection(original, "🌊 passage"),
    after = A.change(original, (draft) => {
      draft.blocks.one.richText = "Fresh 🌊 passage";
    });
  assert.deepEqual(resolvePeerSelection(after, value), { block_id: "one", status: "detached" });
});

test("peer selection survives surrounding edits but detaches when the selected passage disappears", () => {
  let doc = fixture();
  const value = selection(doc, "🌊 passage"),
    start = doc.blocks.one.richText.indexOf("🌊");
  doc = A.change(doc, (draft) => A.splice(draft, textPath("one"), start, 0, "🌳 "));
  assert.equal(resolvePeerSelection(doc, value).start_utf16, start + 3);
  doc = A.change(doc, (draft) =>
    A.splice(draft, textPath("one"), start + 3, "🌊 passage".length, ""),
  );
  assert.deepEqual(resolvePeerSelection(doc, value), { block_id: "one", status: "detached" });
});

test("malformed and wrong-object cursors detach without throwing or mutating heads", () => {
  const doc = fixture(),
    value = selection(doc, "🌊 passage"),
    heads = A.getHeads(doc),
    other = selection(doc, "Other", { id: "two" });
  for (const bad of [
    { ...value, start: "broken" },
    { ...value, start: other.start, end: other.end },
    { ...value, block_id: "__proto__" },
    { ...value, start: value.end, end: value.start },
  ])
    assert.equal(resolvePeerSelection(doc, bad).status, "detached");
  assert.deepEqual(A.getHeads(doc), heads);
});

test("end-of-text caret and peer quote budgets preserve valid Unicode", () => {
  const text = `${"a".repeat(255)}🌊 tail`,
    doc = fixture(text),
    result = resolvePeerSelection(doc, selection(doc, text)),
    value = selection(doc, text, { caret: true });
  assert.equal(result.quote, "a".repeat(255));
  value.start = value.end = A.getCursor(
    doc,
    textPath("one"),
    doc.blocks.one.richText.length,
    "after",
  );
  assert.equal(resolvePeerSelection(doc, value).kind, "caret");
});

test("a collapsed peer caret stays collapsed when old publishers use different endpoint affinities", () => {
  const doc = fixture(),
    value = selection(doc, "🌊 passage", { caret: true }),
    offset = doc.blocks.one.richText.indexOf("🌊");
  value.end = A.getCursor(doc, textPath("one"), offset, "before");
  const after = A.change(doc, (draft) => A.splice(draft, textPath("one"), offset, 0, "typing ")),
    result = resolvePeerSelection(after, value);
  assert.equal(result.status, "attached");
  assert.equal(result.kind, "caret");
  assert.equal(result.start_utf16, result.end_utf16);
  assert.equal(result.caret_utf16, offset + "typing ".length);
});

test("the final selected emoji uses its complete code point and detaches on removal", () => {
  const doc = fixture("Before passage 🌊 after"),
    anchor = targets(doc, "passage 🌊"),
    value = selection(doc, "passage 🌊"),
    range = resolveProgressTargets(doc, anchor)[0];
  assert.equal(range.quote, "passage 🌊");
  assert.equal(resolvePeerSelection(doc, value).quote, "passage 🌊");
  const after = A.change(doc, (draft) =>
    A.splice(draft, textPath("one"), range.end_utf16 - 2, 2, ""),
  );
  assert.equal(resolveProgressTargets(after, anchor)[0].status, "detached");
  assert.equal(resolvePeerSelection(after, value).status, "detached");
});
