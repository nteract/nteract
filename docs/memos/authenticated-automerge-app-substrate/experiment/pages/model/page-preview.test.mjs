import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { PREVIEW_MAX_BYTES, pagePreview } from "./page-preview.mjs";

const asset = `/api/pages/5f0c4a5e-6c1e-4b0e-9a8f-0d0d4c5e6f70/assets/${"a".repeat(64)}`;
const page = (markdown) =>
  A.change(A.from(createPageData({ pageId: "p", title: "Roadmap" })), (draft) =>
    initializePage(draft, markdown),
  );

test("the preview renders blocks with the schema's own tags and attributes", (t) => {
  const doc = page(
    [
      "# Plan",
      "Some **bold**, *em*, `code`, ~~gone~~ and [a link](https://example.com).",
      "- [x] done",
      "| a | b |\n|:--|--:|\n| 1 | 2 |",
      `![Figure](${asset})`,
    ].join("\n\n"),
  );
  t.after(() => A.free(doc));
  const preview = pagePreview(doc);
  assert.equal(preview.title, "Roadmap");
  assert.equal(preview.truncated, false);
  assert.equal(preview.blocks.length, 1);
  assert.equal(preview.blocks[0].id, orderedBlockIds(doc)[0]);
  const [heading, paragraph, tasks, table, figure] = preview.blocks[0].content;
  assert.deepEqual(heading, ["h1", {}, "Plan"]);
  assert.deepEqual(paragraph, [
    "p",
    {},
    "Some ",
    ["strong", {}, "bold"],
    ", ",
    ["em", {}, "em"],
    ", ",
    ["code", {}, "code"],
    ", ",
    ["s", {}, "gone"],
    " and ",
    ["a", { href: "https://example.com", title: "" }, "a link"],
    ".",
  ]);
  assert.deepEqual(tasks[0], "ul");
  assert.equal(tasks[1]["data-task-list"], "true");
  assert.equal(tasks[2][1]["data-task-checked"], "true");
  assert.deepEqual(table[0], "table");
  assert.deepEqual(table[2][2][2][1], { "data-align": "left" });
  assert.deepEqual(figure, ["p", {}, ["img", { src: asset, alt: "Figure" }]]);
});

test("the preview drops unsafe link targets the way the editor does", () => {
  const doc = page("[x](https://ok.example)");
  const id = orderedBlockIds(doc)[0];
  const next = A.change(doc, (draft) =>
    A.mark(
      draft,
      ["blocks", id, "richText"],
      { start: 0, end: 1, expand: "none" },
      "link",
      JSON.stringify({ href: "javascript:alert(1)", title: null }),
    ),
  );
  assert.deepEqual(pagePreview(next).blocks[0].content, [["p", {}, ["span", {}, "x"]]]);
});

/** A Page titled `title` with one block per entry of `blocks`. */
function pageOf(title, blocks) {
  let doc = A.change(A.from(createPageData({ pageId: "p", title })), (draft) =>
    initializePage(draft, blocks[0]),
  );
  for (const markdown of blocks.slice(1))
    doc = A.change(doc, (draft) =>
      applyPageOperation(draft, {
        operation: "edit_page",
        arguments: { operations: [{ op: "insert_markdown", markdown }] },
        identity: { principal: "owner", displayName: "Owner", driver: "Browser" },
      }),
    );
  return doc;
}
const bodyBytes = (preview) => Buffer.byteLength(JSON.stringify(preview), "utf8");

test("the preview stops at its size bound, in block order, and says so", () => {
  const doc = pageOf(
    "Roadmap",
    Array.from({ length: 21 }, (_, i) => `block ${i} `.repeat(40)),
  );
  const whole = pagePreview(doc);
  assert.equal(whole.blocks.length, 21);
  assert.equal(whole.truncated, false);
  const bounded = pagePreview(doc, { maxBytes: 2000 });
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.blocks.length > 0 && bounded.blocks.length < 21);
  assert.deepEqual(
    bounded.blocks.map((block) => block.id),
    orderedBlockIds(doc).slice(0, bounded.blocks.length),
  );
  assert.ok(bodyBytes(bounded) <= 2000);
});

