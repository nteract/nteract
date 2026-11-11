import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { fixture, trashArgs } from "./trash-fixture.mjs";
import { proposeAccessUpdate } from "./access.mjs";

test("guarded writes refuse a stale or malformed revision with a code, not just a message", async (t) => {
  const f = await fixture(t);
  // A revision this host named before the Page moved on.
  const stale = await f.revision();
  f.edit("Moved on");
  for (const [operation, args] of [
    ["edit_page", { operations: [{ op: "set_title", title: "Changed" }] }],
    [
      "edit_page",
      {
        operations: [
          { op: "replace_match", node_id: f.block, match_text: "Friday", replacement: "Monday" },
        ],
      },
    ],
  ]) {
    const refused = await f.tool("owner", operation, {
      ...args,
      revision: stale,
      nonce: `stale-${operation}`,
    });
    assert.equal(refused.status, 409, operation);
    // The refusal names both live revisions, so the next attempt needs no
    // read_page round trip.
    assert.deepEqual(refused.body, {
      error: "Page changed; read_page again before editing",
      code: "stale_revision",
      current_revision: await f.revision(),
      comment_revision: await f.commentRevision(),
    });
    assert.deepEqual(await f.headsOf(refused.body.current_revision), f.heads());
    const missing = await f.tool("owner", operation, {
      ...args,
      nonce: `missing-${operation}`,
    });
    assert.equal(missing.status, 400, operation);
    assert.equal(missing.body.code, "invalid_revision", operation);
    const malformed = await f.tool("owner", operation, {
      ...args,
      revision: f.heads(),
      nonce: `malformed-${operation}`,
    });
    assert.equal(malformed.status, 400, operation);
    assert.equal(malformed.body.code, "invalid_revision", operation);
  }
  const badKey = await f.tool("owner", "edit_page", {
    revision: await f.revision(),
    nonce: "short",
    operations: [{ op: "set_title", title: "Changed" }],
  });
  assert.equal(badKey.status, 400);
  assert.equal(badKey.body.code, "invalid_nonce");

  const trash = await f.catalogCall("owner", "delete_page", {
    ...trashArgs(f, "stale-trash"),
    revision: stale,
  });
  assert.equal(trash.status, 409);
  assert.equal(trash.body.code, "stale_revision");
  assert.equal(trash.body.current_revision, await f.revision());
  assert.equal(trash.body.comment_revision, await f.commentRevision());
});

