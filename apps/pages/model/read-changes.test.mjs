import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { projectReadChanges } from "./read-changes.mjs";
import { projectReadContent } from "./read-content.mjs";
import { setRichMarkdown, textPath } from "./richtext.mjs";
import { richFromSource } from "./richtext-test-support.mjs";
import { stampFeatures } from "./schema-features.mjs";
import { replaceMatch } from "./replace-match.mjs";
import { applyComment as applyCommentTo } from "./comments.mjs";
import { comment, newCommentsDoc } from "./comments-test-support.mjs";

const author = { principal: "user", displayName: "Collaborator", driver: "Browser" };
function page(markdown = "# Start\n\nFirst paragraph.\n\n## Later\n\nSecond paragraph.") {
  return A.change(
    A.from({ page_id: "changes-fixture", title: "Page title", blocks: {} }),
    (doc) => {
      doc.blocks.one = {
        id: "one",
        kind: "markdown",
        position: new A.RawString("a0"),
        markdown,
        metadata: {},
      };
      richFromSource(doc, "one");
      stampFeatures(doc, ["comments-doc"]);
    },
  );
}
function read(doc, since_heads, options = {}) {
  const heads = A.getHeads(doc),
    bytes = A.save(doc);
  const result = projectReadChanges(doc, { since_heads, ...options });
  assert.deepEqual(A.getHeads(doc), heads);
  assert.deepEqual(A.save(doc), bytes);
  return result;
}
/** The cursor at the nth top-level block marker, found by scanning the
 * stored spans. Every node in these fixtures opens with its own marker. */
function markerCursor(doc, n) {
  let at = 0,
    seen = 0;
  for (const span of A.spans(doc, textPath("one"))) {
    if (span.type === "block" && !span.value.isEmbed && !span.value.parents.length && seen++ === n)
      return A.getCursor(doc, textPath("one"), at);
    at += span.type === "text" ? span.value.length : 1;
  }
  throw Error(`No marker ${n}`);
}
const errorCode = (status, code) => (error) => error.status === status && error.code === code;

test("read and change feed agree on bounded nested image occurrences", () => {
  const before = page("Before");
  const src = `/api/pages/${crypto.randomUUID()}/assets/${"b".repeat(64)}`;
  const after = A.change(A.clone(before), (doc) =>
    setRichMarkdown(doc, "one", `> ![quote](${src})\n>\n> - ![nested](${src})`),
  );
  const outline = projectReadContent(after, {}).outline.find((entry) => entry.summary?.images);
  const delta = read(after, A.getHeads(before));
  const changed = delta.changes.find((entry) => entry.summary?.images);
  assert.deepEqual(changed.summary.images, outline.summary.images);
  assert.equal(changed.summary.images.length, 2);
});
/** Changes since a Page revision and a comments revision, each with its own
 * heads, as the Page host reads them. */
function readBoth(doc, comments, since_heads, since_comment_heads, options = {}) {
  const heads = A.getHeads(doc),
    commentHeads = A.getHeads(comments);
  const result = projectReadChanges(
    doc,
    { since_heads, ...(since_comment_heads && { since_comment_heads }), ...options },
    comments,
  );
  assert.deepEqual(A.getHeads(doc), heads);
  assert.deepEqual(A.getHeads(comments), commentHeads);
  return result;
}
/** Apply comment actions in order, in one change on `comments`. */
function commentChange(doc, comments, fn) {
  const results = [];
  const next = A.change(comments, (draft) =>
    fn((input, who = author) => {
      const value = applyCommentDraft(draft, doc, input, who);
      results.push(value);
      return value;
    }, draft),
  );
  return { comments: next, results };
}
const applyCommentDraft = (draft, page, input, who) =>
  applyCommentTo(draft, input, who, undefined, { page, role: "editor" });

test("an unchanged revision returns an empty net feed without author inference", () => {
  const doc = page(),
    heads = A.getHeads(doc);
  assert.deepEqual(read(doc, heads), {
    page_id: "changes-fixture",
    since_heads: heads,
    heads,
    title_changed: false,
    changes: [],
    comments: [],
    comments_mode: "summary",
    attribution: "unavailable",
  });
});

test("one native paragraph edit returns only its current Markdown and revision-bound address", () => {
  let doc = page();
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) =>
    replaceMatch(draft, "one", { match_text: "Second", replacement: "Updated 🌊" }),
  );
  const result = read(doc, before);
  assert.deepEqual(result.changes, [
    {
      block_id: "one",
      scope: "node",
      change: "updated",
      node_index: 3,
      node_id: markerCursor(doc, 3),
      type: "paragraph",
      heading_path: ["Start", "Later"],
      markdown: "Updated 🌊 paragraph.",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /text_object_id|cursor|richText|First paragraph/);
});

