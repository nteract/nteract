// Every edit_page refusal reason, from a batch whose later operation fails:
// the reason, the operation it names, and a document left as it was.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage } from "./page.mjs";
import { blockAddress, nodeAddresses } from "./addresses.mjs";
import { guardPassageEdits } from "./passage-edits.mjs";
import { EDIT_REFUSAL_REASONS, refusalReason } from "./edit-refusals.mjs";
import { MAX_ADDRESS } from "./address-shape.mjs";
import { MAX_NODE_ID } from "./node-ids.mjs";
import { MAX_BATCH_IN_PLACE_UNITS } from "./insert-in-place.mjs";

const PAGE = "44444444-4444-4444-8444-444444444444";
const KEY = "main";
const page = (markdown) =>
  A.change(A.from(createPageData({ pageId: PAGE, title: "Plan" })), (draft) =>
    initializePage(draft, markdown, KEY),
  );
const SOURCE = [
  "Alpha beta beta.",
  "Café au lait.",
  "```\ncode text\n```",
  "- one\n- two",
  "Tail text.",
].join("\n\n");

/** The refusal `operations` raise on a copy of `doc`, checking that the
 * document is unchanged. */
function refusal(doc, operations) {
  const before = A.save(doc);
  let caught;
  try {
    A.change(A.clone(doc), (draft) =>
      applyPageOperation(draft, { operation: "edit_page", arguments: { operations } }),
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `refused: ${JSON.stringify(operations)}`);
  assert.deepEqual(A.save(doc), before, "nothing was written");
  return caught;
}
const lead = { op: "set_title", title: "Changed" };

test("each reason names the operation that refused, at its index in the batch", () => {
  const doc = page(SOURCE);
  const block = blockAddress(doc, KEY);
  const [alpha, , code] = nodeAddresses(doc, KEY);
  const replace = (fields) => ({
    op: "replace_match",
    node_id: block,
    replacement: "x",
    ...fields,
  });
  const cases = [
    ["match_zero", [lead, replace({ match_text: "zzz" })], "match_text"],
    ["match_many", [lead, replace({ match_text: "beta" })], "match_text"],
    ["match_boundary", [lead, replace({ match_text: "Cafe" })], "match_text"],
    ["field_unexpected", [lead, replace({ match_text: "Alpha", bogus: 1 })], "bogus"],
    ["field_invalid", [lead, { op: "insert_markdown" }], "markdown"],
    ["set_node_needs_match", [lead, { op: "set_node", node_id: alpha }], "match_text"],
    [
      "node_type_mismatch",
      [lead, { op: "set_node", node_id: block, match_text: "Alpha", attrs: { checked: true } }],
      "attrs",
    ],
    ["address_malformed", [lead, { op: "delete_block", node_id: "no-such-block" }], "node_id"],
    [
      "inline_markdown",
      [
        lead,
        replace({ match_text: "Alpha", replacement: undefined, replacement_markdown: "a\nb" }),
      ],
      "replacement_markdown",
    ],
    [
      "code_block",
      [lead, { op: "format_match", node_id: code, match_text: "code", add: { strong: true } }],
      "match_text",
    ],
    [
      "batch_overlap",
      [
        lead,
        replace({ match_text: "beta beta", replacement: "gamma" }),
        replace({ match_text: "beta", occurrence: 2 }),
      ],
      "occurrence",
    ],
    ["op_unknown", [lead, { op: "frobnicate", node_id: block }], undefined],
  ];
  for (const [reason, operations, field] of cases) {
    const error = refusal(doc, operations);
    const index = operations.length - 1;
    // No code of its own: edit_page answers it as invalid_edit_selector.
    assert.equal(error.code, reason === "inline_markdown" ? "invalid_edit_selector" : undefined);
    assert.equal(refusalReason(error), reason, `${reason}: ${error.message}`);
    assert.deepEqual(
      error.editAt,
      { index, op: operations[index].op, field, node_id: operations[index].node_id },
      reason,
    );
  }
});

test("budget reasons name the operation that passes the bound", () => {
  // A block whose length fits three in-place inserts into the batch's budget
  // and not four.
  const big = page(`${"word ".repeat(Math.floor(MAX_BATCH_IN_PLACE_UNITS / 18))}\n\nEnd`);
  const [anchor] = nodeAddresses(big, KEY);
  const insert = { op: "insert_markdown", markdown: "New", after_node_id: anchor };
  const inPlace = refusal(big, [insert, insert, insert, insert]);
  assert.equal(refusalReason(inPlace), "in_place_budget");
  assert.deepEqual(inPlace.editAt, {
    index: 3,
    op: "insert_markdown",
    field: "after_node_id",
    node_id: undefined,
  });

  const marks = page("x ".repeat(800));
  const block = blockAddress(marks, KEY);
  const format = (add) => ({ op: "format_match", node_id: block, match_text: "x", all: true, add });
  const budget = refusal(marks, [format({ strong: true, em: true }), format({ strike: true })]);
  assert.equal(refusalReason(budget), "mark_budget");
  assert.deepEqual(budget.editAt, {
    index: 1,
    op: "format_match",
    field: undefined,
    node_id: block,
  });
});

test("a batch-level refusal names no operation", () => {
  const doc = page(SOURCE);
  const error = refusal(doc, [lead, null]);
  assert.equal(refusalReason(error), "batch_invalid");
  assert.equal(error.editAt, undefined);
});

test("coded refusals from inside a batch name their operation too", () => {
  const doc = page(SOURCE);
  const [alpha, , , list] = nodeAddresses(doc, KEY);
  const missing = refusal(doc, [lead, { op: "delete_block", node_id: "999999@abcdef" }]);
  assert.equal(missing.code, "node_not_found");
  assert.deepEqual(missing.editAt, {
    index: 1,
    op: "delete_block",
    field: "node_id",
    node_id: "999999@abcdef",
  });
  const wrongKind = refusal(doc, [lead, { op: "delete_block", node_id: alpha }]);
  assert.equal(wrongKind.code, "wrong_address_kind");
  assert.deepEqual(wrongKind.editAt, {
    index: 1,
    op: "delete_block",
    field: "node_id",
    node_id: alpha,
  });
  const join = refusal(doc, [
    lead,
    { op: "insert_markdown", markdown: "- three", after_node_id: list },
  ]);
  assert.equal(join.code, "nodes_would_join");
  assert.deepEqual(join.editAt, {
    index: 1,
    op: "insert_markdown",
    field: "after_node_id",
    node_id: undefined,
  });
});

test("target-scoped refusals carry their reason and operation", () => {
  const doc = page(SOURCE);
  const block = blockAddress(doc, KEY);
  const heads = A.getHeads(doc);
  const replace = (fields) => ({
    op: "replace_match",
    node_id: block,
    replacement: "x",
    ...fields,
  });
  const scoped = (baseHeads, operations) => {
    try {
      guardPassageEdits(doc, baseHeads, operations);
    } catch (error) {
      return error;
    }
    assert.fail("refused");
  };
  const revision = scoped([], [replace({ match_text: "Alpha" })]);
  assert.equal(revision.code, "invalid_edit_selector");
  assert.equal(refusalReason(revision), "revision_required");
  const ops = scoped(heads, [replace({ match_text: "Alpha" }), { op: "insert_markdown" }]);
  assert.equal(refusalReason(ops), "target_scope_ops");
  assert.equal(ops.editAt, undefined);
  for (const [reason, failing] of [
    ["match_zero", replace({ match_text: "zzz" })],
    ["match_many", replace({ match_text: "beta" })],
  ]) {
    const error = scoped(heads, [replace({ match_text: "Alpha" }), failing]);
    assert.equal(error.code, "invalid_edit_selector");
    assert.equal(refusalReason(error), reason);
    assert.deepEqual(error.editAt, {
      index: 1,
      op: "replace_match",
      field: "match_text",
      node_id: block,
    });
  }
});

test("the address shape's limit is the node id limit", () => {
  assert.equal(MAX_ADDRESS, MAX_NODE_ID);
});

test("a refusal without a listed reason reads as other", () => {
  assert.equal(refusalReason(Error("anything")), "other");
  assert.equal(refusalReason({ editReason: "free text" }), "other");
  assert.equal(refusalReason(undefined), "other");
  assert.ok(EDIT_REFUSAL_REASONS.includes("other"));
});

// Every module that can name a reason: one that imports edit-refusals.mjs or
// sets editReason itself. Found by reading model/ and worker/, so a new module
// is scanned without being added to a list here.
const SOURCES = ["./", "../worker/"].flatMap((dir) =>
  readdirSync(new URL(dir, import.meta.url))
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .map((name) => dir + name)
    .filter((path) => path !== "./edit-refusals.mjs")
    .filter((path) =>
      /edit-refusals\.mjs"|editReason:/.test(readFileSync(new URL(path, import.meta.url), "utf8")),
    ),
);
test("every reason a throw site names is listed", () => {
  const named = new Set();
  for (const path of SOURCES) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    // refused(<reason expression>, ...) and invalid(<reason>, ...): the
    // string literals in the first argument.
    for (const call of source.matchAll(/\b(?:refused|invalid)\(\s*([^,]*?),/g)) {
      const literals = [...call[1].matchAll(/"([^"]*)"/g)].map((match) => match[1]);
      if (call[1].trim() === "reason") continue;
      assert.ok(literals.length, `${path}: ${call[0]}`);
      for (const reason of literals) named.add(reason);
    }
    for (const match of source.matchAll(/editReason: "([^"]*)"/g)) named.add(match[1]);
  }
  for (const reason of named) assert.ok(EDIT_REFUSAL_REASONS.includes(reason), reason);
  // Every listed reason but other has a throw site.
  assert.deepEqual(
    EDIT_REFUSAL_REASONS.filter((reason) => reason !== "other" && !named.has(reason)),
    [],
  );
});