test("an edit batch that cannot apply names the selector, and nothing is written", async (t) => {
  const f = await fixture(t);
  const heads = f.heads();
  for (const [match_text, count] of [
    ["Tuesday", 0],
    ["i", 2],
  ]) {
    const refused = await f.tool("owner", "edit_page", {
      revision: await f.revision(heads),
      nonce: `selector-${count}-matches`,
      operations: [{ op: "replace_match", node_id: f.block, match_text, replacement: "x" }],
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "invalid_edit_selector");
    assert.match(refused.body.error, new RegExp(`found ${count} matches`));
  }
  const unknownBlock = await f.tool("owner", "edit_page", {
    revision: await f.revision(heads),
    nonce: "selector-unknown-block",
    operations: [{ op: "delete_block", node_id: "no-such-block" }],
  });
  assert.equal(unknownBlock.status, 400);
  assert.equal(unknownBlock.body.code, "invalid_edit_selector");
  // A well-formed id the Page never minted names nothing.
  const unknownId = await f.tool("owner", "edit_page", {
    revision: await f.revision(heads),
    nonce: "selector-unknown-id",
    operations: [{ op: "delete_block", node_id: "999999@abcdef" }],
  });
  assert.equal(unknownId.status, 400);
  assert.equal(unknownId.body.code, "node_not_found", JSON.stringify(unknownId.body));
  const comment = await f.tool("owner", "manage_page_comment", {
    revision: await f.revision(heads),
    nonce: "comment-unknown-thread",
    action: "reply",
    thread_id: "no-such-thread",
    body: "Hello",
  });
  assert.equal(comment.status, 400);
  assert.equal(comment.body.code, "invalid_comment_selector");
  assert.deepEqual(f.heads(), heads);
  // Past the diff budget with nothing unique to split on, replace_match refuses
  // with its own code rather than detach anchors on words it would keep.
  const tooLarge = await f.tool("owner", "edit_page", {
    revision: await f.revision(),
    nonce: "selector-too-large",
    operations: [
      { op: "replace_block_markdown", node_id: f.block, markdown: "w ".repeat(3000).trim() },
    ],
  });
  assert.equal(tooLarge.status, 200, JSON.stringify(tooLarge.body));
  const refusedLarge = await f.tool("owner", "edit_page", {
    revision: tooLarge.body.revision,
    nonce: "selector-too-large-replace",
    operations: [
      {
        op: "replace_match",
        node_id: f.block,
        match_text: "w ".repeat(3000).trim(),
        replacement: "v ".repeat(3000).trim(),
      },
    ],
  });
  assert.equal(refusedLarge.status, 400);
  assert.equal(refusedLarge.body.code, "replace_match_too_large");
  assert.deepEqual(f.heads(), await f.headsOf(tooLarge.body.revision), "nothing was written");
});

test("the host refuses every write to a Page stamped with a feature it lacks, and reads report the stamp", async (t) => {
  const plain = await fixture(t);
  // A new Page carries only the comments-doc stamp.
  const current = await plain.tool("owner", "read_page", { comments: "none" });
  assert.deepEqual(current.body.schema_features, ["comments-doc"]);
  const legacy = await plain.tool("owner", "read_page");
  assert.deepEqual(legacy.body.schema_features, ["comments-doc"]);

  const doc = A.change(A.load(A.save(plain.doc())), (draft) => {
    draft.schema = { features: ["comments-doc", "future-feature"] };
  });
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(doc) });
  A.free(doc);
  const read = await f.tool("owner", "read_page", { comments: "none" });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.schema_features, ["comments-doc", "future-feature"]);
  const heads = f.heads();
  for (const [operation, args] of [
    ["edit_page", { operations: [{ op: "set_title", title: "Changed" }] }],
    [
      "edit_page",
      {
        operations: [
          { op: "replace_match", node_id: f.block, match_text: "Friday", replacement: "Monday" },
        ],
      },
    ],
    [
      "edit_page",
      {
        conflict_scope: "target",
        operations: [
          { op: "format_match", node_id: f.block, match_text: "Friday", add: { strong: true } },
        ],
      },
    ],
    ["manage_page_comment", { action: "add", node_id: f.block, body: "Hello" }],
  ]) {
    const refused = await f.tool("owner", operation, {
      ...args,
      revision: await f.revision(heads),
      nonce: `schema-${operation}-${args.conflict_scope ?? "page"}`,
    });
    assert.equal(refused.status, 409, operation);
    assert.equal(refused.body.code, "unsupported_schema_feature", operation);
    assert.deepEqual(refused.body.unsupported_features, ["future-feature"], operation);
    assert.match(refused.body.error, /future-feature/);
  }
  assert.deepEqual(f.heads(), heads, "nothing is written");
});

test("a receipt for edits the native gate refused answers schema_unsupported at once", async (t) => {
  const plain = await fixture(t);
  const doc = A.change(A.load(A.save(plain.doc())), (draft) => {
    draft.schema = { features: ["future-feature"] };
  });
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(doc) });
  A.free(doc);
  const missing = ["e".repeat(64)];
  for (const body of [{ heads: missing }, { heads: missing, schema_features: ["other"] }]) {
    const refused = await f.pageCall("owner", "/api/saved", body);
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, {
      error: "This Page uses features this version doesn't support. Reload to update.",
      code: "schema_unsupported",
    });
  }
  const malformed = await f.pageCall("owner", "/api/saved", {
    heads: missing,
    schema_features: ["Not An Id"],
  });
  assert.equal(malformed.status, 400);
});

