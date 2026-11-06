import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  applyComment as applyCommentTo,
  projectComments as projectCommentsOf,
} from "./comments.mjs";
import { projectReadComments as projectReadCommentsOf } from "./read-comments.mjs";
import { projectReadChanges as projectReadChangesOf } from "./read-changes.mjs";
import { currentForm } from "./richtext-test-support.mjs";

// Comment content, isolated from document separation: one document plays
// both roles, holding the blocks anchors resolve against and the threads.
const applyComment = (d, input, identity, spans) =>
  applyCommentTo(d, input, identity, spans, { page: d, role: "editor" });
const projectComments = (doc) => projectCommentsOf(doc, doc);
const projectReadComments = (doc, options) => projectReadCommentsOf(doc, options, doc);
const projectReadChanges = (doc, args) =>
  projectReadChangesOf(doc, { ...args, since_comment_heads: args.since_heads }, doc);
import {
  commentMarkdown,
  validateCommentContent,
  validateCommentSpans,
  markdownCommentSpans,
  plainCommentSpans,
} from "./comment-content.mjs";
import { adapterSpans, pageSpans } from "./richtext-spans.mjs";
import { parseAgentMarkdown } from "./markdown-import.mjs";
import { schema } from "./pm-adapter.mjs";
import { RICH_FORMAT } from "./richtext-format.mjs";

const identity = { principal: "fixture", displayName: "Writer", driver: "Test" };
const fixture = () =>
  A.change(
    A.from({
      page_id: "comments",
      title: "Test",
      blocks: { one: { markdown: "A passage", position: "a0" } },
      threads: {},
    }),
    currentForm,
  );
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
  return { doc, ids, path: ["threads", ids.thread_id, "messages", ids.message_id] };
}
const messageAt = (doc, path) => path.reduce((value, key) => value[key], doc);

test("Markdown comments store native tables and marks, with Markdown tool projections", () => {
  const { doc, path } = add(fixture());
  const message = messageAt(doc, path);
  assert.equal(message.body, undefined, "a rich message stores no Markdown copy");
  const spans = A.spans(message, ["richText"]);
  assert.deepEqual(plain(spans), plain(pageSpans(parseAgentMarkdown(table))), "editor form");
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

// Spans as plain data, for comparing stored spans with written ones.
const plain = (spans) =>
  JSON.parse(
    JSON.stringify(spans, (_key, value) => (A.isImmutableString?.(value) ? String(value) : value)),
  ).map((span) => (span.type === "text" ? { ...span, marks: span.marks ?? {} } : span));

test("plain input is stored as unmarked spans and read back literally", () => {
  const literal = "**literal** | <b>text</b>\n2 * 3";
  const { doc, ids, path } = add(fixture(), literal, { body_format: "plain" });
  const message = messageAt(doc, path);
  assert.equal(message.format, RICH_FORMAT, "one stored shape for every message");
  assert.equal(message.bodyFormat, "plain", "the author's format is recorded");
  assert.equal(message.body, undefined);
  const spans = A.spans(message, ["richText"]);
  assert.deepEqual(plain(spans), plain(plainCommentSpans(literal)));
  assert.ok(spans.every((span) => span.type !== "text" || !Object.keys(span.marks ?? {}).length));
  assert.ok(
    spans.some((span) => span.type === "block" && String(span.value.type) === "hard-break"),
    "a newline is a hard break, as the editor writes it",
  );
  for (const view of [projectComments(doc)[0], projectReadComments(doc)[0]]) {
    assert.equal(view.messages[0].body, literal);
    assert.equal(view.messages[0].body_format, undefined, "plain reads keep their contract");
    assert.equal(view.messages[0].bodyFormat, undefined);
  }
  // An edit without a format keeps the author's plain text literal.
  const edited = A.change(doc, (d) =>
    applyComment(d, { action: "edit", ...ids, body: "_still_ literal" }, identity),
  );
  assert.equal(commentMarkdown(messageAt(edited, path)), "_still_ literal");
  assert.equal(messageAt(edited, path).bodyFormat, "plain");
});

test("an edit switches between plain and Markdown in place", () => {
  let { doc, ids, path } = add(fixture(), "**plain**", { body_format: "plain" });
  const target = doc.threads[ids.thread_id].target;
  doc = A.change(doc, (d) =>
    applyComment(
      d,
      { action: "edit", ...ids, body: "**Rich now**", body_format: "markdown" },
      identity,
    ),
  );
  assert.deepEqual(doc.threads[ids.thread_id].target, target);
  assert.equal(projectComments(doc)[0].messages[0].id, ids.message_id);
  assert.equal(messageAt(doc, path).bodyFormat, undefined);
  assert.equal(commentMarkdown(messageAt(doc, path)), "**Rich now**");
  assert.equal(projectReadComments(doc)[0].messages[0].body_format, "markdown");
  // A rich message's edits stay Markdown; explicit plain input stays literal.
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
  assert.equal(messageAt(doc, path).richText, "**literal**");
  assert.equal(commentMarkdown(messageAt(doc, path)), "**literal**");
});

test("a message in an old stored form reads as before and converts on its next edit", () => {
  const { doc: seeded, ids, path } = add(fixture(), "placeholder");
  // A plain message and an adapter-form rich message with its Markdown copy,
  // as builds before this one wrote them.
  const legacy = A.change(A.clone(seeded), (d) => {
    const thread = d.threads[ids.thread_id];
    thread.messages[ids.message_id] = {
      body: "**literal** | <b>text</b>",
      author: { ...messageAt(seeded, path).author },
      createdAt: "2026-11-01T00:00:00.000Z",
      deletedAt: null,
    };
  });
  assert.equal(projectComments(legacy)[0].messages[0].body, "**literal** | <b>text</b>");
  assert.doesNotThrow(() => validateCommentContent(messageAt(legacy, path)));
  const after = A.change(legacy, (d) =>
    applyComment(d, { action: "edit", ...ids, body: "**Rich now**" }, identity),
  );
  const message = messageAt(after, path);
  assert.equal(message.format, RICH_FORMAT);
  assert.equal(message.body, undefined, "the old copy goes with the conversion");
  assert.equal(message.bodyFormat, "plain", "an old plain message stays plain by default");
  assert.equal(projectComments(after)[0].messages[0].body, "**Rich now**");

  const tree = parseAgentMarkdown("Adapter **form**\n\nTwo");
  const adapter = A.change(A.clone(seeded), (d) => {
    const old = d.threads[ids.thread_id].messages[ids.message_id];
    old.body = "frozen copy";
    A.updateSpans(d, [...path, "richText"], adapterSpans(tree));
  });
  assert.equal(String(A.spans(messageAt(adapter, path), ["richText"])[0].value.type), "paragraph");
  assert.equal(projectReadComments(adapter)[0].messages[0].body, "Adapter **form**\n\nTwo");
  assert.equal(projectReadComments(adapter)[0].messages[0].body_format, "markdown");
});

test("the length limit counts text characters, not block markers", () => {
  // 16000 characters across 100 list items: 100 markers on top.
  const items = Array.from({ length: 100 }, () => "x".repeat(160));
  const spans = markdownCommentSpans(items.map((item) => `- ${item}`).join("\n"));
  assert.equal(spans.filter((span) => span.type === "block").length, 100);
  assert.doesNotThrow(() => validateCommentSpans(spans));
  const over = markdownCommentSpans(`${items.map((item) => `- ${item}`).join("\n")}x`);
  assert.throws(() => validateCommentSpans(over), /16000/);
  // The adapter form of a message has one more marker than the editor form;
  // either counts the same.
  const tree = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("y".repeat(16000))]),
  ]);
  assert.doesNotThrow(() => validateCommentSpans(adapterSpans(tree)));
  assert.doesNotThrow(() => validateCommentSpans(pageSpans(tree)));
});