test("inserting an earlier native node does not report untouched shifted nodes as changes", () => {
  let doc = page();
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) => {
    A.splitBlock(draft, textPath("one"), 0, {
      type: new A.RawString("paragraph"),
      parents: [],
      attrs: {},
    });
    A.splice(draft, textPath("one"), 1, 0, "New opening.");
  });
  assert.deepEqual(read(doc, before).changes, [
    {
      block_id: "one",
      scope: "node",
      change: "inserted",
      node_index: 0,
      node_id: markerCursor(doc, 0),
      type: "paragraph",
      heading_path: [],
      markdown: "New opening.",
    },
  ]);
});

test("native deletion reports its old address without historical text", () => {
  let doc = page();
  const before = A.getHeads(doc);
  const deletedId = markerCursor(doc, 1);
  doc = A.change(doc, (draft) => {
    const path = textPath("one"),
      start = draft.blocks.one.richText.indexOf("First paragraph.") - 1;
    A.splice(draft, path, start, "First paragraph.".length + 1, "");
  });
  const result = read(doc, before);
  assert.deepEqual(result.changes, [
    {
      block_id: "one",
      scope: "node",
      change: "deleted",
      before_node_index: 1,
      node_id: deletedId,
      type: "paragraph",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /First paragraph/);
});

test("format-only updates preserve node identity and return the current formatting", () => {
  let doc = page();
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) => {
    const at = draft.blocks.one.richText.indexOf("First");
    A.mark(draft, textPath("one"), { start: at, end: at + 5, expand: "none" }, "strong", true);
  });
  const result = read(doc, before);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].change, "updated");
  assert.equal(result.changes[0].node_index, 1);
  assert.equal(result.changes[0].markdown, "**First** paragraph.");
});

test("heading paths use current titles when both a section and its prose changed", () => {
  let doc = page();
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) => {
    replaceMatch(draft, "one", { match_text: "Later", replacement: "Current section" });
    replaceMatch(draft, "one", { match_text: "Second", replacement: "Updated" });
  });
  const changes = read(doc, before).changes;
  assert.deepEqual(
    changes.map((c) => c.node_index),
    [2, 3],
  );
  assert.deepEqual(
    changes.map((c) => c.heading_path),
    [
      ["Start", "Current section"],
      ["Start", "Current section"],
    ],
  );
});

test("replaced native text objects do not make the historical path read the latest object", () => {
  let doc = page();
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) => {
    draft.blocks.one.richText = "";
    setRichMarkdown(draft, "one", "Replacement only.");
  });
  const result = read(doc, before);
  assert.equal(result.changes.filter((c) => c.change === "deleted").length, 4);
  assert.equal(result.changes.filter((c) => c.change === "inserted").length, 1);
  assert.equal(result.changes.at(-1).markdown, "Replacement only.");
});

test("a title-only change including an empty title leaves the body feed empty", () => {
  let doc = page();
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) => {
    draft.title = "";
  });
  const result = read(doc, before);
  assert.equal(result.title_changed, true);
  assert.equal(result.title, "");
  assert.deepEqual(result.changes, []);
});

test("block insert, move, metadata and deletion stay explicit without raw extension fields", () => {
  let doc = page();
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) => {
    draft.blocks.two = {
      id: "two",
      kind: "markdown",
      position: new A.RawString("a1"),
      markdown: "Added",
      metadata: {},
    };
    richFromSource(draft, "two");
    draft.blocks.one.position = new A.RawString("a2");
    draft.blocks.one.metadata.private = "never returned";
  });
  const result = read(doc, before);
  assert.ok(
    result.changes.some(
      (c) => c.block_id === "two" && c.scope === "block" && c.change === "inserted",
    ),
  );
  assert.ok(
    result.changes.some(
      (c) => c.block_id === "two" && c.scope === "node" && c.markdown === "Added",
    ),
  );
  assert.ok(result.changes.some((c) => c.block_id === "one" && c.change === "moved"));
  assert.ok(result.changes.some((c) => c.block_id === "one" && c.metadata_changed));
  assert.doesNotMatch(JSON.stringify(result), /never returned/);
  const next = A.getHeads(doc);
  doc = A.change(doc, (draft) => {
    delete draft.blocks.one;
  });
  assert.deepEqual(read(doc, next).changes, [
    { block_id: "one", scope: "block", change: "deleted" },
  ]);
});

