import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { INVALID_PAGE_CONTENT, admitPageChanges, requirePageContent } from "./page-admission.mjs";
import { BLOCK_MAX_LENGTH, TITLE_MAX_LENGTH } from "./page-shape.mjs";
import { RICH_FORMAT, textPath } from "./richtext.mjs";

const pageId = "44444444-4444-4444-8444-444444444444";
const assetId = "e".repeat(64);
const MARKDOWN = [
  "# Plans",
  "",
  "Some **bold** and [linked](https://example.org) text.",
  "",
  "- one",
  "- two",
  "",
  "- [ ] task",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "```mermaid",
  "graph TD; A-->B",
  "```",
].join("\n");

const page = (markdown = MARKDOWN) =>
  A.change(A.from(createPageData({ pageId, title: "Plans" })), (d) => initializePage(d, markdown));
const blockOf = (doc) => orderedBlockIds(doc)[0];
/** Native indexes of a block's markers. */
const markerIndexes = (doc, path) => {
  const out = [];
  let at = 0;
  for (const span of A.spans(doc, path)) {
    if (span.type === "block") out.push(at);
    at += span.type === "text" ? span.value.length : 1;
  }
  return out;
};

/** `fn` applied to a copy of `doc`; returns admission's answer. */
function admit(doc, fn) {
  const next = A.change(A.clone(doc), fn);
  try {
    return admitPageChanges(doc, next);
  } finally {
    A.free(next);
  }
}
const refusedFor = (rule, result) => {
  assert.equal(result.ok, false, `expected a ${rule} refusal`);
  assert.equal(result.reason.code, INVALID_PAGE_CONTENT);
  assert.equal(result.reason.rule, rule);
};
const operation = (operations) => (d) =>
  applyPageOperation(d, { operation: "edit_page", arguments: { operations } });

test("each class of invalid write is refused with invalid_page_content and its rule", () => {
  const doc = page();
  const id = blockOf(doc);
  const path = textPath(id);
  refusedFor(
    "mark",
    admit(doc, (d) => A.mark(d, path, { start: 2, end: 5, expand: "none" }, "blink", true)),
  );
  refusedFor(
    "mark",
    admit(doc, (d) =>
      A.mark(
        d,
        path,
        { start: 2, end: 5, expand: "none" },
        "link",
        JSON.stringify({ href: "javascript:alert(1)", title: null }),
      ),
    ),
  );
  refusedFor(
    "mark",
    admit(doc, (d) => A.mark(d, path, { start: 2, end: 5, expand: "none" }, "highlight", "plaid")),
  );
  refusedFor(
    "marker",
    admit(doc, (d) => A.splitBlock(d, path, 3, { type: "marquee", parents: [], attrs: {} })),
  );
  refusedFor(
    "marker",
    admit(doc, (d) =>
      A.splitBlock(d, path, 3, { type: "heading", parents: [], attrs: { level: 9 } }),
    ),
  );
  refusedFor(
    "marker",
    admit(doc, (d) =>
      A.splitBlock(d, path, 3, {
        type: "image",
        parents: ["paragraph"],
        attrs: { src: "javascript:alert(1)" },
      }),
    ),
  );
  refusedFor(
    "block_key",
    admit(doc, (d) => {
      d.blocks[id].extra = "x";
    }),
  );
  refusedFor(
    "block_entry",
    admit(doc, (d) => {
      d.blocks[id].kind = "slides";
    }),
  );
  refusedFor(
    "block_entry",
    admit(doc, (d) => {
      const other = crypto.randomUUID();
      d.blocks[other] = { id: other, kind: "markdown", richText: "" };
    }),
  );
  refusedFor(
    "block_size",
    admit(doc, (d) => A.splice(d, path, 3, 0, "x".repeat(BLOCK_MAX_LENGTH))),
  );
  refusedFor(
    "title",
    admit(doc, (d) => {
      d.title = 7;
    }),
  );
  refusedFor(
    "title",
    admit(doc, (d) => A.updateText(d, ["title"], "t".repeat(TITLE_MAX_LENGTH + 1))),
  );
  refusedFor(
    "root_key",
    admit(doc, (d) => {
      d.comments = {};
    }),
  );
  refusedFor(
    "root_key",
    admit(doc, (d) => {
      delete d.blocks;
    }),
  );
  refusedFor(
    "page_id",
    admit(doc, (d) => {
      d.page_id = "55555555-5555-4555-8555-555555555555";
    }),
  );
  refusedFor(
    "schema",
    admit(doc, (d) => {
      d.schema.features.push("Not An Id!");
    }),
  );
  refusedFor(
    "schema",
    admit(doc, (d) => {
      d.schema.features.splice(0, 1);
    }),
  );
  // A marker the patch path reads as valid on its own, placed where the
  // block's tree can't hold it.
  refusedFor(
    "structure",
    admit(doc, (d) =>
      A.splitBlock(d, path, markerIndexes(d, path).at(-1) + 2, {
        type: "image",
        parents: ["code-block"],
        attrs: { src: "/image.png" },
        isEmbed: true,
      }),
    ),
  );
});

