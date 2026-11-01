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
import { fixture, pageId, trashArgs } from "./trash-fixture.mjs";

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

// Cut the conversion after its durable intent and before the document bytes
// reach storage, then rebuild the host from storage alone. Journal recovery
// applies the recorded change, and the load's conversion finds nothing left.
test("a crash after the conversion intent and before the document flush converts exactly once", async (t) => {
  const plain = await fixture(t);
  const stored = preservedPage();
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(stored) });
  A.free(stored);
  let flushes = 0;
  // documentMutation flushes the base, persists the intent, applies, then
  // flushes the result: the second flush is the cut.
  f.hooks.flush = () => {
    if (++flushes === 2) throw Object.assign(Error("process killed"), { cut: true });
  };
  await f.page.convertPreservedMarkdown();
  const journal = async () => [
    ...(await f.storage.list({ prefix: "host/operation/pages_preserved_markdown_" })),
  ];
  const [[, intent]] = await journal();
  assert.equal(intent.pending, true, "the intent is durable and unfinished");
  f.hooks.flush = undefined;

  await f.crashRestart();
  assert.equal(hasPreservedBlocks(f.doc()), false);
  const id = orderedBlockIds(f.doc())[0];
  const markdown = exportMarkdown(richDoc(f.doc().blocks[id]));
  assert.equal(markdown.split("drop").length, 2, "converted once");
  const entries = await journal();
  assert.equal(entries.length, 1);
  assert.equal(entries[0][1].pending, false);
  // Another crash restart writes nothing.
  const heads = f.heads();
  await f.crashRestart();
  assert.deepEqual(f.heads(), heads);
});

test("restoring a trashed Page converts its preserved blocks before access reopens", async (t) => {
  const plain = await fixture(t);
  const stored = preservedPage();
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(stored) });
  A.free(stored);
  // Trash it before the host converts, as a Page trashed under an older build.
  const trashed = await f.catalogCall("owner", "delete_page", trashArgs(f));
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  await f.page.convertPreservedMarkdown();
  assert.ok(hasPreservedBlocks(f.doc()), "a trashed Page is not converted");
  let convertedBeforeAccess;
  const refresh = f.page.policy.refreshAccess.bind(f.page.policy);
  f.page.policy.refreshAccess = async (...args) => {
    convertedBeforeAccess ??= !hasPreservedBlocks(f.doc());
    return refresh(...args);
  };
  const restored = await f.catalogCall("owner", "restore_page", {
    page_id: pageId,
    idempotency_key: "restore-preserved",
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  // No restart: the restore itself converted, before access refreshed.
  assert.equal(convertedBeforeAccess, true);
  assert.equal(hasPreservedBlocks(f.doc()), false);
  assert.ok(documentFeatures(f.doc()).includes(CONVERSION_FEATURE));
});

test("agent writes that would lose content are refused with the construct and position", async (t) => {
  const f = await fixture(t);
  for (const [markdown, construct, line, column] of [
    ["[![caption](image.png)](https://example.org)", "wrapped-image", 1, 2],
    ["| A |\n| --- |\n| b | c |", "table-cells", 3, 5],
    ["See [](https://example.org)", "empty-link", 1, 5],
    ["Prose.\n\n[unused]: https://example.org", "definition", 3, 1],
  ]) {
    const refused = await f.tool("owner", "edit_page", {
      base_heads: f.heads(),
      idempotency_key: `lossy-${construct}`,
      operations: [{ op: "insert_markdown", markdown }],
    });
    refusedWith(refused, construct, line, column);
  }
});

test("a preserved block whose source would lose content converts to literal text", async (t) => {
  const plain = await fixture(t);
  let stored = A.change(A.from(createPageData({ pageId, title: "Lossy" })), (draft) =>
    initializePage(draft, ""),
  );
  const id = orderedBlockIds(stored)[0];
  const source = "[![caption](image.png)](https://example.org)\n\n| A |\n| --- |\n| b | c |";
  stored = A.change(stored, (draft) =>
    A.updateSpans(
      draft,
      textPath(id),
      pmNodeToSpans(
        adapter,
        schema.node("doc", null, [schema.node("raw", { source, importId: "", kind: "markdown" })]),
      ),
      adapter.updateSpansConfig(),
    ),
  );
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(stored) });
  A.free(stored);
  await f.page.convertPreservedMarkdown();
  const doc = richDoc(f.doc().blocks[id]);
  // Every character survives as text: the link, the image and every cell.
  for (const part of source.split("\n").filter(Boolean)) assert.ok(doc.textContent.includes(part));
  doc.descendants((node) => {
    assert.ok(!["image", "table", "raw"].includes(node.type.name), node.type.name);
  });
});
