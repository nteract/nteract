import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { blockAddress } from "./addresses.mjs";
import {
  CARD_BLOCKS_MAX_BYTES,
  CARD_BUILDER_VERSION,
  cardHash,
  CARD_MAX_NODES,
  cardContent,
  cardKey,
  showsContent,
  clipNode,
  codeLanguage,
  pageCard,
  readStoredCard,
  sizeWithin,
} from "./page-card.mjs";
import { pagePreview } from "./page-preview.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const asset = `/api/pages/${pageId}/assets/${"a".repeat(64)}`;
const owner = { principal: "owner", displayName: "Owner", driver: "Browser" };

const page = (markdown, title = "Roadmap") =>
  A.change(A.from(createPageData({ pageId, title })), (draft) => initializePage(draft, markdown));
const edit = (doc, operations) =>
  A.change(doc, (draft) =>
    applyPageOperation(draft, {
      operation: "edit_page",
      arguments: { operations },
      identity: owner,
    }),
  );
const blocksBytes = (card) => Buffer.byteLength(JSON.stringify(card.blocks), "utf8");
const paragraphs = (count, word = "text") =>
  Array.from({ length: count }, (_, i) => `Paragraph ${i} ${`${word} `.repeat(30)}`).join("\n\n");

test("a card holds the bundle fields in order, with the schema's own tags", async (t) => {
  const doc = page(
    [
      "# Plan",
      "Some **bold** and [a link](https://example.com).",
      "- one\n- two",
      "- [x] done\n- [ ] open",
      "| a | b |\n|:--|--:|\n| 1 | 2 |",
      "```python\nprint('hi')\n```",
    ].join("\n\n"),
  );
  t.after(() => A.free(doc));
  const card = await pageCard(doc, { contentUpdatedAt: "2026-11-04T10:00:00.000Z" });
  assert.deepEqual(Object.keys(card), [
    "v",
    "card_hash",
    "content_updated_at",
    "title",
    "blocks",
    "truncated",
    "rich",
  ]);
  assert.equal(card.v, 1);
  assert.match(card.card_hash, /^[0-9a-f]{64}$/);
  assert.equal(card.content_updated_at, "2026-11-04T10:00:00.000Z");
  assert.equal(card.title, "Roadmap");
  assert.equal(card.truncated, false);
  assert.equal(card.rich, false);
  assert.equal(card.blocks[0].id, orderedBlockIds(doc)[0]);
  const [heading, paragraph, bullets, tasks, table, code] = card.blocks[0].content;
  assert.deepEqual(heading, ["h1", {}, "Plan"]);
  // The link keeps its text and loses its href: the card is one link.
  assert.deepEqual(paragraph, [
    "p",
    {},
    "Some ",
    ["strong", {}, "bold"],
    " and ",
    ["a", {}, "a link"],
    ".",
  ]);
  assert.equal(bullets[0], "ul");
  assert.deepEqual(tasks[2], [
    "li",
    { "data-task-checked": "true" },
    ["input", { checked: "" }],
    ["div", {}, ["p", {}, "done"]],
  ]);
  assert.deepEqual(tasks[3][2], ["input", {}]);
  assert.equal(table[0], "table");
  assert.deepEqual(code, ["pre", { "data-language": "python" }, ["code", {}, "print('hi')"]]);
  assert.equal(JSON.stringify(card).includes("example.com"), false);
});

test("images become placeholders: no bytes, no src, only alt text", async (t) => {
  const doc = page(`Intro\n\n![A chart of usage](${asset})\n\n![](${asset})`);
  t.after(() => A.free(doc));
  const card = await pageCard(doc);
  const [, figure, bare] = card.blocks[0].content;
  assert.deepEqual(figure, [
    "p",
    {},
    ["span", { "data-card-placeholder": "image" }, "A chart of usage"],
  ]);
  assert.deepEqual(bare, ["p", {}, ["span", { "data-card-placeholder": "image" }]]);
  const text = JSON.stringify(card);
  assert.equal(text.includes("/api/pages"), false);
  assert.equal(text.includes('"img"'), false);
  assert.equal(card.rich, true);
});

test("Mermaid stays code, and a dataframe becomes a titled placeholder", async (t) => {
  const mermaid = page("```mermaid\nflowchart LR\n  A --> B\n```");
  t.after(() => A.free(mermaid));
  const diagram = await pageCard(mermaid);
  assert.deepEqual(diagram.blocks[0].content[0], [
    "pre",
    { "data-language": "mermaid" },
    ["code", {}, "flowchart LR\n  A --> B"],
  ]);
  assert.equal(diagram.rich, true);

  const frame = edit(page("Intro"), [
    {
      op: "insert_node",
      node: { type: "dataframe", attrs: { asset_id: "d".repeat(64), title: "Usage by day" } },
    },
  ]);
  t.after(() => A.free(frame));
  const card = await pageCard(frame);
  assert.deepEqual(card.blocks[1].content, [
    ["div", { "data-card-placeholder": "dataframe" }, "Usage by day"],
  ]);
  assert.equal(card.rich, true);
  assert.equal(JSON.stringify(card).includes("/assets/"), false);
});

