import assert from "node:assert/strict";
import test from "node:test";
import * as A from "@automerge/automerge";
import MarkdownIt from "markdown-it";
import { pageMarkdown } from "./markdown-export.mjs";
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
            {
              op: "patch_block_markdown",
              block_id: first,
              replacements: [{ old: "Old", new: "Current" }],
            },
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
