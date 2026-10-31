import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  AGENT_PRESENCE as P,
  deadline,
  readTargets,
  transition,
  writeTargets,
} from "./agent-presence.mjs";
import { createPageData, initializePage, applyPageOperation, orderedBlockIds } from "./page.mjs";
import { textPath } from "./richtext.mjs";
import { readTool } from "../worker/tool-reads.mjs";
import { resolvePeerSelection } from "./presence.mjs";

const target = [{ kind: "block", block_id: "b" }];
const read = (at) => ({ type: "read", at, targets: target });
const write = (at) => ({ type: "write", at, targets: target });
const tick = (at) => ({ type: "tick", at });

test("transition covers every state and event", () => {
  // hidden
  assert.equal(transition(null, tick(0)), null);
  assert.equal(transition(null, { type: "read", at: 0, targets: [] }), null);
  assert.equal(transition(null, { type: "write", at: 0, targets: [] }), null);
  assert.equal(transition(null, read(0)).state, "reading");
  assert.equal(transition(null, write(0)).state, "active");

  // reading
  const reading = transition(null, read(1000));
  assert.equal(transition(reading, tick(1000 + P.readingMs - 1)), reading);
  assert.equal(transition(reading, tick(1000 + P.readingMs)), null);
  assert.equal(transition(reading, write(2000)).state, "active");
  assert.equal(transition(reading, read(2000)).since, 2000);

  // active
  const active = transition(null, write(1000));
  assert.equal(transition(active, tick(1000 + P.activeMs - 1)), active);
  const idle = transition(active, tick(1000 + P.activeMs));
  assert.equal(idle.state, "idle");
  const again = transition(active, write(5000));
  assert.equal(again.state, "active");
  assert.equal(again.seq, active.seq + 1);
  assert.equal(transition(active, read(5000)).state, "reading");
  // A write with no target (delete_block) keeps the caret and resets its clock.
  const kept = transition(active, { type: "write", at: 9000, targets: [] });
  assert.deepEqual(kept.targets, active.targets);
  assert.equal(kept.lastCall, 9000);

  // idle
  assert.equal(transition(idle, tick(1000 + P.idleMs - 1)), idle);
  assert.equal(transition(idle, tick(1000 + P.idleMs)), null);
  assert.equal(transition(idle, write(50_000)).state, "active");
  assert.equal(transition(idle, read(50_000)).state, "reading");

  assert.throws(() => transition(null, { type: "mystery", at: 0 }), /Unknown/);
});

test("deadlines follow the state and a virtual clock walks the whole lifetime", () => {
  let record = transition(null, write(0));
  const seen = [record.state];
  for (let now = 0; record; now = deadline(record)) {
    record = transition(record, tick(now));
    if (record && record.state !== seen.at(-1)) seen.push(record.state);
  }
  assert.deepEqual(seen, ["active", "idle"]);
  assert.equal(deadline(null), Infinity);
  assert.equal(deadline(transition(null, read(5))), 5 + P.readingMs);
});

function fixture(markdown) {
  let doc = A.from(createPageData({ pageId: "page_fixture", title: "Presence" }));
  doc = A.change(doc, (d) => initializePage(d, markdown));
  return { doc, id: orderedBlockIds(doc)[0] };
}
function edit(doc, operations) {
  let targets;
  const after = A.change(doc, (d) => {
    const trace = [];
    applyPageOperation(d, { operation: "patch_page", arguments: { operations }, trace });
    targets = writeTargets(d, trace);
  });
  return { after, targets };
}
const resolve = (doc, t) =>
  resolvePeerSelection(doc, {
    block_id: t.block_id,
    start: t.start,
    end: t.end,
    heads: A.getHeads(doc),
  });

test("a replace_match caret covers the new text and follows a concurrent edit", () => {
  const { doc, id } = fixture("Ship on Monday to five users.");
  const { after, targets } = edit(doc, [
    { op: "replace_match", block_id: id, match_text: "Monday", replacement: "Tuesday morning" },
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kind, "text");
  let range = resolve(after, targets[0]);
  assert.equal(range.quote, "Tuesday morning");
  // Someone types before the replacement; the selection moves with its text.
  const moved = A.change(after, (d) => A.splice(d, textPath(id), 0, 0, "Plan: "));
  range = resolve(moved, targets[0]);
  assert.equal(range.quote, "Tuesday morning");
  assert.equal(range.start_utf16, "Plan: Ship on ".length);
});

test("a deletion is a caret, format_match selects its range, block ops target the block", () => {
  const { doc, id } = fixture("Keep this and drop that.");
  let { after, targets } = edit(doc, [
    { op: "replace_match", block_id: id, match_text: " and drop that", replacement: "" },
  ]);
  assert.equal(resolve(after, targets[0]).kind, "caret");
  ({ after, targets } = edit(after, [
    { op: "format_match", block_id: id, match_text: "Keep", add: { highlight: "green" } },
  ]));
  assert.equal(resolve(after, targets[0]).quote, "Keep");
  ({ after, targets } = edit(after, [{ op: "insert_markdown", markdown: "New block" }]));
  assert.equal(targets[0].kind, "block");
  assert.notEqual(targets[0].block_id, id);
  // The last operation of a batch wins; a trailing delete keeps nothing new.
  ({ targets } = edit(after, [
    { op: "format_match", block_id: id, match_text: "this", add: { strong: true } },
    { op: "delete_block", block_id: targets[0].block_id },
  ]));
  assert.equal(targets[0].kind, "text");
});

async function readBody(doc, args) {
  const result = await readTool(
    doc,
    "read_page",
    { page_id: "page_fixture", ...args },
    {
      issueAuthority: () => ({}),
    },
  );
  assert.equal(result.status, 200);
  return result.body;
}

test("targeted reads produce passages or hits; broad reads produce none", async () => {
  const { doc, id } = fixture(
    "## Rollout\n\nShip on Tuesday.\n\n## Open questions\n\nShould carets fade out?\n\nAnother fade here.",
  );
  assert.deepEqual(readTargets(doc, { page_id: "page_fixture" }, await readBody(doc, {})), []);
  const outline = { include_content: false };
  assert.deepEqual(readTargets(doc, outline, await readBody(doc, outline)), []);

  const section = { section: "Open questions" };
  const [passage] = readTargets(doc, section, await readBody(doc, section));
  assert.equal(passage.kind, "passage");
  const text = resolve(doc, passage).quote;
  assert.match(text, /^Open questions/);
  assert.match(text, /Another fade here\./);
  assert.doesNotMatch(text, /Ship on/);

  const search = { search: ["fade"] };
  const hits = readTargets(doc, search, await readBody(doc, search));
  assert.deepEqual(
    hits.map((hit) => [hit.kind, resolve(doc, hit).quote]),
    [
      ["hit", "fade"],
      ["hit", "fade"],
    ],
  );
  const many = { search: ["e"] };
  assert.deepEqual(readTargets(doc, many, await readBody(doc, many)), []);

  const blocks = { block_ids: [id] };
  const [whole] = readTargets(doc, blocks, await readBody(doc, blocks));
  assert.equal(whole.kind, "passage");
  assert.match(resolve(doc, whole).quote, /^Rollout/);
});
