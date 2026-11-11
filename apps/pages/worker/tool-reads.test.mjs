import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, projectPage } from "../model/page.mjs";
import { comment, newCommentsDoc } from "../model/comments-test-support.mjs";
import { readTool } from "./tool-reads.mjs";

const authority = {
  retry_token: "test-retry",
  retry_key_prefix: "test-prefix_",
  retry_until: "2026-11-01T00:00:00Z",
};
function fixture(t, markdown = "# First\n\nKeep this passage.\n\n# Second\n\nOther content.") {
  let doc = A.from(createPageData({ pageId: "read-fixture", title: "Read fixture" }));
  doc = A.change(doc, (d) => initializePage(d, markdown));
  const blockId = Object.keys(doc.blocks)[0];
  const { comments } = comment(
    doc,
    newCommentsDoc(),
    { action: "add", block_id: blockId, selected_text: "Keep", body: "Comment body" },
    { principal: "user:one", displayName: "One", driver: "Test" },
  );
  // Reads take the Page and its comments document together.
  commentsOf.set(doc, comments);
  t.after(() => A.free(doc));
  return { doc, blockId, comments };
}
const commentsOf = new WeakMap();
const read = (doc, args = {}, op = "read_page") =>
  readTool(doc, op, args, {
    issueAuthority: async () => authority,
    commentsDoc: commentsOf.get(doc),
  });

test("presence is opt-in, captured before async authority, and counted in the read budget", async (t) => {
  const { doc } = fixture(t);
  const heads = A.getHeads(doc);
  const events = [];
  const presence = { heads, observed_at: 123, participants: [], progress: [] };
  const result = await readTool(
    doc,
    "read_page",
    { include_content: false, include_presence: true },
    {
      commentsDoc: commentsOf.get(doc),
      getPresence(captured) {
        events.push("presence");
        assert.equal(captured, doc);
        return presence;
      },
      async issueAuthority() {
        events.push("authority");
        return authority;
      },
    },
  );
  assert.deepEqual(events, ["presence", "authority"]);
  assert.deepEqual(result.body.presence, presence);
  assert.deepEqual(result.body.heads, heads);
  assert.deepEqual(A.getHeads(doc), heads);
  const tooBig = await readTool(
    doc,
    "read_page",
    { include_content: false, include_presence: true, max_bytes: 4096 },
    {
      getPresence: () => ({ progress: [{ message: "x".repeat(10000) }] }),
      issueAuthority: async () => authority,
    },
  );
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.presence, undefined);
  assert.equal((await read(doc, { include_presence: "yes" })).status, 400);
  assert.equal((await read(doc, { include_presence: false })).body.presence, undefined);
});

test("unfiltered reads preserve the old shape; explicit body reads exclude comments and preserve heads", async (t) => {
  const { doc } = fixture(t);
  const before = A.getHeads(doc);
  const legacy = await read(doc, { page_id: doc.page_id });
  assert.equal(legacy.status, 200);
  // Additive fields only: the comments document's heads, and the stamp.
  assert.deepEqual(legacy.body, {
    ...projectPage(doc, commentsOf.get(doc)),
    heads: before,
    comment_heads: A.getHeads(commentsOf.get(doc)),
    schema_features: ["comments-doc"],
    ...authority,
  });
  assert.ok(legacy.body.comments[0].target.anchor.textObjectId);
  const body = await read(doc, { comments: "none" });
  assert.equal(body.status, 200);
  assert.deepEqual(body.body.comments, []);
  assert.equal(body.body.blocks[0].markdown, legacy.body.blocks[0].markdown);
  assert.deepEqual(body.body.heads, before);
  assert.deepEqual(body.body.schema_features, ["comments-doc"]);
  assert.deepEqual(A.getHeads(doc), before);
});

test("outline-only and selected reads keep retry authority and use compact comments", async (t) => {
  const { doc } = fixture(t);
  const outline = await read(doc, { include_content: false, outline_limit: 2 });
  assert.deepEqual(outline.body.blocks, []);
  assert.deepEqual(outline.body.comments, []);
  assert.equal(outline.body.outline.entries.length, 2);
  assert.equal(outline.body.outline.next_offset, 2);
  const next = await read(doc, {
    include_content: false,
    outline_offset: 2,
    outline_limit: 2,
    expected_heads: outline.body.heads,
  });
  assert.notDeepEqual(next.body.outline.entries, outline.body.outline.entries);
  const section = await read(doc, { section: "First" });
  assert.equal(section.body.blocks[0].partial, true);
  assert.match(section.body.blocks[0].markdown, /Keep this passage/);
  assert.doesNotMatch(section.body.blocks[0].markdown, /Other content/);
  assert.equal(section.body.comments_mode, "summary");
  assert.equal(section.body.comments[0].messages, undefined);
  assert.equal(section.body.retry_token, authority.retry_token);
  assert.doesNotMatch(JSON.stringify(section.body.comments), /relativePositionBase64|textObjectId/);
});

test("comment-only reads omit body and allow summaries without changing document heads", async (t) => {
  const { doc } = fixture(t);
  const result = await read(doc, { include_messages: false }, "list_page_comments");
  assert.equal(result.status, 200);
  assert.equal(result.body.blocks, undefined);
  assert.equal(result.body.comments[0].message_count, 1);
  assert.equal(result.body.comments[0].messages, undefined);
  assert.equal(result.body.comments[0].selectionContext.text, "Keep");
  assert.deepEqual(result.body.heads, A.getHeads(doc));
});