test("typing, formatting, splits, joins and every node type a host writer stores are admitted", () => {
  const doc = page();
  const id = blockOf(doc);
  const path = textPath(id);
  const ok = (label, result) => assert.equal(result.ok, true, `${label}: ${result.reason?.rule}`);
  ok(
    "typing",
    admit(doc, (d) => A.splice(d, path, 3, 0, "typed")),
  );
  ok(
    "deleting",
    admit(doc, (d) => A.splice(d, path, 3, 2)),
  );
  for (const [name, value] of [
    ["strong", true],
    ["em", true],
    ["strike", true],
    ["code", true],
    ["highlight", "green"],
    ["link", JSON.stringify({ href: "https://example.org/x", title: null })],
  ])
    ok(
      name,
      admit(doc, (d) => A.mark(d, path, { start: 2, end: 5, expand: "none" }, name, value)),
    );
  ok(
    "unmark",
    admit(doc, (d) => A.unmark(d, path, { start: 0, end: 30, expand: "both" }, "strong")),
  );
  ok(
    "split",
    admit(doc, (d) => A.splitBlock(d, path, 4, { type: "paragraph", parents: [], attrs: {} })),
  );
  ok(
    "join",
    admit(doc, (d) => A.joinBlock(d, path, markerIndexes(d, path)[1])),
  );
  ok(
    "title",
    admit(doc, (d) => A.updateText(d, ["title"], "Renamed")),
  );
  ok(
    "host operations",
    admit(
      doc,
      operation([
        { op: "insert_markdown", markdown: MARKDOWN },
        { op: "insert_image", asset_id: assetId, alt: "A chart" },
        {
          op: "insert_node",
          node: { type: "dataframe", attrs: { asset_id: assetId, title: "Usage" } },
        },
        { op: "insert_markdown", markdown: "---" },
        { op: "replace_block_markdown", block_id: id, markdown: "Rewritten **text**" },
      ]),
    ),
  );
  const two = A.change(A.clone(doc), operation([{ op: "insert_markdown", markdown: "Second" }]));
  const second = orderedBlockIds(two)[1];
  ok("move", admit(two, operation([{ op: "move_block", block_id: second, after_block_id: null }])));
  ok("delete", admit(two, operation([{ op: "delete_block", block_id: second }])));
  A.free(two);
});

test("typing and formatting read no whole block; a marker change reads only its block", () => {
  const doc = page();
  const id = blockOf(doc);
  const path = textPath(id);
  for (const fn of [
    (d) => A.splice(d, path, 3, 0, "typed"),
    (d) => A.splice(d, path, 3, 1),
    (d) => A.mark(d, path, { start: 2, end: 5, expand: "after" }, "strong", true),
    (d) => A.updateText(d, ["title"], "Renamed"),
  ]) {
    const result = admit(doc, fn);
    assert.equal(result.ok, true);
    assert.equal(result.stats.fullReads, 0);
  }
  const split = admit(doc, (d) =>
    A.splitBlock(d, path, 4, { type: "paragraph", parents: [], attrs: {} }),
  );
  assert.equal(split.ok, true);
  assert.equal(split.stats.fullReads, 1);
});

