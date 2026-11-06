// ONE-SHOT MIGRATION tests: delete with comments-normalization.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  applyCommentsNormalization,
  commentsNormalizationBlocked,
  commentsNormalizationProblems,
  planCommentsNormalization,
} from "./comments-normalization.mjs";
import { comment, newCommentsDoc } from "./comments-test-support.mjs";
import { projectReadComments } from "./read-comments.mjs";
import { RICH_FORMAT } from "./richtext-format.mjs";
import { adapterSpans, pageSpans } from "./richtext-spans.mjs";
import { parseAgentMarkdown, parseMarkdown } from "./markdown-import.mjs";
import { createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { admitCommentChanges } from "./comment-authority.mjs";

const page = A.change(A.from(createPageData({ pageId: "migration", title: "Migration" })), (d) =>
  initializePage(d, "A passage to discuss"),
);
const blockId = orderedBlockIds(page)[0];
const author = { principal: "user:test", displayName: "Test", driver: "Test" };

/** A comments document with one thread per message, each message rewritten
 * by `seed(message, path, draft)` into an earlier build's form. */
function seeded(seeds) {
  let comments = newCommentsDoc();
  const ids = [];
  for (let index = 0; index < seeds.length; index++) {
    const next = comment(page, comments, {
      action: "add",
      block_id: blockId,
      selected_text: "passage",
      body: "placeholder",
    });
    comments = next.comments;
    ids.push(next.result);
  }
  comments = A.change(comments, (d) => {
    seeds.forEach((seed, index) => {
      const { thread_id, message_id } = ids[index];
      seed(d, ["threads", thread_id, "messages", message_id]);
    });
  });
  return { comments, ids };
}
const at = (doc, path) => path.reduce((value, key) => value[key], doc);
/** An earlier build's plain message: a literal body, no rich text. */
const plainBody = (text) => (d, path) => {
  const message = at(d, path);
  at(d, path.slice(0, -1))[path.at(-1)] = {
    body: text,
    author: { ...message.author },
    createdAt: message.createdAt,
    deletedAt: null,
  };
};
/** An earlier build's rich message: adapter-form spans and a Markdown copy. */
const adapterRich = (markdown) => (d, path) => {
  const message = at(d, path);
  delete message.bodyFormat;
  message.body = markdown;
  A.updateSpans(d, [...path, "richText"], adapterSpans(parseMarkdown(markdown)));
};
const run = (doc) => {
  const { report, writes } = planCommentsNormalization(doc);
  const after = A.change(A.clone(doc), (d) => applyCommentsNormalization(d, writes));
  return { report, writes, after };
};

test("plain bodies become plain spans and adapter spans the editor's form, keeping ids", () => {
  const literal = "2 * 3 = **six**\nsecond line";
  const markdown = "Opening paragraph **bold**\n\n> - quoted list\n\n```\ncode\n```";
  const { comments, ids } = seeded([plainBody(literal), adapterRich(markdown)]);
  const before = projectReadComments(page, {}, comments);
  const { report, writes, after } = run(comments);
  assert.equal(commentsNormalizationBlocked(report), false);
  assert.equal(writes.length, 2);
  assert.equal(report.forms.plain_body, 1);
  assert.equal(report.forms.markdown_copy, 1);
  const [plainId, richId] = ids;
  const plainMessage = after.threads[plainId.thread_id].messages[plainId.message_id];
  assert.equal(plainMessage.format, RICH_FORMAT);
  assert.equal(plainMessage.bodyFormat, "plain");
  assert.equal(plainMessage.body, undefined);
  const richMessage = after.threads[richId.thread_id].messages[richId.message_id];
  assert.equal(richMessage.body, undefined);
  assert.equal(richMessage.bodyFormat, undefined);
  assert.equal(
    String(A.spans(richMessage, ["richText"])[0].value?.type ?? "text"),
    "text",
    "the opening paragraph has no marker of its own",
  );
  // Reads are unchanged: same ids, bodies, formats, anchors.
  assert.deepEqual(projectReadComments(page, {}, after), before);
  // A second plan has nothing left to do.
  const again = planCommentsNormalization(after);
  assert.equal(again.writes.length, 0);
  assert.deepEqual(commentsNormalizationProblems(again.report), []);
});

test("rewritten spans equal what the editor writes for the same content", () => {
  const markdown = "First\n\nSecond with `code` and a [link](https://example.org/)";
  const { comments, ids } = seeded([adapterRich(markdown)]);
  const { after } = run(comments);
  const message = after.threads[ids[0].thread_id].messages[ids[0].message_id];
  const join = (spans) =>
    JSON.parse(JSON.stringify(spans)).reduce((out, span) => {
      const last = out.at(-1);
      if (
        span.type === "text" &&
        last?.type === "text" &&
        JSON.stringify(last.marks ?? {}) === JSON.stringify(span.marks ?? {})
      )
        last.value += span.value;
      else out.push(span.type === "text" ? { ...span, marks: span.marks ?? {} } : span);
      return out;
    }, []);
  assert.deepEqual(
    join(A.spans(message, ["richText"])),
    join(pageSpans(parseAgentMarkdown(markdown))),
  );
});

test("a message in the current form is unchanged and plans nothing", () => {
  let comments = newCommentsDoc();
  comments = comment(page, comments, {
    block_id: blockId,
    body: "**Rich**",
    body_format: "markdown",
  }).comments;
  comments = comment(page, comments, { block_id: blockId, body: "plain *text*" }).comments;
  const { report, writes } = planCommentsNormalization(comments);
  assert.equal(writes.length, 0);
  assert.equal(report.messages.length, 0);
});

test("deleted messages are rewritten too, and stay deleted", () => {
  const { comments, ids } = seeded([
    (d, path) => {
      plainBody("gone")(d, path);
      at(d, path).deletedAt = "2026-11-01T00:00:00.000Z";
    },
  ]);
  const { after, writes } = run(comments);
  assert.equal(writes.length, 1);
  const message = after.threads[ids[0].thread_id].messages[ids[0].message_id];
  assert.equal(message.deletedAt, "2026-11-01T00:00:00.000Z");
  assert.equal(message.richText, "gone");
});

test("a message the rewrite can't keep whole is refused, and the plan is blocked", () => {
  const { comments } = seeded([
    // An unknown node inside a code block: the editor can't hold it.
    (d, path) => {
      const message = at(d, path);
      message.body = "copy";
      A.updateSpans(
        d,
        [...path, "richText"],
        [
          {
            type: "block",
            value: { type: "code-block", parents: [], attrs: { params: "" }, isEmbed: false },
          },
          { type: "text", value: "x" },
          {
            type: "block",
            value: { type: "future-embed", parents: ["code-block"], attrs: {}, isEmbed: true },
          },
        ],
      );
    },
    // A plain body whose hard breaks would exceed 64 KiB of spans.
    plainBody("\n".repeat(2000) + "x"),
    plainBody("fine"),
  ]);
  const { report, writes } = planCommentsNormalization(comments);
  assert.equal(commentsNormalizationBlocked(report), true);
  assert.deepEqual(report.refused_reasons, { lossy: 1, invalid_content: 1 });
  assert.equal(writes.length, 1, "the sound message is still planned and reported");
  assert.equal(commentsNormalizationProblems(report).length, 3);
});

test("a migrated document passes per-author admission for later edits", () => {
  const { comments, ids } = seeded([plainBody("before")]);
  const { after } = run(comments);
  const edited = A.change(A.clone(after, { actor: "aa".repeat(16) }), (d) => {
    A.updateText(
      d,
      ["threads", ids[0].thread_id, "messages", ids[0].message_id, "richText"],
      "after",
    );
  });
  const result = admitCommentChanges(after, A.getChanges(after, edited), author.principal, {
    role: "editor",
  });
  assert.equal(result.ok, true, JSON.stringify(result.reason));
  A.free(result.next);
});