test("rich counts only what the card holds: an image below the fold isn't", async (t) => {
  const doc = page(`${paragraphs(80)}\n\n![Deep chart](${asset})`);
  t.after(() => A.free(doc));
  const card = await pageCard(doc);
  assert.equal(card.truncated, true);
  assert.equal(card.rich, false);
});

test("the serialized blocks stay within budget and a long first block is clipped, not dropped", async (t) => {
  // One block holding many paragraphs, far over the card budget. The preview
  // (page-preview.mjs) stops before a block that doesn't fit; a card keeps
  // its leading nodes.
  const doc = page(paragraphs(200));
  t.after(() => A.free(doc));
  assert.equal(pagePreview(doc, { maxBytes: CARD_BLOCKS_MAX_BYTES }).blocks.length, 0);
  const card = await pageCard(doc);
  assert.equal(card.truncated, true);
  assert.ok(blocksBytes(card) <= CARD_BLOCKS_MAX_BYTES, `${blocksBytes(card)} bytes`);
  assert.ok(blocksBytes(card) > CARD_BLOCKS_MAX_BYTES - 400, "the budget is used");
  assert.equal(card.blocks.length, 1);
  assert.deepEqual(card.blocks[0].content[0].slice(0, 2), ["p", {}]);
  assert.ok(card.blocks[0].content.length > 10);
});

test("the budget counts UTF-8 bytes and holds at any size", async (t) => {
  const doc = page(paragraphs(60, "漢字かな😀"));
  t.after(() => A.free(doc));
  for (const maxBytes of [200, 1000, 4096, CARD_BLOCKS_MAX_BYTES]) {
    const card = cardContent(doc, { maxBytes });
    assert.ok(blocksBytes(card) <= maxBytes, `${blocksBytes(card)} <= ${maxBytes}`);
    assert.equal(card.truncated, true);
    // Clipping never splits a code point.
    assert.equal(JSON.stringify(card).includes("\ufffd"), false);
  }
});

test("a huge code block or table is clipped to its leading lines and whole rows", async (t) => {
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  const code = page(`\`\`\`js\n${lines}\n\`\`\``);
  t.after(() => A.free(code));
  const clipped = cardContent(code);
  const [pre] = clipped.blocks[0].content;
  assert.equal(pre[0], "pre");
  assert.ok(pre[2][2].startsWith("line 0\nline 1\n"));
  assert.ok(blocksBytes(clipped) <= CARD_BLOCKS_MAX_BYTES);

  const rows = Array.from({ length: 400 }, (_, i) => `| r${i} | ${"cell ".repeat(8)} |`).join("\n");
  const table = page(`| a | b |\n|---|---|\n${rows}`);
  t.after(() => A.free(table));
  const card = cardContent(table);
  const tbody = card.blocks[0].content[0][2];
  assert.equal(tbody[0], "tbody");
  for (const row of tbody.slice(2)) assert.equal(row.length, 4, "every row keeps both cells");
});

test("the node cap bounds a Page of empty paragraphs", (t) => {
  const doc = page(Array.from({ length: 200 }, (_, i) => `${i}`).join("\n\n"));
  t.after(() => A.free(doc));
  const card = cardContent(doc);
  assert.equal(card.truncated, true);
  assert.equal(card.blocks[0].content.length, CARD_MAX_NODES);
});

test("an edit below the fold leaves the hash alone; one above it changes the hash", async (t) => {
  const doc = page(paragraphs(120));
  t.after(() => A.free(doc));
  const first = await pageCard(doc);
  assert.equal(first.truncated, true);

  // A new block at the end, and a change to the last paragraph of the block.
  let below = edit(A.clone(doc), [{ op: "insert_markdown", markdown: "A closing note." }]);
  below = A.change(below, (draft) =>
    applyPageOperation(draft, {
      operation: "edit_page",
      arguments: {
        operations: [
          {
            op: "replace_match",
            node_id: blockAddress(doc, orderedBlockIds(doc)[0]),
            match_text: "Paragraph 119",
            replacement: "The last paragraph",
          },
        ],
      },
      identity: owner,
    }),
  );
  const appended = await pageCard(below, { contentUpdatedAt: "2026-11-04T11:00:00.000Z" });
  assert.equal(appended.card_hash, first.card_hash);

  const above = edit(A.clone(doc), [
    { op: "insert_markdown", markdown: "## A new opening", after_node_id: null },
  ]);
  const changed = await pageCard(above);
  assert.notEqual(changed.card_hash, first.card_hash);
  const retitled = await pageCard(
    A.change(A.clone(doc), (draft) => {
      draft.title = "Roadmap, revised";
    }),
  );
  assert.notEqual(retitled.card_hash, first.card_hash);
  A.free(below);
  A.free(above);
});