test("lists and tables are whole top-level nodes while nearby prose stays out", () => {
  let doc = page("# Data\n\n- One\n- Two\n\n| A | B |\n|---|---|\n| x | y |\n\nOutside.");
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) => {
    replaceMatch(draft, "one", { match_text: "Two", replacement: "Three" });
    replaceMatch(draft, "one", { match_text: "y", replacement: "z" });
  });
  const changes = read(doc, before).changes;
  assert.deepEqual(
    changes.map((c) => [c.node_index, c.type, c.change]),
    [
      [1, "bullet-list", "updated"],
      [2, "table", "updated"],
    ],
  );
  assert.match(changes[0].markdown, /Three/);
  assert.match(changes[1].markdown, /z/);
  assert.doesNotMatch(JSON.stringify(changes), /Outside/);
});

test("concurrent independent edits both appear in one captured net feed", () => {
  let doc = page(),
    peer = A.clone(doc),
    before = A.getHeads(doc);
  doc = A.change(doc, (draft) =>
    replaceMatch(draft, "one", { match_text: "First", replacement: "Left" }),
  );
  peer = A.change(peer, (draft) =>
    replaceMatch(draft, "one", { match_text: "Second", replacement: "Right" }),
  );
  doc = A.merge(doc, peer);
  assert.deepEqual(
    read(doc, before).changes.map((c) => c.markdown),
    ["Left paragraph.", "Right paragraph."],
  );
});

test("edit then undo to the same visible state is not presented as an audit event", () => {
  let doc = page();
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) =>
    replaceMatch(draft, "one", { match_text: "First", replacement: "Changed" }),
  );
  doc = A.change(doc, (draft) =>
    replaceMatch(draft, "one", { match_text: "Changed", replacement: "First" }),
  );
  assert.deepEqual(read(doc, before).changes, []);
});

test("native changes ignore immutable Markdown import provenance", () => {
  let doc = page();
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) => {
    draft.blocks.one.markdown = "Irrelevant stale import";
  });
  assert.deepEqual(read(doc, before).changes, []);
});

test("unknown heads require resync instead of returning a root-to-current feed", () => {
  const doc = page();
  assert.throws(() => read(doc, ["0".repeat(64)]), errorCode(409, "resync_required"));
  for (const since_heads of [
    null,
    undefined,
    "heads",
    [],
    ["bad"],
    new Array(1),
    Array.from({ length: 129 }, (_, index) => index.toString(16).padStart(64, "0")),
    [A.getHeads(doc)[0], A.getHeads(doc)[0]],
  ])
    assert.throws(() => read(doc, since_heads), errorCode(400, "invalid_change_selector"));
});

test("an unprojectable baseline returns safe resync guidance after current content is repaired", () => {
  let doc = page();
  doc = A.change(doc, (draft) => {
    delete draft.blocks.one.richText;
  });
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) => {
    draft.blocks.one.richText = "";
    setRichMarkdown(draft, "one", "REPAIRED CURRENT CONTENT");
  });
  const bytes = A.save(doc),
    heads = A.getHeads(doc);
  assert.throws(
    () => read(doc, before, { comments: "none" }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "resync_required");
      assert.match(error.message, /current Page or outline/);
      assert.match(error.message, /No partial delta/);
      assert.doesNotMatch(error.message, /REPAIRED|richText|RangeError|_root|invalid path/);
      assert.equal(error.details, undefined);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.deepEqual(A.save(doc), bytes);
  assert.deepEqual(A.getHeads(doc), heads);
  assert.deepEqual(read(doc, heads).changes, []);
});

