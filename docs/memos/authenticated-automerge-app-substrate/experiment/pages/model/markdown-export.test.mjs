import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import MarkdownIt from "markdown-it";
import { pageMarkdown, unsentCommentsMarkdown } from "./markdown-export.mjs";
import { applyPageOperation, createPageData, initializePage, projectPage } from "./page.mjs";

const page = (title, ...blocks) => ({ title, blocks: blocks.map((markdown) => ({ markdown })) });

test("whole-page Markdown includes the title and ordered blocks without rewriting their content", () => {
  const blocks = [
    "First paragraph.",
    "- [ ] Follow up\n- [x] Finished",
    "| Approach | Benefit |\n| --- | --- |\n| Shared | Realtime |",
    "```mermaid\ngraph TD\nA --> B\n```",
    "![Private image](/api/pages/page-one/assets/" + "a".repeat(64) + ")",
  ];
  assert.equal(
    pageMarkdown(page("Project plan", ...blocks)),
    `# Project plan\n\n${blocks.join("\n\n")}\n`,
  );
});

test("an existing matching leading H1 supplies the title exactly once", () => {
  for (const body of [
    "# Project plan\n\nContent",
    "# **Project plan**\n\nContent",
    "Project plan\n============\n\nContent",
  ]) {
    assert.equal(pageMarkdown(page("Project plan", body)), `${body}\n`);
  }
  assert.equal(
    pageMarkdown(page("Project plan", "# A different heading\n\nContent")),
    "# Project plan\n\n# A different heading\n\nContent\n",
  );
  assert.equal(
    pageMarkdown(page("Project plan", "## Project plan\n\nContent")),
    "# Project plan\n\n## Project plan\n\nContent\n",
  );
});

test("plain metadata titles cannot become Markdown links, formatting, or HTML", () => {
  const title = "**Plan** &amp; <img> [link](https://example.com) `code`";
  const tokens = new MarkdownIt({ html: false }).parse(pageMarkdown(page(title, "Body")), {});
  assert.equal(tokens[0].tag, "h1");
  assert.deepEqual(
    tokens[1].children.map(({ type, content }) => ({ type, content })),
    [{ type: "text", content: title }],
  );
  assert.equal(pageMarkdown(page("Multi\nline title")), "# Multi line title\n");
  assert.equal(pageMarkdown(page("")), "# Untitled\n");
  assert.throws(() => pageMarkdown(null), /No Page to copy/);
});

test("export uses live rich text and fractional block order from the Page projection", () => {
  let doc = A.from(createPageData({ pageId: "copy-fixture", title: "Before" }));
  try {
    doc = A.change(doc, (draft) => initializePage(draft, "Old content"));
    const first = projectPage(doc).blocks[0].id;
    doc = A.change(doc, (draft) =>
      applyPageOperation(draft, {
        operation: "edit_page",
        arguments: {
          operations: [
            { op: "set_title", title: "Current title" },
            { op: "replace_match", block_id: first, match_text: "Old", replacement: "Current" },
            { op: "insert_markdown", after_block_id: null, markdown: "First section" },
          ],
        },
      }),
    );
    assert.notEqual(
      doc.blocks[first].markdown,
      "Current content",
      "raw import source is not the current text",
    );
    assert.equal(
      pageMarkdown(projectPage(doc)),
      "# Current title\n\nFirst section\n\nCurrent content\n",
    );
  } finally {
    A.free(doc);
  }
});

test("unsent comments quote their passage and list only what the saved state lacks", () => {
  const message = (id, body, createdAt, extra = {}) => ({
    id,
    body,
    createdAt,
    author: { displayName: "Ada" },
    deletedAt: null,
    ...extra,
  });
  const thread = (id, messages, selectionContext) => ({
    id,
    target: { kind: "block", blockId: "b1" },
    selectionContext,
    messages,
  });
  const saved = {
    blocks: [{ id: "b1", markdown: "Block text" }],
    comments: [thread("t1", [message("m1", "Sent", "1"), message("m2", "Before edit", "2")])],
  };
  const current = {
    ...saved,
    comments: [
      thread("t1", [
        message("m1", "Sent", "1"),
        message("m2", "After edit", "2"),
        message("m3", "Two lines\nof reply", "3"),
        message("m4", "Gone", "4", { deletedAt: "5" }),
      ]),
      thread("t2", [message("m5", "Fresh", "6")], { status: "attached", text: "picked words" }),
    ],
  };
  const section = unsentCommentsMarkdown(current, saved);
  assert.match(section, /^\n---\n\n## Unsent comments\n\nThese comments and replies never reached/);
  assert.match(
    section,
    /### On “Block text”\n\nThread t1\n\n\*\*Ada\*\* · edited · 2\n\n> After edit/,
  );
  assert.match(section, /\*\*Ada\*\* · reply · 3\n\n> Two lines\n> of reply/);
  assert.match(
    section,
    /### On “picked words”\n\nThread t2\n\n\*\*Ada\*\* · comment · 6\n\n> Fresh/,
  );
  assert.doesNotMatch(section, /> Sent|Gone/);
  assert.equal(unsentCommentsMarkdown(saved, saved), "");
  assert.match(unsentCommentsMarkdown(saved, null), /may not have reached the server[\s\S]*> Sent/);
});