test("the hash ignores content_updated_at and is stable across builds of the same content", async (t) => {
  const doc = page("Hello");
  t.after(() => A.free(doc));
  const a = await pageCard(doc, { contentUpdatedAt: "2026-11-04T10:00:00.000Z" });
  const b = await pageCard(A.clone(doc), { contentUpdatedAt: "2026-11-04T12:00:00.000Z" });
  assert.equal(a.card_hash, b.card_hash);
});

test("a long title is cut at a code point and says so", (t) => {
  const doc = page("Body", "🗺️".repeat(400));
  t.after(() => A.free(doc));
  const card = cardContent(doc);
  assert.equal(card.truncated, true);
  assert.ok(Array.from(card.title).length <= 300);
});

test("helpers: key, language, bounded size and clipping", () => {
  assert.equal(cardKey(pageId), `pages/${pageId}/card.json`);
  assert.equal(codeLanguage("mermaid"), "mermaid");
  assert.equal(codeLanguage("Python title=x"), "python");
  assert.equal(codeLanguage("<script>"), null);
  assert.equal(codeLanguage(""), null);
  assert.equal(sizeWithin(["p", {}, "abc"], 100), JSON.stringify(["p", {}, "abc"]).length);
  assert.equal(sizeWithin(["p", {}, "x".repeat(1000)], 100), Infinity);
  assert.deepEqual(clipNode(["p", {}, "hello world"], 14), ["p", {}, "hel"]);
  assert.equal(clipNode(["tr", {}, ["td", {}, "a"]], 4), null);
  assert.equal(clipNode(["p", {}, "x"], 3), null);
});

test("readStoredCard keeps only the card fields and refuses other versions", () => {
  assert.equal(readStoredCard(null), null);
  assert.equal(readStoredCard({ v: 2, card_hash: "x", blocks: [] }), null);
  assert.deepEqual(
    readStoredCard({
      v: 1,
      card_hash: "h",
      content_updated_at: 5,
      title: "T",
      blocks: [{ id: "b", content: [] }, { nope: true }],
      truncated: true,
      rich: "yes",
      url: "https://evil.example",
    }),
    {
      v: 1,
      card_hash: "h",
      content_updated_at: null,
      title: "T",
      blocks: [{ id: "b", content: [] }],
      truncated: true,
      rich: false,
    },
  );
});

test("bumping the builder version changes the hash of the same content", async (t) => {
  const doc = page("Hello");
  t.after(() => A.free(doc));
  const content = cardContent(doc);
  const current = await cardHash(content);
  assert.equal((await pageCard(doc)).card_hash, current);
  assert.equal(await cardHash(content, { builderVersion: CARD_BUILDER_VERSION }), current);
  assert.notEqual(await cardHash(content, { builderVersion: CARD_BUILDER_VERSION + 1 }), current);
});

test("an emptied Page has no blocks; rules, placeholders and checkboxes count", async (t) => {
  for (const markdown of ["", "\n\n\n", "   ", "&nbsp;"]) {
    const doc = page(markdown);
    t.after(() => A.free(doc));
    const card = await pageCard(doc);
    assert.deepEqual(card.blocks, [], JSON.stringify(markdown));
  }
  const kept = page(`![](${asset})\n\n---\n\n- [ ] \n\nText\n\n\u00a0`);
  t.after(() => A.free(kept));
  const content = (await pageCard(kept)).blocks.flatMap((block) => block.content);
  assert.deepEqual(
    content.map((node) => node[0]),
    ["p", "hr", "ul", "p"],
    "blank paragraphs drop, the rest stays",
  );
  assert.equal(showsContent(["p", {}, " \n "]), false);
  assert.equal(showsContent(["p", {}, ["strong", {}, "x"]]), true);
});

test("the hash covers truncated: the same blocks, cut or not, hash apart", async () => {
  const content = { title: "T", blocks: [{ id: "b", content: [["p", {}, "x"]] }] };
  assert.notEqual(
    await cardHash({ ...content, truncated: false }),
    await cardHash({ ...content, truncated: true }),
  );
});