test("content stored before admission stays, and edits around it are admitted", () => {
  // Legacy-odd content no current writer stores: an unknown mark, a marker
  // under an unknown parent, an extra block field, an extra root key and an
  // over-long title.
  let doc = page("Legacy paragraph with words");
  const id = blockOf(doc);
  const path = textPath(id);
  doc = A.change(doc, (d) => {
    A.mark(d, path, { start: 0, end: 6, expand: "both" }, "blink", true);
    A.splitBlock(d, path, 7, { type: "paragraph", parents: ["slide"], attrs: {} });
    d.blocks[id].legacy = true;
    d.legacyRoot = { kept: true };
    A.updateText(d, ["title"], "T".repeat(TITLE_MAX_LENGTH + 10));
  });
  const ok = (label, result) => assert.equal(result.ok, true, `${label}: ${result.reason?.rule}`);
  // Typing inside the unknown mark inherits it; that isn't a new mark.
  ok(
    "typing in a legacy mark",
    admit(doc, (d) => A.splice(d, path, 2, 0, "x")),
  );
  ok(
    "typing after the legacy marker",
    admit(doc, (d) => A.splice(d, path, 9, 0, "y")),
  );
  ok(
    "formatting",
    admit(doc, (d) => A.mark(d, path, { start: 10, end: 14, expand: "after" }, "em", true)),
  );
  ok(
    "a split in a block that already fails its tree check",
    admit(doc, (d) => A.splitBlock(d, path, 12, { type: "paragraph", parents: [], attrs: {} })),
  );
  ok(
    "shortening the over-long title",
    admit(doc, (d) => A.splice(d, ["title"], 0, 5)),
  );
  // The batch's own invalid writes are still refused.
  refusedFor(
    "mark",
    admit(doc, (d) => A.mark(d, path, { start: 10, end: 14, expand: "none" }, "marquee", true)),
  );
  refusedFor(
    "title",
    admit(doc, (d) => A.splice(d, ["title"], 0, 0, "longer ")),
  );
  refusedFor(
    "block_key",
    admit(doc, (d) => {
      d.blocks[id].legacy = false;
    }),
  );
});

test("a block over the size bound keeps edits that don't lengthen it", () => {
  let doc = A.from({
    page_id: pageId,
    title: "Big",
    blocks: {},
  });
  const id = crypto.randomUUID();
  doc = A.change(doc, (d) => {
    d.blocks[id] = {
      id,
      position: new A.RawString("a0"),
      kind: "markdown",
      format: RICH_FORMAT,
      markdown: "",
      richText: "",
      metadata: {},
    };
  });
  doc = A.change(doc, (d) => A.splice(d, textPath(id), 0, 0, "x".repeat(BLOCK_MAX_LENGTH + 5)));
  assert.equal(admit(doc, (d) => A.splice(d, textPath(id), 0, 10)).ok, true);
  assert.equal(admit(doc, (d) => A.splice(d, textPath(id), 0, 1, "y")).ok, true);
  refusedFor(
    "block_size",
    admit(doc, (d) => A.splice(d, textPath(id), 0, 0, "y")),
  );
});

test("requirePageContent refuses a host write with a 400 before it is journaled", () => {
  const doc = page();
  const next = A.change(A.clone(doc), (d) =>
    A.splice(d, textPath(blockOf(d)), 0, 0, "x".repeat(BLOCK_MAX_LENGTH)),
  );
  assert.throws(() => requirePageContent(doc, next), {
    status: 400,
    code: INVALID_PAGE_CONTENT,
    rule: "block_size",
  });
  A.free(next);
});