test("the budget counts UTF-8 bytes of the whole body, so CJK and emoji stop at the boundary", () => {
  // Three bytes per CJK character and four per emoji, but one or two UTF-16
  // units: a length count would let this Page through at twice the budget.
  const doc = pageOf(
    "路线图 🗺️",
    Array.from({ length: 12 }, (_, i) => `第${i}段 ${"漢字かな😀".repeat(30)}`),
  );
  const whole = pagePreview(doc, { maxBytes: 1 << 20 });
  assert.equal(whole.blocks.length, 12);
  const exact = bodyBytes(whole);
  assert.ok(JSON.stringify(whole).length < exact * 0.6, "the fixture is mostly multi-byte");
  // Exactly the whole body's bytes: everything fits.
  const fits = pagePreview(doc, { maxBytes: exact });
  assert.equal(fits.blocks.length, 12);
  assert.equal(fits.truncated, false);
  assert.equal(bodyBytes(fits), exact);
  // One byte less: the last block goes, and the body says so.
  const short = pagePreview(doc, { maxBytes: exact - 1 });
  assert.equal(short.blocks.length, 11);
  assert.equal(short.truncated, true);
  assert.ok(bodyBytes(short) <= exact - 1);
  // Every boundary across the middle of the Page holds.
  for (let maxBytes = 200; maxBytes < exact; maxBytes += 97) {
    const preview = pagePreview(doc, { maxBytes });
    assert.ok(bodyBytes(preview) <= maxBytes, `${bodyBytes(preview)} > ${maxBytes}`);
    assert.equal(preview.truncated, preview.blocks.length < 12);
    assert.equal(preview.title, "路线图 🗺️");
  }
});

test("a title longer than the budget is cut at a code point and leaves no room for blocks", () => {
  // A Page title holds at most 1024 UTF-16 units, about 1.7 KB of this text.
  const doc = pageOf(
    "Ünïcødé 🧭 ".repeat(200),
    Array.from({ length: 30 }, (_, i) => `small ${i}`),
  );
  const title = String(doc.title);
  assert.ok(Buffer.byteLength(title) > 1024);
  for (const maxBytes of [64, 512, 1024]) {
    const preview = pagePreview(doc, { maxBytes });
    assert.ok(bodyBytes(preview) <= maxBytes, `${bodyBytes(preview)} > ${maxBytes}`);
    assert.equal(preview.truncated, true);
    assert.deepEqual(preview.blocks, []);
    assert.ok(title.startsWith(preview.title));
    assert.equal(preview.title.includes("\uFFFD"), false);
    // No lone surrogate: the cut never splits an emoji.
    assert.equal(Buffer.from(preview.title, "utf8").toString("utf8"), preview.title);
    // The title takes all it can: one more code point wouldn't fit.
    const next = Array.from(title)
      .slice(0, Array.from(preview.title).length + 1)
      .join("");
    assert.ok(bodyBytes({ title: next, blocks: [], truncated: true }) > maxBytes);
  }
  // A long title that fits still leaves the rest of the budget to blocks.
  const room = pagePreview(
    pageOf(
      "😀".repeat(512),
      Array.from({ length: 300 }, (_, i) => `b${i}`),
    ),
    { maxBytes: 8192 },
  );
  assert.equal(room.title, "😀".repeat(512));
  assert.ok(room.blocks.length > 0 && room.blocks.length < 300);
  assert.equal(room.truncated, true);
  assert.ok(bodyBytes(room) <= 8192);
});

test("the default budget is 256 KiB and a budget below the empty body is refused", () => {
  assert.equal(PREVIEW_MAX_BYTES, 256 * 1024);
  const doc = pageOf("x", ["y"]);
  assert.throws(() => pagePreview(doc, { maxBytes: 10 }), RangeError);
  // The empty body with `false` is one byte longer than with `true`, which
  // leaves room for a one-byte title and no block.
  const maxBytes = bodyBytes({ title: "", blocks: [], truncated: false });
  const empty = pagePreview(doc, { maxBytes });
  assert.deepEqual(empty, { title: "x", blocks: [], truncated: true });
  assert.equal(bodyBytes(empty), maxBytes);
});
