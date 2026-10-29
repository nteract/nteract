import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyComment, projectComments } from "./comments.mjs";
import { projectReadComments } from "./read-comments.mjs";
import { projectReadChanges } from "./read-changes.mjs";
import {
  commentMarkdown,
  validateCommentContent,
  markdownCommentSpans,
} from "./comment-content.mjs";

const identity = { principal: "fixture", displayName: "Writer", driver: "Test" };
const fixture = () =>
  A.from({
    page_id: "comments",
    title: "Test",
    blocks: { one: { markdown: "A passage", position: "a0" } },
    comments: {},
  });
const table =
  "**Decision**\n\n| Option | Result |\n| --- | --- |\n| Native | **Editable** |\n| Markdown | `Portable` |";
function add(doc, body = table, extra = {}) {
  let ids;
  doc = A.change(doc, (d) => {
    ids = applyComment(
      d,
      {
        action: "add",
        block_id: "one",
        selected_text: "passage",
        body,
        body_format: "markdown",
        ...extra,
      },
      identity,
    );
  });
  return { doc, ids, path: ["comments", ids.thread_id, "messages", ids.message_id] };
}
const messageAt = (doc, path) => path.reduce((value, key) => value[key], doc);

test("Markdown comments store native tables and marks, with Markdown tool projections", () => {
  const { doc, path } = add(fixture());
  const message = messageAt(doc, path);
  assert.equal(message.body, table, "original input remains readable by old clients");
  const spans = A.spans(message, ["richText"]);
  assert.ok(spans.some((s) => s.type === "block" && String(s.value.type) === "table-cell"));
  assert.ok(spans.some((s) => s.type === "text" && s.marks?.strong));
  const full = projectComments(doc)[0],
    compact = projectReadComments(doc)[0];
  assert.equal(full.selectionContext.text, "passage");
  for (const view of [full, compact]) {
    assert.equal(view.messages[0].body_format, "markdown");
    assert.match(view.messages[0].body, /\| Native\s*\| \*\*Editable\*\*/);
    assert.equal(view.messages[0].richText, undefined);
  }
  assert.equal(commentMarkdown(messageAt(A.load(A.save(doc)), path)), commentMarkdown(message));
});

test("legacy comments remain literal and explicit Markdown conversion keeps IDs and anchors", () => {
  const {
    doc: before,
    ids,
    path,
  } = add(fixture(), "**literal** | <b>text</b>", { body_format: "plain" });
  assert.equal(messageAt(before, path).format, undefined);
  assert.equal(projectComments(before)[0].messages[0].body, "**literal** | <b>text</b>");
  const after = A.change(before, (d) =>
    applyComment(
      d,
      { action: "edit", ...ids, body: "**Rich now**", body_format: "markdown" },
      identity,
    ),
  );
  assert.deepEqual(after.comments[ids.thread_id].target, before.comments[ids.thread_id].target);
  assert.equal(projectComments(after)[0].messages[0].id, ids.message_id);
  assert.equal(commentMarkdown(messageAt(after, path)), "**Rich now**");
  assert.equal(
    messageAt(after, path).body,
    "**literal** | <b>text</b>",
    "import provenance is not a second editing authority",
  );
});

test("rich message edits preserve Markdown mode; explicit plain input remains literal", () => {
  let { doc, ids, path } = add(fixture());
  doc = A.change(doc, (d) =>
    applyComment(d, { action: "edit", ...ids, body: "**Updated**" }, identity),
  );
  assert.equal(commentMarkdown(messageAt(doc, path)), "**Updated**");
  doc = A.change(doc, (d) =>
    applyComment(
      d,
      { action: "edit", ...ids, body: "**literal**", body_format: "plain" },
      identity,
    ),
  );
  assert.equal(messageAt(doc, path).richText.replaceAll("\ufffc", ""), "**literal**");
  assert.ok(!A.spans(messageAt(doc, path), ["richText"]).some((s) => s.marks?.strong));
});

test("formatting-only comment changes are visible in both change-feed modes", () => {
  const { doc: before, path, ids } = add(fixture(), "Native text");
  const start = messageAt(before, path).richText.indexOf("Native");
  const after = A.change(before, (d) =>
    A.mark(d, [...path, "richText"], { start, end: start + 6, expand: "both" }, "strong", true),
  );
  assert.equal(JSON.stringify(before.comments), JSON.stringify(after.comments));
  for (const comments of ["summary", "all"]) {
    const result = projectReadChanges(after, { since_heads: A.getHeads(before), comments });
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].id, ids.thread_id);
    if (comments === "all") assert.match(result.comments[0].messages[0].body, /\*\*Native\*\*/);
  }
});