test("oversized content returns only an explicitly paginated outline and edit authority", async (t) => {
  const { doc } = fixture(t, "Keep\n\n" + "Large paragraph. ".repeat(3000));
  const result = await read(doc, { max_bytes: 4096, comments: "none" });
  assert.equal(result.status, 413);
  assert.equal(result.body.code, "read_budget_exceeded");
  assert.equal(result.body.blocks, undefined);
  assert.equal(result.body.comments, undefined);
  assert.ok(result.body.outline.entries.length);
  assert.equal(result.body.retry_token, authority.retry_token);
  assert.ok(new TextEncoder().encode(JSON.stringify(result.body)).length <= 4096);
  const narrowed = await read(doc, {
    node_range: { block_id: Object.keys(doc.blocks)[0], from: 0, to: 1 },
    expected_heads: result.body.heads,
    comments: "none",
    max_bytes: 4096,
  });
  assert.equal(narrowed.status, 200);
  assert.equal(narrowed.body.blocks[0].markdown, "Keep");
});

test("a large comment response can be narrowed to summaries", async (t) => {
  const { doc, blockId, comments } = fixture(t);
  const expanded = A.clone(doc);
  let more = comments;
  for (let i = 0; i < 6; i++)
    more = comment(expanded, more, {
      action: "add",
      block_id: blockId,
      body: "Long comment ".repeat(400),
    }).comments;
  commentsOf.set(expanded, more);
  t.after(() => A.free(expanded));
  const result = await read(expanded, { max_bytes: 4096 }, "list_page_comments");
  assert.equal(result.status, 413);
  assert.equal(result.body.comments, undefined);
  const summary = await read(
    expanded,
    { max_bytes: 8192, include_messages: false },
    "list_page_comments",
  );
  assert.equal(summary.status, 200);
  assert.equal(summary.body.comments.length, 7);
  assert.ok(summary.body.comments.every((x) => x.messages === undefined));
});

test("HTTP-equivalent input validation rejects unknown options and invalid budgets", async (t) => {
  const { doc } = fixture(t);
  for (const args of [
    { secret: true },
    { max_bytes: 3 },
    { max_bytes: 262145 },
    { max_bytes: 1.2 },
    { outline_limit: 0 },
    { outline_offset: -1 },
    { comments: "private" },
    null,
    [],
  ]) {
    const result = await read(doc, args);
    assert.equal(result.status, 400, JSON.stringify(args));
    assert.equal(result.body.code, "invalid_read_selector");
    assert.equal(result.body.blocks, undefined);
  }
});

test("node ranges and outline continuation require the exact observed revision", async (t) => {
  const { doc, blockId } = fixture(t);
  for (const args of [
    { node_range: { block_id: blockId, from: 0, to: 1 } },
    { include_content: false, outline_offset: 1 },
  ]) {
    assert.equal((await read(doc, args)).body.code, "invalid_read_selector");
    const stale = await read(doc, { ...args, expected_heads: ["a".repeat(64)] });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "read_revision_changed");
    assert.equal(stale.body.blocks, undefined);
    assert.ok(stale.body.outline.entries.length);
    assert.deepEqual(stale.body.heads, A.getHeads(doc));
  }
});

test("legacy reads above the opt-in budget keep their complete response", async (t) => {
  const { doc } = fixture(t, "Keep\n\n" + "Legacy content. ".repeat(10000));
  const legacy = await read(doc, { page_id: doc.page_id });
  assert.equal(legacy.status, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(legacy.body)) > 128 * 1024);
  assert.equal(legacy.body.blocks[0].markdown, projectPage(doc).blocks[0].markdown);
  assert.equal((await read(doc, { comments: "none" })).body.code, "read_budget_exceeded");
});

test("a small node read pages down its outline before rejecting fitting content", async (t) => {
  const { doc, blockId } = fixture(
    t,
    "Keep\n\n" +
      Array.from(
        { length: 150 },
        (_, i) => "Paragraph " + i + " " + "Complete content. ".repeat(45),
      ).join("\n\n"),
  );
  const result = await read(doc, {
    node_range: { block_id: blockId, from: 75, to: 76 },
    expected_heads: A.getHeads(doc),
    comments: "none",
    max_bytes: 4096,
  });
  assert.equal(result.status, 200);
  assert.match(result.body.blocks[0].markdown, /Paragraph 74/);
  assert.ok(Buffer.byteLength(JSON.stringify(result.body)) + 512 <= 4096);
  assert.ok(result.body.outline.entries.length > 0 && result.body.outline.entries.length < 100);
  assert.equal(result.body.outline.next_offset, result.body.outline.entries.length);
  const next = await read(doc, {
    include_content: false,
    outline_offset: result.body.outline.next_offset,
    expected_heads: result.body.heads,
    max_bytes: 4096,
  });
  assert.equal(next.status, 200);
  assert.equal(next.body.outline.entries[0].node_index, result.body.outline.next_offset);
});

test("ambiguous sections expose a flat candidate list with revision authority", async (t) => {
  const { doc } = fixture(t, "# Repeated\n\nKeep\n\n# Repeated\n\nOther");
  const result = await read(doc, { section: "Repeated" });
  assert.equal(result.status, 409);
  assert.equal(result.body.total, 2);
  assert.equal(result.body.candidates.length, 2);
  assert.deepEqual(A.getHeads(doc), result.body.heads);
  assert.equal(result.body.retry_token, authority.retry_token);
});