test("comment defaults return compact changes and all mode only changed current messages", () => {
  const doc = page();
  let { comments, result: ids } = comment(doc, newCommentsDoc(), {
    block_id: "one",
    body: "Old visible message",
  });
  const before = A.getHeads(doc),
    commentsBefore = A.getHeads(comments);
  let reply;
  ({ comments } = commentChange(doc, comments, (apply) => {
    reply = apply({ action: "reply", thread_id: ids.thread_id, body: "New reply" });
    apply({ action: "resolve", thread_id: ids.thread_id });
  }));
  // Comment writes never move the Page's heads.
  assert.deepEqual(A.getHeads(doc), before);
  const summary = readBoth(doc, comments, before, commentsBefore);
  assert.deepEqual(summary.comment_heads, A.getHeads(comments));
  assert.deepEqual(summary.changes, []);
  assert.equal(summary.comments.length, 1);
  assert.equal(summary.comments[0].state, "resolved");
  assert.equal(summary.comments[0].message_count, 2);
  assert.equal(summary.comments[0].messages, undefined);
  const all = readBoth(doc, comments, before, commentsBefore, { comments: "all" });
  assert.equal(all.comments[0].messages.length, 1);
  assert.equal(all.comments[0].messages[0].id, reply.message_id);
  assert.equal(all.comments[0].messages[0].body, "New reply");
  assert.doesNotMatch(JSON.stringify(all), /Old visible message/);
  assert.deepEqual(
    readBoth(doc, comments, before, commentsBefore, { comments: "none" }).comments,
    [],
  );
  // Without a comments baseline the delta is unknown: every current thread,
  // flagged as a snapshot, so an older client keeps seeing comments.
  const unknown = readBoth(doc, comments, before);
  assert.equal(unknown.comments_snapshot, true);
  assert.equal(unknown.comments.length, 1);
  assert.equal(unknown.comments[0].change, "snapshot");
  assert.equal(unknown.comments[0].thread_id, ids.thread_id);
  assert.equal(unknown.comments[0].messages, undefined, "summary mode carries no bodies");
  const unknownAll = readBoth(doc, comments, before, undefined, { comments: "all" });
  assert.equal(unknownAll.comments[0].messages.length, 2);
  assert.equal(
    readBoth(doc, comments, before, undefined, { comments: "none" }).comments_snapshot,
    undefined,
  );
  assert.throws(
    () => readBoth(doc, comments, before, ["0".repeat(64)]),
    errorCode(409, "resync_required"),
  );
});

test("comment tombstones and removed threads/messages never export old bodies or authors", () => {
  const doc = page();
  let one, two, three;
  let { comments } = commentChange(doc, newCommentsDoc(), (apply) => {
    one = apply(
      { block_id: "one", body: "SECRET TOMBSTONE" },
      { ...author, displayName: "SECRET AUTHOR" },
    );
    two = apply({ block_id: "one", body: "SECRET THREAD" });
    three = apply({ action: "reply", thread_id: one.thread_id, body: "SECRET REMOVED" });
  });
  const before = A.getHeads(doc),
    commentsBefore = A.getHeads(comments);
  ({ comments } = commentChange(doc, comments, (apply, draft) => {
    apply({ action: "delete_message", thread_id: one.thread_id, message_id: one.message_id });
    // Raw removals a peer could sync; the authority check refuses them, but
    // the projection must stay safe either way.
    delete draft.threads[one.thread_id].messages[three.message_id];
    delete draft.threads[two.thread_id];
  }));
  const result = readBoth(doc, comments, before, commentsBefore, { comments: "all" });
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.ok(result.comments.some((c) => c.thread_id === two.thread_id && c.change === "deleted"));
  const updated = result.comments.find((c) => c.thread_id === one.thread_id);
  assert.equal(updated.messages.length, 1);
  assert.equal(updated.messages[0].body, undefined);
  assert.equal(updated.messages[0].author, undefined);
  assert.deepEqual(updated.removed_message_ids, [three.message_id]);
});

test("moving text before a comment does not itself count as a comment mutation", () => {
  let doc = page();
  const { comments } = comment(doc, newCommentsDoc(), {
    block_id: "one",
    selected_text: "Second",
    body: "Discuss",
  });
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) =>
    replaceMatch(draft, "one", { match_text: "First", replacement: "Much longer first" }),
  );
  assert.deepEqual(readBoth(doc, comments, before, A.getHeads(comments)).comments, []);
});

test("byte budget errors return counts and recovery guidance, never a truncated success", () => {
  let doc = page();
  const before = A.getHeads(doc);
  doc = A.change(doc, (draft) => setRichMarkdown(draft, "one", "🌊".repeat(2000)));
  assert.throws(
    () => read(doc, before, { max_bytes: 4096 }),
    (error) => {
      assert.equal(error.code, "changes_budget_exceeded");
      assert.equal(error.status, 413);
      assert.equal(error.details.max_bytes, 4096);
      assert.ok(error.details.required_bytes > 4096);
      assert.ok(error.details.counts.changes > 0);
      assert.equal(error.details.changes, undefined);
      return true;
    },
  );
  assert.ok(read(doc, before, { max_bytes: 16384 }).changes.length);
});

test("selectors reject unsupported modes and unbounded arguments", () => {
  const doc = page(),
    heads = A.getHeads(doc);
  for (const args of [
    { comments: "open" },
    { comments: null },
    { max_bytes: 4095 },
    { max_bytes: 262145 },
    { max_bytes: 4.5 },
    { unexpected: true },
  ])
    assert.throws(() => read(doc, heads, args), errorCode(400, "invalid_change_selector"));
});
