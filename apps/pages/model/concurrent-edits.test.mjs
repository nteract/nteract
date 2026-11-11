// Two peers apply generated targeted agent edits to clones of one stored
// tree, then merge. Targets come from each peer's own read of its document.
// Replay a failure with --test-name-pattern plus PAGES_FUZZ_SEED and
// PAGES_FUZZ_PATH.
import test from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import fc from "fast-check";
import { Leaf, Mark } from "wordgard/doc";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { projectReadContent } from "./read-content.mjs";
import { blockMarkdown, parseAgentMarkdown, textPath } from "./richtext.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { stampSpans } from "./schema-features.mjs";
import { textSegments } from "./replace-match.mjs";
import { projectComments } from "./comments.mjs";
import { comment, newCommentsDoc } from "./comments-test-support.mjs";
import { decode, encode, Paragraph, schema } from "../viewer/wordgard-model.mjs";
import { PAGE_ID, pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";
import { fuzzDepth, fuzzParameters as parameters } from "../test/fuzz-parameters.mjs";
import { plainSpans } from "../test/plain-spans.mjs";
import { freeing } from "../test/free-docs.mjs";
import { readSpans } from "./richtext-format.mjs";

// The protected paragraph shares no word with generated trees, and no edit
// targets it, so its comment must stay attached through any merge.
const PROTECTED = "Protected passage";
const ACTORS = ["0a".repeat(16), "0b".repeat(16)];

function pageWith(tree) {
  let doc = A.change(A.from(createPageData({ pageId: PAGE_ID, title: "Concurrent" })), (draft) =>
    initializePage(draft),
  );
  const id = orderedBlockIds(doc)[0];
  const spans = encode(tree);
  doc = A.change(doc, (draft) => {
    draft.blocks[id].richText = "";
    A.updateSpans(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
  });
  return { doc, id };
}
const withProtected = (description) =>
  schema.doc([
    ...toWordgardTree(description).content,
    Paragraph.create([Leaf.text(PROTECTED, Mark.none)]),
  ]);

/** The one-based occurrence replace_match counts for `text` at `offset`:
 * matches in document order across text segments, overlapping ones included. */
function occurrence(segments, text, offset) {
  let count = 0;
  for (const segment of segments)
    for (let i = segment.text.indexOf(text); i >= 0; i = segment.text.indexOf(text, i + 1)) {
      if (segment.offset + i > offset) return count;
      count++;
    }
  return count;
}
/** Every word of visible text outside the protected paragraph, with its
 * occurrence. */
function words(doc, id) {
  const segments = textSegments(doc.blocks[id]);
  const out = [];
  for (const segment of segments) {
    if (segment.text.includes(PROTECTED)) continue;
    let at = 0;
    for (const word of segment.text.split(" ")) {
      if (word)
        out.push({
          word,
          code: segment.code,
          segment,
          occurrence: occurrence(segments, word, segment.offset + at),
        });
      at += word.length + 1;
    }
  }
  return out;
}

const REPLACEMENTS = ["X", "", "two words", "über 😀"];
const FORMATS = [
  { add: { strong: true } },
  { remove: ["strong"] },
  { add: { em: true } },
  { add: { highlight: "green" } },
  { remove: ["highlight", "link"] },
];
const NODES = [
  { type: "heading", attrs: { level: 2 } },
  { type: "paragraph" },
  { type: "heading", attrs: { level: 5 } },
];
const intent = fc.record({
  kind: fc.constantFrom("replace_match", "format_match", "set_node", "delete_node"),
  pick: fc.nat(),
  variant: fc.nat(),
});
const intents = fc.array(intent, { minLength: 1, maxLength: 3 });

/** The operation an intent names in `doc`, or null when it has no target. */
function resolve(doc, id, { kind, pick, variant }) {
  if (kind === "delete_node") {
    const outline = projectReadContent(doc, {}).outline;
    // The last node is the protected paragraph.
    const ids = outline.slice(0, -1).flatMap((entry) => (entry.node_id ? [entry.node_id] : []));
    if (!ids.length) return null;
    return { operation: "edit_page", op: { op: kind, node_id: ids[pick % ids.length] } };
  }
  const targets = words(doc, id).filter((word) => kind === "replace_match" || !word.code);
  if (!targets.length) return null;
  const { word, occurrence } = targets[pick % targets.length];
  const op = { op: kind, match_text: word, occurrence };
  if (kind === "replace_match") op.replacement = REPLACEMENTS[variant % REPLACEMENTS.length];
  if (kind === "format_match") Object.assign(op, FORMATS[variant % FORMATS.length]);
  if (kind === "set_node") Object.assign(op, NODES[variant % NODES.length]);
  return { operation: "patch_page", op };
}

// Refusals an agent can get for a valid target: a retype the node holding
// the match doesn't allow, and a delete that would join its neighbours.
const refused = (error) =>
  error.code === "nodes_would_join" || /applies to .+; match_text is in /.test(error.message);
/** Apply each resolvable intent in its own change. Returns the peer's document
 * and the operations it applied. */
function edit(doc, id, list) {
  const applied = [];
  for (const entry of list) {
    const next = resolve(doc, id, entry);
    if (!next) continue;
    const op = { ...next.op, block_id: id };
    try {
      doc = A.change(doc, (draft) =>
        applyPageOperation(draft, { operation: next.operation, arguments: { operations: [op] } }),
      );
      applied.push(op);
    } catch (error) {
      if (!refused(error)) throw error;
    }
  }
  return { doc, applied };
}

const detached = (doc, comments, thread) =>
  projectComments(doc, comments).find((entry) => entry.id === thread).selectionContext.status ===
  "detached";
const deletes = (applied) =>
  applied.some((op) => op.op === "delete_node" || op.op === "replace_match");

test("concurrent targeted edits converge, read, and keep comment anchors", () => {
  fc.assert(
    fc.property(
      pageTreeArbitrary({ maxDepth: fuzzDepth }),
      intents,
      intents,
      fc.nat(),
      (description, first, second, anchorPick) =>
        freeing((keep) => {
          const { doc, id } = pageWith(withProtected(description));
          keep(doc);
          let { comments, result } = comment(doc, newCommentsDoc(), {
            action: "add",
            block_id: id,
            selected_text: PROTECTED,
            body: "Protected",
          });
          const threads = { protected: result.thread_id };
          const anchors = words(doc, id).filter((word) => !word.code);
          if (anchors.length) {
            const { word, occurrence } = anchors[anchorPick % anchors.length];
            ({ comments, result } = comment(doc, comments, {
              action: "add",
              block_id: id,
              selected_text: word,
              occurrence,
              body: "Generated",
            }));
            threads.generated = result.thread_id;
          }
          keep(comments);
          const a = edit(A.clone(doc, { actor: ACTORS[0] }), id, first);
          const b = edit(A.clone(doc, { actor: ACTORS[1] }), id, second);
          keep(a.doc);
          keep(b.doc);
          const ab = keep(A.merge(A.clone(a.doc), b.doc));
          const ba = keep(A.merge(A.clone(b.doc), a.doc));
          assert.deepEqual(A.getHeads(ab).toSorted(), A.getHeads(ba).toSorted());
          const spans = plainSpans(readSpans(ab, textPath(id)));
          assert.deepEqual(plainSpans(readSpans(ba, textPath(id))), spans);
          const label = JSON.stringify({ a: a.applied, b: b.applied, spans });
          assert.equal(decode(readSpans(ab, textPath(id))).lossy, false, label);
          assert.equal(typeof blockMarkdown(ab.blocks[id], PAGE_ID), "string");
          const outline = projectReadContent(ab, {}).outline;
          const ids = outline.flatMap((entry) => (entry.node_id ? [entry.node_id] : []));
          assert.equal(new Set(ids).size, ids.length, label);
          const kept = projectComments(ab, comments).find(
            (entry) => entry.id === threads.protected,
          ).selectionContext;
          assert.equal(kept.status, "attached", label);
          assert.equal(kept.text, PROTECTED, label);
          if (threads.generated) {
            // A merge detaches an anchor only when one peer's own edit did, and
            // a peer detaches one only by deleting text.
            for (const peer of [a, b])
              if (detached(peer.doc, comments, threads.generated))
                assert.ok(deletes(peer.applied), label);
            if (detached(ab, comments, threads.generated))
              assert.ok(
                detached(a.doc, comments, threads.generated) ||
                  detached(b.doc, comments, threads.generated),
                label,
              );
          }
        }),
    ),
    parameters,
  );
});

test("a semantically unchanged read-back write commutes with a peer's concurrent unmark", () => {
  const trees = pageTreeArbitrary({
    maxDepth: fuzzDepth,
    emptyParagraphs: false,
    separateQuotes: true,
  });
  fc.assert(
    fc.property(trees, fc.nat(), fc.nat(), (description, pick, wordPick) =>
      freeing((keep) => {
        let { doc, id } = pageWith(withProtected(description));
        // Bold one whole text segment, so strong spans runs with other marks.
        const segments = textSegments(doc.blocks[id]).filter(
          (segment) => !segment.code && !segment.text.includes(PROTECTED) && segment.text.trim(),
        );
        fc.pre(segments.length > 0);
        const segment = segments[pick % segments.length];
        doc = A.change(doc, (draft) =>
          applyPageOperation(draft, {
            operation: "patch_page",
            arguments: {
              operations: [
                {
                  op: "format_match",
                  block_id: id,
                  match_text: segment.text,
                  occurrence: occurrence(
                    textSegments(doc.blocks[id]),
                    segment.text,
                    segment.offset,
                  ),
                  add: { strong: true },
                },
              ],
            },
          }),
        );
        keep(doc);
        const markdown = projectReadContent(doc, {}).blocks[0].markdown;
        const beforeSpans = plainSpans(readSpans(doc, textPath(id)));
        const rewrite = A.change(A.clone(doc, { actor: ACTORS[0] }), (draft) =>
          applyPageOperation(draft, {
            operation: "edit_page",
            arguments: { operations: [{ op: "replace_block_markdown", block_id: id, markdown }] },
          }),
        );
        const targets = words(doc, id).filter((word) => word.segment.offset === segment.offset);
        const { word, occurrence: at } = targets[wordPick % targets.length];
        const unmark = { op: "format_match", block_id: id, match_text: word, occurrence: at };
        const peer = A.change(A.clone(doc, { actor: ACTORS[1] }), (draft) =>
          applyPageOperation(draft, {
            operation: "patch_page",
            arguments: { operations: [{ ...unmark, remove: ["strong"] }] },
          }),
        );
        keep(rewrite);
        keep(peer);
        const unchanged = isDeepStrictEqual(
          beforeSpans,
          plainSpans(readSpans(rewrite, textPath(id))),
        );
        // Markdown cannot express every native mark boundary. A projection
        // that reparses differently remains a changed-content write, not a
        // no-op. Exercise it without promising concurrent-unmark protection.
        if (unchanged) {
          assert.deepEqual(A.getHeads(rewrite), A.getHeads(doc));
          assert.deepEqual(A.save(rewrite), A.save(doc));
        } else assert.notDeepEqual(A.getHeads(rewrite), A.getHeads(doc));
        const merged = keep(A.merge(A.clone(rewrite), peer));
        const reverse = keep(A.merge(A.clone(peer), rewrite));
        assert.deepEqual(A.getHeads(merged), A.getHeads(reverse));
        assert.deepEqual(readSpans(merged, textPath(id)), readSpans(reverse, textPath(id)));
        if (unchanged)
          assert.deepEqual(
            plainSpans(readSpans(merged, textPath(id))),
            plainSpans(readSpans(peer, textPath(id))),
            JSON.stringify({ markdown, unmark }),
          );
      }),
    ),
    parameters,
  );
});

test("unchanged multi-span formatting writes no ops and preserves a peer's unmark and anchors", () => {
  freeing((keep) => {
    const { doc, id } = pageWith(parseAgentMarkdown("**ab*cd***\n\nProtected passage"));
    keep(doc);
    const { comments } = comment(doc, newCommentsDoc(), {
      action: "add",
      block_id: id,
      selected_text: "ab",
      body: "Keep this anchor",
    });
    keep(comments);
    const source = blockMarkdown(doc.blocks[id]);
    const rewrite = keep(
      A.change(A.clone(doc, { actor: ACTORS[0] }), (draft) =>
        applyPageOperation(draft, {
          operation: "edit_page",
          arguments: {
            operations: [{ op: "replace_block_markdown", block_id: id, markdown: source }],
          },
        }),
      ),
    );
    assert.deepEqual(A.getHeads(rewrite), A.getHeads(doc));
    assert.deepEqual(A.save(rewrite), A.save(doc));
    assert.deepEqual(A.getChanges(doc, rewrite), []);
    const peer = keep(
      A.change(A.clone(doc, { actor: ACTORS[1] }), (draft) =>
        applyPageOperation(draft, {
          operation: "patch_page",
          arguments: {
            operations: [
              { op: "format_match", block_id: id, match_text: "ab", remove: ["strong"] },
            ],
          },
        }),
      ),
    );
    for (const merged of [
      keep(A.merge(A.clone(rewrite), peer)),
      keep(A.merge(A.clone(peer), rewrite)),
    ]) {
      assert.deepEqual(readSpans(merged, textPath(id)), readSpans(peer, textPath(id)));
      assert.deepEqual(projectComments(merged, comments), projectComments(peer, comments));
      assert.deepEqual(projectComments(merged, comments), projectComments(doc, comments));
      assert.equal(
        A.getObjectId(merged.blocks[id], "richText"),
        A.getObjectId(doc.blocks[id], "richText"),
      );
      assert.equal(A.getCursor(merged, textPath(id), 0), A.getCursor(doc, textPath(id), 0));
    }
  });
});
