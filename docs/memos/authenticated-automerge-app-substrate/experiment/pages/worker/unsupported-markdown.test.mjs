// Agent writes refuse Markdown Pages can't represent with a coded error, and
// the Page host converts stored preserved blocks once, as their only writer.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { pmNodeToSpans } from "@automerge/prosemirror";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { adapter, exportMarkdown, richDoc, schema, textPath } from "../model/richtext.mjs";
import { CONVERSION_FEATURE, hasPreservedBlocks } from "../model/raw-migration.mjs";
import { documentFeatures } from "../model/schema-features.mjs";
import { fixture, pageId } from "./trash-fixture.mjs";

const refusedWith = (response, construct, line, column) => {
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "unsupported_markdown");
  assert.equal(response.body.unsupported.construct, construct);
  assert.equal(response.body.unsupported.line, line);
  assert.equal(response.body.unsupported.column, column);
  assert.match(response.body.error, new RegExp(`line ${line}, column ${column}`));
};

test("edits and comments with math or HTML are refused with the construct and position", async (t) => {
  const f = await fixture(t);
  const heads = f.heads();
  for (const [operation, args, construct, line, column] of [
    [
      "edit_page",
      { operations: [{ op: "insert_markdown", markdown: "Intro\n\nThe area is $\\pi r^2$." }] },
      "math",
      3,
      13,
    ],
    [
      "edit_page",
      {
        operations: [
          { op: "replace_block_markdown", block_id: f.blockId, markdown: "<details>x</details>" },
        ],
      },
      "html",
      1,
      1,
    ],
    [
      "manage_page_comment",
      { action: "add", block_id: f.blockId, body: "See $x$", body_format: "markdown" },
      "math",
      1,
      5,
    ],
  ]) {
    const refused = await f.tool("owner", operation, {
      ...args,
      base_heads: heads,
      idempotency_key: `unsupported-${operation}-${construct}`,
    });
    refusedWith(refused, construct, line, column);
  }
  assert.deepEqual(f.heads(), heads, "nothing is written");

  // The same text in a code span is fine, and a plain comment is literal.
  const accepted = await f.tool("owner", "edit_page", {
    base_heads: heads,
    idempotency_key: "supported-code-span",
    operations: [{ op: "insert_markdown", markdown: "Keep `~~x~~` and `$x$` and ~~old~~." }],
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const plain = await f.tool("owner", "manage_page_comment", {
    base_heads: f.heads(),
    idempotency_key: "plain-comment-math",
    action: "add",
    block_id: f.blockId,
    body: "Literal $x$ and <b>",
  });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
});

test("create_page refuses unsupported Markdown before reserving anything", async (t) => {
  const f = await fixture(t);
  const catalog = f.catalogOf(f.owner);
  const before = new Map(catalog.storage.values);
  const refused = await f.catalogCall("owner", "create_page", {
    title: "Math",
    markdown: "Euler: $e^{i\\pi} + 1 = 0$",
    idempotency_key: "create-with-math",
  });
  refusedWith(refused, "math", 1, 8);
  assert.deepEqual(catalog.storage.values, before);
});

// A Page as an older build stored it: preserved blocks in the body and in a
// comment message.
function preservedPage() {
  let doc = A.change(A.from(createPageData({ pageId, title: "Launch plan" })), (draft) =>
    initializePage(draft, "We ship on Friday."),
  );
  const id = orderedBlockIds(doc)[0];
  const tree = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("We ship on Friday.")]),
    schema.node("raw", {
      source: "Keep `~~x~~` and ~~drop~~.\n\n---\n\nThe value is $x + 1$.",
      importId: "",
      kind: "markdown",
    }),
  ]);
  doc = A.change(doc, (draft) =>
    A.updateSpans(draft, textPath(id), pmNodeToSpans(adapter, tree), adapter.updateSpansConfig()),
  );
  return doc;
}

test("the host converts preserved blocks once, through the operation journal", async (t) => {
  const plain = await fixture(t);
  const stored = preservedPage();
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(stored) });
  A.free(stored);
  assert.ok(hasPreservedBlocks(f.doc()));
  // Two triggers at once, as a load and a creation could race: both resolve
  // to one journal entry keyed by the converted heads.
  await Promise.all([f.page.convertPreservedMarkdown(), f.page.convertPreservedMarkdown()]);
  assert.equal(hasPreservedBlocks(f.doc()), false);
  const id = orderedBlockIds(f.doc())[0];
  const markdown = exportMarkdown(richDoc(f.doc().blocks[id]));
  assert.equal(
    markdown,
    "We ship on Friday.\n\nKeep `~~x~~` and ~~drop~~.\n\n---\n\nThe value is \\$x + 1\\$.",
  );
  assert.equal(markdown.split("drop").length, 2, "converted once");
  assert.ok(documentFeatures(f.doc()).includes(CONVERSION_FEATURE));
  const journal = [
    ...(await f.storage.list({ prefix: "host/operation/pages_preserved_markdown_" })),
  ];
  assert.equal(journal.length, 1);
  assert.equal(journal[0][1].pending, false);
  // Idempotent: a later load finds nothing to convert and writes nothing.
  const heads = f.heads();
  await f.page.convertPreservedMarkdown();
  await (await f.restart()).convertPreservedMarkdown();
  assert.deepEqual(f.heads(), heads);
});

test("the host leaves a Page alone when this build can't write it", async (t) => {
  const plain = await fixture(t);
  const stored = A.change(preservedPage(), (draft) => {
    draft.schema = { features: ["future-feature"] };
  });
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(stored) });
  A.free(stored);
  const heads = f.heads();
  await f.page.convertPreservedMarkdown();
  assert.deepEqual(f.heads(), heads);
  assert.ok(hasPreservedBlocks(f.doc()));
});