test("an image-only comment is content; whitespace-only text is not", () => {
  const image = pageSpans(
    schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.node("image", {
          src: "https://example.org/i.png",
          alt: "",
          title: null,
          dark_src: null,
        }),
      ]),
    ]),
  );
  assert.doesNotThrow(() => validateCommentSpans(image));
  assert.throws(() => validateCommentSpans(plainCommentSpans("  \n ")), /16000/);
});

test("formatting-only comment changes are visible in both change-feed modes", () => {
  const { doc: before, path, ids } = add(fixture(), "Native text");
  const start = messageAt(before, path).richText.indexOf("Native");
  const after = A.change(before, (d) =>
    A.mark(d, [...path, "richText"], { start, end: start + 6, expand: "both" }, "strong", true),
  );
  assert.equal(JSON.stringify(before.threads), JSON.stringify(after.threads));
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

test("browser submission stores the editor's spans without a Markdown round trip", () => {
  const spans = markdownCommentSpans("**[Linked](https://example.com/)** text");
  // A peer's spans in the adapter's form are stored in the editor's form.
  const adapterDoc = A.change(fixture(), (d) =>
    applyComment(
      d,
      { action: "add", block_id: "one" },
      identity,
      adapterSpans(parseAgentMarkdown("**[Linked](https://example.com/)** text")),
    ),
  );
  const [adapterMessage] = Object.values(Object.values(adapterDoc.threads)[0].messages);
  assert.deepEqual(plain(A.spans(adapterMessage, ["richText"])), plain(spans));
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
  const message = saved.threads[ids.thread_id].messages[ids.message_id];
  assert.deepEqual(plain(A.spans(message, ["richText"])), plain(spans));
  assert.equal(message.body, undefined, "the spans are the message");
  assert.match(projectComments(saved)[0].messages[0].body, /example.com/);
});

test("one unreadable native comment preserves Page reads and reports frozen provenance", () => {
  const { doc: before, ids, path } = add(fixture(), "Original import");
  const heads = A.getHeads(before);
  const after = A.change(before, (d) => {
    const message = messageAt(d, path);
    message.richText = 7; // A malformed peer payload, never accepted by applyComment.
    message.body = "Original import"; // The Markdown copy an earlier build kept.
  });
  const bare = A.change(A.clone(before), (d) => {
    messageAt(d, path).richText = 7;
  });
  assert.equal(projectReadComments(bare)[0].messages[0].body, "");
  assert.equal(projectReadComments(bare)[0].messages[0].content_error, "rich_text_unavailable");
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

test("a plain comment with too many lines says so, and the source cap counts bytes", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  assert.throws(() => add(fixture(), lines, { body_format: "plain" }), (error) => {
    assert.equal(error.code, "comment_too_many_lines");
    assert.match(error.message, /too many lines for one comment/);
    return true;
  });
  // 22,000 three-byte characters: under 64 Ki characters, over 64 KiB.
  assert.throws(() => add(fixture(), "€".repeat(22000), { body_format: "plain" }), /64 KiB/);
  assert.throws(() => add(fixture(), "€".repeat(22000), { body_format: "plain" }), /bytes/);
});
