// The inputs are shrinkable descriptions of editor trees, not parsed Markdown.
// Replay one property with --test-name-pattern plus PAGES_FUZZ_SEED and
// PAGES_FUZZ_PATH from fast-check's failure report. PAGES_FUZZ_RUNS scales up
// a search without changing its seed or arbitrary. PAGES_FUZZ_DEPTH changes
// nesting (default 2); keep it unchanged when replaying a failure path.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { Leaf, Mark } from "wordgard/doc";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, orderedBlockIds } from "./page.mjs";
import { projectReadContent } from "./read-content.mjs";
import { textPath, RICH_FORMAT } from "./richtext.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { stampFeatures, stampSpans } from "./schema-features.mjs";
import { projectComments } from "./comments.mjs";
import { comment, newCommentsDoc } from "./comments-test-support.mjs";
import { decode, encode, Paragraph, schema } from "../viewer/wordgard-model.mjs";
import { PAGE_ID, pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";

const parameters = {
  seed: Number(process.env.PAGES_FUZZ_SEED ?? 0x5eed),
  numRuns: Number(process.env.PAGES_FUZZ_RUNS ?? 50),
  interruptAfterTimeLimit: 120_000,
  markInterruptAsFailure: true,
  ...(process.env.PAGES_FUZZ_PATH !== undefined && { path: process.env.PAGES_FUZZ_PATH }),
};
assert.ok(Number.isSafeInteger(parameters.seed), "PAGES_FUZZ_SEED must be an integer");
assert.ok(
  Number.isSafeInteger(parameters.numRuns) && parameters.numRuns > 0,
  "PAGES_FUZZ_RUNS must be positive",
);
const maxDepth = Number(process.env.PAGES_FUZZ_DEPTH ?? 2);
const trees = pageTreeArbitrary({ maxDepth });
// Markdown cannot preserve empty paragraphs or separate adjacent quotes with
// blank lines. Native properties retain both; this profile separates quotes.
const markdownTrees = pageTreeArbitrary({ maxDepth, emptyParagraphs: false, separateQuotes: true });
// JSON data carries semantic attributes, not a JavaScript object's prototype.
const snapshot = (tree) => JSON.parse(JSON.stringify(tree.toJSON()));

test("structural counterexamples shrink to plain data and replay by seed and path", () => {
  const property = fc.property(trees, () => false);
  const failed = fc.check(property, { seed: 0x5eed, numRuns: 1 });
  assert.equal(failed.failed, true);
  assert.ok(failed.numShrinks > 0);
  assert.deepEqual(failed.counterexample, [
    { kind: "doc", children: [{ kind: "paragraph", children: [] }] },
  ]);
  const replay = fc.check(property, {
    seed: failed.seed,
    path: failed.counterexamplePath,
    numRuns: 1,
  });
  assert.deepEqual(replay.counterexample, failed.counterexample);
});

function pageWith(tree) {
  let doc = A.from(createPageData({ pageId: PAGE_ID, title: "Structure" }));
  const id = orderedBlockIds(doc)[0];
  const spans = encode(tree);
  doc = A.change(doc, (draft) => {
    draft.blocks[id].format = RICH_FORMAT;
    draft.blocks[id].richText = "";
    A.updateSpans(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
    // A new Page's comments live in their own document (initializePage).
    stampFeatures(draft, ["comments-doc"]);
  });
  return { doc, id };
}

test("independent editor trees survive the native codec without semantic loss", () => {
  fc.assert(
    fc.property(trees, (description) => {
      const expected = toWordgardTree(description);
      const decoded = decode(encode(expected));
      assert.equal(decoded.lossy, false);
      assert.deepEqual(snapshot(decoded.doc), snapshot(expected));
    }),
    parameters,
  );
});

test("native codec preserves hostile literal syntax and Unicode in editor trees", () => {
  fc.assert(
    fc.property(pageTreeArbitrary({ hostile: true, maxDepth }), (description) => {
      const expected = toWordgardTree(description);
      const decoded = decode(encode(expected));
      assert.equal(decoded.lossy, false);
      assert.deepEqual(snapshot(decoded.doc), snapshot(expected));
    }),
    parameters,
  );
});

test("independent editor trees survive Automerge storage and have distinct outline ids", () => {
  fc.assert(
    fc.property(trees, (description) => {
      const expected = toWordgardTree(description);
      const { doc, id } = pageWith(expected);
      const decoded = decode(A.spans(doc, textPath(id)));
      assert.equal(decoded.lossy, false);
      assert.deepEqual(snapshot(decoded.doc), snapshot(expected));
      const read = projectReadContent(doc, {});
      assert.equal(read.outline.length, expected.content.length);
      const ids = [];
      for (const [index, entry] of read.outline.entries()) {
        // Only the opening paragraph can omit its native marker. An empty
        // opening paragraph before another node must retain its marker.
        const node = expected.content[index];
        const implicit =
          index === 0 &&
          node.type === Paragraph.type &&
          (expected.content.length === 1 || node.content.length > 0);
        if (implicit) assert.equal(entry.node_id, null);
        else {
          assert.equal(typeof entry.node_id, "string");
          ids.push(entry.node_id);
        }
      }
      assert.equal(new Set(ids).size, ids.length);
    }),
    parameters,
  );
});

test("agent read-back replacement preserves independently generated editor trees", () => {
  fc.assert(
    fc.property(markdownTrees, (description) => {
      const expected = toWordgardTree(description);
      const { doc, id } = pageWith(expected);
      const read = projectReadContent(doc, {});
      const markdown = read.blocks[0].markdown;
      const after = A.change(A.clone(doc), (draft) =>
        applyPageOperation(draft, {
          operation: "edit_page",
          arguments: { operations: [{ op: "replace_block_markdown", block_id: id, markdown }] },
        }),
      );
      const decoded = decode(A.spans(after, textPath(id)));
      assert.equal(decoded.lossy, false);
      assert.deepEqual(snapshot(decoded.doc), snapshot(expected), markdown);
      assert.deepEqual(
        projectReadContent(after, {}).outline.map((node) => node.node_id),
        read.outline.map((node) => node.node_id),
      );
    }),
    parameters,
  );
});

test("targeted edits preserve unrelated node ids and comment anchors across generated structures", () => {
  fc.assert(
    fc.property(trees, (description) => {
      const generated = toWordgardTree(description);
      const anchor = "Protected passage";
      const target = "Editable sentinel";
      const tree = schema.doc([
        Paragraph.create([Leaf.text(target, Mark.none)]),
        ...generated.content,
        Paragraph.create([Leaf.text(anchor, Mark.none)]),
      ]);
      const { doc, id } = pageWith(tree);
      const read = projectReadContent(doc, {});
      const { comments } = comment(doc, newCommentsDoc(), {
        action: "add",
        block_id: id,
        selected_text: anchor,
        body: "Keep this passage",
      });
      const after = A.change(A.clone(doc), (draft) =>
        applyPageOperation(draft, {
          operation: "patch_page",
          arguments: {
            operations: [
              {
                op: "replace_match",
                block_id: id,
                match_text: target,
                replacement: "Changed sentinel",
              },
            ],
          },
        }),
      );
      const context = projectComments(after, comments)[0].selectionContext;
      assert.equal(context.status, "attached");
      assert.equal(context.text, anchor);
      assert.deepEqual(
        projectReadContent(after, {}).outline.map((node) => node.node_id),
        read.outline.map((node) => node.node_id),
      );
      const expected = schema.doc([
        Paragraph.create([Leaf.text("Changed sentinel", Mark.none)]),
        ...generated.content,
        Paragraph.create([Leaf.text(anchor, Mark.none)]),
      ]);
      assert.deepEqual(snapshot(decode(A.spans(after, textPath(id))).doc), snapshot(expected));
    }),
    parameters,
  );
});