test("rich tombstones expose no body or native content", () => {
  const { doc: before, ids } = add(fixture());
  const after = A.change(before, (d) =>
    applyComment(d, { action: "delete_message", ...ids }, identity),
  );
  for (const messages of [
    projectComments(after)[0].messages,
    projectReadComments(after)[0].messages,
  ]) {
    assert.ok(messages[0].deletedAt);
    assert.equal(messages[0].body, undefined);
    assert.equal(messages[0].richText, undefined);
  }
});

test("comment inputs bound source and structural size and reject invalid format", () => {
  for (const [body, extra, error] of [
    ["x".repeat(16001), {}, /16000/],
    [" ", {}, /16000/],
    ["Text", { body_format: "html" }, /body_format/],
    ["| A | B |\n| --- | --- |\n" + "| | |\n".repeat(1000), {}, /64 KiB/],
  ])
    assert.throws(() => add(fixture(), body, extra), error);
  const { doc, path } = add(fixture());
  assert.doesNotThrow(() => validateCommentContent(messageAt(doc, path)));
});

test("concurrent rich replies preserve both messages and the original selection anchor", () => {
  const { doc: before, ids } = add(fixture());
  const reply = (doc, body) =>
    A.change(doc, (d) =>
      applyComment(
        d,
        { action: "reply", thread_id: ids.thread_id, body, body_format: "markdown" },
        identity,
      ),
    );
  const merged = A.merge(reply(A.clone(before), "**One**"), reply(A.clone(before), "`Two`"));
  const thread = projectComments(merged)[0];
  assert.equal(thread.messages.length, 3);
  assert.equal(thread.selectionContext.text, "passage");
  assert.ok(thread.messages.some((m) => m.body === "**One**"));
  assert.ok(thread.messages.some((m) => m.body === "`Two`"));
});

test("browser submission preserves native marks without a Markdown round trip", () => {
  const spans = markdownCommentSpans("**[Linked](https://example.com/)** text");
  let ids;
  const doc = A.change(fixture(), (d) => {
    ids = applyComment(
      d,
      { action: "add", block_id: "one", body: "Import provenance", body_format: "markdown" },
      identity,
      spans,
    );
  });
  const saved = A.load(A.save(doc));
  const message = saved.comments[ids.thread_id].messages[ids.message_id];
  const normalize = (items) => items.map((s) => ({ ...s, marks: s.marks ?? {} }));
  assert.deepEqual(normalize(A.spans(message, ["richText"])), normalize(spans));
  assert.equal(message.body, "Import provenance");
  assert.match(projectComments(saved)[0].messages[0].body, /example.com/);
});

test("one unreadable native comment preserves Page reads and reports frozen provenance", () => {
  const { doc: before, ids, path } = add(fixture(), "Original import");
  const heads = A.getHeads(before);
  const after = A.change(before, (d) => {
    const message = messageAt(d, path);
    message.richText = 7; // A malformed peer payload, never accepted by applyComment.
  });
  for (const projected of [projectComments(after), projectReadComments(after)]) {
    const message = projected[0].messages[0];
    assert.equal(message.body, "Original import");
    assert.equal(message.body_format, "plain");
    assert.equal(message.content_error, "rich_text_unavailable");
    assert.equal(message.id, ids.message_id);
  }
  for (const comments of ["summary", "all"])
    assert.equal(projectReadChanges(after, { since_heads: heads, comments }).comments.length, 1);
  assert.equal(messageAt(after, path).richText, 7, "read recovery never rewrites native data");
});

test("invalid native submission rolls back every comment field", () => {
  const doc = fixture();
  const heads = A.getHeads(doc);
  const spans = markdownCommentSpans("x".repeat(16001));
  assert.throws(
    () =>
      A.change(doc, (d) =>
        applyComment(
          d,
          {
            action: "add",
            block_id: "one",
            body: "Small import",
            body_format: "markdown",
          },
          identity,
          spans,
        ),
      ),
    /16000/,
  );
  assert.deepEqual(A.getHeads(doc), heads);
  assert.deepEqual(projectComments(doc), []);
});