test("a thread batch names unknown threads, refuses readers, and applies for editors", async (t) => {
  const f = await fixture(t);
  const [threadId] = Object.keys(f.commentsDoc().threads);
  const heads = f.heads();
  const unknown = await f.tool("owner", "manage_page_comment", {
    nonce: "batch-unknown-thread",
    action: "resolve",
    thread_ids: [threadId, "no-such-thread"],
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, "invalid_comment_selector");
  assert.deepEqual(unknown.body.not_found_thread_ids, ["no-such-thread"]);
  const shape = await f.tool("owner", "manage_page_comment", {
    nonce: "batch-both-fields",
    action: "resolve",
    thread_id: threadId,
    thread_ids: [threadId],
  });
  assert.equal(shape.status, 400);
  assert.equal(shape.body.code, "invalid_comment_selector");
  assert.equal(shape.body.not_found_thread_ids, undefined);

  // A viewer may read the thread but not change its status, alone or in a batch.
  const reader = "user:anaconda-fixture:stranger-user";
  const owner = { principal: f.owner, canWrite: true, expiresAt: Date.now() + 60_000 };
  f.setPage(
    f.build({
      ...f.page.metadata,
      acl: proposeAccessUpdate(f.page.metadata, owner, {
        principal: reader,
        role: "viewer",
        expected_revision: f.page.metadata.acl.revision,
      }).acl,
    }),
  );
  assert.equal((await f.tool("stranger", "list_page_comments")).status, 200);
  for (const args of [{ thread_id: threadId }, { thread_ids: [threadId] }]) {
    const denied = await f.tool("stranger", "manage_page_comment", {
      nonce: `batch-reader-${Object.keys(args)[0]}`,
      action: "resolve",
      ...args,
    });
    assert.equal(denied.status, 403, Object.keys(args)[0]);
    assert.equal(denied.body.code, undefined, "uncoded 403 becomes MCP access_denied");
  }
  assert.deepEqual(f.heads(), heads, "nothing is written");

  // An editor resolves a thread someone else opened, in one batch and one receipt.
  const resolved = await f.tool("member", "manage_page_comment", {
    nonce: "batch-editor-resolve",
    action: "resolve",
    thread_ids: [threadId],
  });
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.body.result, {
    threads: [{ thread_id: threadId, outcome: "resolved" }],
  });
  // The Page is untouched: its heads hold, and the receipt names the
  // comments document's new revision.
  assert.deepEqual(await f.headsOf(resolved.body.revision), heads);
  assert.deepEqual(f.heads(), heads);
  assert.deepEqual(await f.commentHeadsOf(resolved.body.comment_revision), f.commentHeads());
  assert.equal(f.commentsDoc().threads[threadId].status.value, "resolved");
});

test("rich edits go through the host: set_node, all and replacement_markdown, with codes on refusal", async (t) => {
  const f = await fixture(t);
  const edit = async (key, operations, heads = f.heads()) =>
    f.tool("owner", "edit_page", { revision: await f.revision(heads), nonce: key, operations });
  const wrongNode = await edit("rich-wrong-node", [
    { op: "set_node", node_id: f.block, match_text: "Friday", attrs: { checked: true } },
  ]);
  assert.equal(wrongNode.status, 400);
  assert.equal(wrongNode.body.code, "invalid_edit_selector");
  assert.match(
    wrongNode.body.error,
    /checked applies to task list items; match_text is in a paragraph/,
  );
  const math = await edit("rich-math", [
    { op: "replace_match", node_id: f.block, match_text: "Friday", replacement_markdown: "$x$" },
  ]);
  assert.equal(math.status, 400);
  assert.equal(math.body.code, "unsupported_markdown");
  const applied = await edit("rich-applied", [
    {
      op: "set_node",
      node_id: f.block,
      match_text: "We ship",
      type: "heading",
      attrs: { level: 2 },
    },
    {
      op: "replace_match",
      node_id: f.block,
      match_text: "Friday",
      replacement_markdown: "**Monday**",
    },
    {
      op: "format_match",
      node_id: f.block,
      match_text: "e",
      all: true,
      add: { highlight: "blue" },
    },
  ]);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(
    applied.body.result.edits.map((edit) => [edit.op, edit.matched]),
    [
      ["set_node", 1],
      ["replace_match", 1],
      ["format_match", 1],
    ],
  );
  const read = await f.tool("owner", "read_page", { page_id: f.pageId, comments: "none" });
  assert.equal(
    read.body.blocks[0].markdown,
    '## W<mark data-color="blue">e</mark> ship on **Monday**.',
  );
});

test("target-scope set_node goes through the host from older heads", async (t) => {
  const f = await fixture(t);
  const base = f.heads();
  // A peer edits elsewhere first.
  const peer = await f.tool("owner", "edit_page", {
    revision: await f.revision(base),
    nonce: "target-peer",
    operations: [
      { op: "replace_match", node_id: f.block, match_text: "Friday", replacement: "Monday" },
    ],
  });
  assert.equal(peer.status, 200, JSON.stringify(peer.body));
  const heading = await f.tool("owner", "edit_page", {
    revision: await f.revision(base),
    conflict_scope: "target",
    nonce: "target-set-node",
    operations: [
      {
        op: "set_node",
        node_id: f.block,
        match_text: "We ship",
        type: "heading",
        attrs: { level: 2 },
      },
    ],
  });
  assert.equal(heading.status, 200, JSON.stringify(heading.body));
  assert.deepEqual(heading.body.result.edits, [{ op: "set_node", node_id: f.block, matched: 1 }]);
  const read = await f.tool("owner", "read_page", { page_id: f.pageId, comments: "none" });
  assert.equal(read.body.blocks[0].markdown, "## We ship on Monday.");
  // The same node changed since base: a conflict, not a silent overwrite.
  const stale = await f.tool("owner", "edit_page", {
    revision: await f.revision(base),
    conflict_scope: "target",
    nonce: "target-set-node-stale",
    operations: [
      {
        op: "set_node",
        node_id: f.block,
        match_text: "We ship",
        type: "heading",
        attrs: { level: 3 },
      },
    ],
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, "edit_conflict");
});

test("a Page holding a node this build doesn't know reads, and refuses a Markdown rewrite of that block", async (t) => {
  const plain = await fixture(t);
  const path = ["blocks", plain.blockId, "richText"];
  const page = A.change(A.load(A.save(plain.doc())), (draft) => {
    const at = draft.blocks[plain.blockId].richText.indexOf("Friday");
    A.splitBlock(draft, path, at, {
      type: new A.ImmutableString("future-chart"),
      parents: [],
      attrs: { title: new A.ImmutableString("Usage") },
      isEmbed: false,
    });
  });
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(page) });
  const read = await f.tool("owner", "read_page", { page_id: f.pageId, comments: "none" });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.match(read.body.blocks[0].markdown, /\\\[Unsupported node: future-chart\\\]/);
  const rewrite = await f.tool("owner", "edit_page", {
    revision: await f.revision(),
    nonce: "unknown-rewrite",
    operations: [{ op: "replace_block_markdown", node_id: f.block, markdown: "We ship." }],
  });
  assert.equal(rewrite.body.code, "markdownless_node", JSON.stringify(rewrite.body));
  assert.equal(rewrite.status, 400);
});

test("an edit to a node this build can't read answers 409 in both scopes; its readable neighbors stay editable", async (t) => {
  const plain = await fixture(t);
  const path = ["blocks", plain.blockId, "richText"];
  // Text after a node this build doesn't know is that node's own text: the
  // block reads only in part. "We ship on " stays in a paragraph it reads.
  const page = A.change(A.load(A.save(plain.doc())), (draft) => {
    const at = draft.blocks[plain.blockId].richText.indexOf("Friday");
    A.splitBlock(draft, path, at, {
      type: new A.ImmutableString("future-chart"),
      parents: [],
      attrs: {},
      isEmbed: false,
    });
  });
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(page) });
  for (const [scope, extra] of [
    ["page", {}],
    ["target", { conflict_scope: "target" }],
  ])
    for (const op of [
      { op: "replace_match", match_text: "Friday", replacement: "Monday" },
      { op: "format_match", match_text: "Friday", add: { strong: true } },
      { op: "set_node", match_text: "Friday", type: "heading", attrs: { level: 2 } },
    ]) {
      const refused = await f.tool("owner", "edit_page", {
        revision: await f.revision(),
        nonce: `newer-${scope}-${op.op}`,
        ...extra,
        operations: [{ ...op, node_id: f.block }],
      });
      assert.equal(refused.status, 409, `${scope} ${op.op}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.code, "newer_content", `${scope} ${op.op}`);
      const allowed = await f.tool("owner", "edit_page", {
        revision: await f.revision(),
        nonce: `readable-${scope}-${op.op}`,
        ...extra,
        operations: [
          {
            ...op,
            node_id: f.block,
            ...(op.op === "replace_match"
              ? scope === "page"
                ? { match_text: "ship", replacement: "sail" }
                : { match_text: "sail", replacement: "ship" }
              : { match_text: "We" }),
          },
        ],
      });
      assert.equal(allowed.status, 200, `${scope} ${op.op}: ${JSON.stringify(allowed.body)}`);
    }
  // Other refusals through the same path keep their status.
  const missing = await f.tool("owner", "edit_page", {
    revision: await f.revision(),
    nonce: "newer-missing-match",
    operations: [
      { op: "replace_match", node_id: crypto.randomUUID(), match_text: "We", replacement: "x" },
    ],
  });
  assert.equal(missing.status, 400, JSON.stringify(missing.body));
  assert.equal(missing.body.code, "invalid_edit_selector");
});

test("set_node {type, attrs} goes through the host, and read_page reports the same names", async (t) => {
  const f = await fixture(t);
  const edit = await f.tool("owner", "edit_page", {
    revision: await f.revision(),
    nonce: "typed-set-node",
    operations: [
      {
        op: "set_node",
        node_id: f.block,
        match_text: "We ship",
        type: "heading",
        attrs: { level: 3 },
      },
    ],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const read = await f.tool("owner", "read_page", { page_id: f.pageId, comments: "none" });
  const heading = read.body.outline.entries.find((entry) => entry.type === "heading");
  assert.deepEqual(heading.attrs, { level: 3 });
  const wrong = await f.tool("owner", "edit_page", {
    revision: await f.revision(),
    nonce: "typed-set-node-wrong",
    operations: [
      { op: "set_node", node_id: f.block, match_text: "We ship", attrs: { checked: true } },
    ],
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "invalid_edit_selector");
  assert.match(wrong.body.error, /checked applies to task list items; match_text is in a heading/);
  // A top-level field is refused with the typed field to use, in both scopes.
  for (const conflict_scope of ["page", "target"]) {
    const flat = await f.tool("owner", "edit_page", {
      revision: await f.revision(),
      conflict_scope,
      nonce: `flat-set-node-${conflict_scope}`,
      operations: [{ op: "set_node", node_id: f.block, match_text: "We ship", heading_level: 2 }],
    });
    assert.equal(flat.status, 400, conflict_scope);
    assert.equal(flat.body.code, "invalid_edit_selector", conflict_scope);
    assert.match(
      flat.body.error,
      /not a top-level heading_level; use type "heading" with attrs\.level/,
    );
  }
});

test("delete_node goes through the host by the outline's node_id, and a gone id is node_not_found", async (t) => {
  const plain = await fixture(t);
  const path = ["blocks", plain.blockId, "richText"];
  // A future-chart node: no text, so delete_node is the only way to reach it.
  const page = A.change(A.load(A.save(plain.doc())), (draft) => {
    const at = draft.blocks[plain.blockId].richText.indexOf("Friday");
    A.splitBlock(draft, path, at, {
      type: new A.ImmutableString("future-chart"),
      parents: [],
      attrs: {},
      isEmbed: false,
    });
  });
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(page) });
  const read = await f.tool("owner", "read_page", { page_id: f.pageId, comments: "none" });
  const chart = read.body.outline.entries.find((entry) => entry.type === "unknown");
  assert.equal(typeof chart.node_id, "string", JSON.stringify(read.body.outline));
  const op = { op: "delete_node", node_id: chart.node_id };
  const deleted = await f.tool("owner", "edit_page", {
    revision: await f.revision(),
    nonce: "delete-node",
    operations: [op],
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body.result.edits, [{ ...op, block: f.block, type: "unknown" }]);
  const after = await f.tool("owner", "read_page", { page_id: f.pageId, comments: "none" });
  assert.doesNotMatch(after.body.blocks[0].markdown, /Unsupported node/);
  const again = await f.tool("owner", "edit_page", {
    revision: await f.revision(),
    nonce: "delete-node-again",
    operations: [op],
  });
  assert.equal(again.status, 400);
  assert.equal(again.body.code, "node_not_found", JSON.stringify(again.body));
});

test("delete_node that would join two lists is refused with nodes_would_join", async (t) => {
  const f = await fixture(t);
  const edit = async (operations, key) =>
    f.tool("owner", "edit_page", { revision: await f.revision(), nonce: key, operations });
  const written = await edit(
    [{ op: "replace_block_markdown", node_id: f.block, markdown: "Intro\n\n- a\n\n---\n\n- b" }],
    "join-setup",
  );
  assert.equal(written.status, 200, JSON.stringify(written.body));
  const read = await f.tool("owner", "read_page", { page_id: f.pageId, comments: "none" });
  const rule = read.body.outline.entries.find((entry) => /horizontal/.test(entry.type));
  const refused = await edit([{ op: "delete_node", node_id: rule.node_id }], "join-refused");
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "nodes_would_join", JSON.stringify(refused.body));
});
