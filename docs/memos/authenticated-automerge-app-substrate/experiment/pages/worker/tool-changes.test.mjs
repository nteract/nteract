import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, applyPageOperation } from "../model/page.mjs";
import { readChangesTool } from "./tool-changes.mjs";

const authority = { retry_token: "token", retry_key_prefix: "prefix_", retry_until: "later" };
const read = (doc, args, issueAuthority = async () => authority) =>
  readChangesTool(doc, args, { issueAuthority });
function fixture(t) {
  let doc = A.from(createPageData({ pageId: "changes-test", title: "Changes" }));
  doc = A.change(doc, (d) => initializePage(d, "# First\n\nKeep this.\n\n# Second\n\nEdit this."));
  const base = A.getHeads(doc),
    id = Object.keys(doc.blocks)[0];
  doc = A.change(doc, (d) =>
    applyPageOperation(d, {
      operation: "patch_page",
      arguments: {
        operations: [
          {
            op: "replace_match",
            block_id: id,
            match_text: "Edit this.",
            replacement: "Changed passage.",
          },
        ],
      },
    }),
  );
  t.after(() => A.free(doc));
  return { doc, base, id };
}

test("change reads capture delta and heads before async retry-authority issuance", async (t) => {
  const f = fixture(t),
    heads = A.getHeads(f.doc);
  let newer;
  const result = await read(f.doc, { since_heads: f.base }, async () => {
    newer = A.change(A.clone(f.doc), (d) => {
      d.title = "Later title";
    });
    return authority;
  });
  t.after(() => A.free(newer));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.heads, heads);
  assert.equal(result.body.title_changed, false);
  assert.equal(result.body.retry_token, authority.retry_token);
  assert.equal(result.body.changes.length, 1);
  assert.equal(result.body.changes[0].markdown, "Changed passage.");
  assert.equal(result.body.changes[0].node_index, 3);
  assert.equal(result.body.attribution, "unavailable");
  assert.equal((await read(f.doc, { since_heads: heads })).body.changes.length, 0);
});

test("invalid/unknown history and unknown options never masquerade as an empty change feed", async (t) => {
  const { doc, base } = fixture(t);
  for (const args of [
    {},
    { since_heads: [] },
    { since_heads: ["bad"] },
    { since_heads: base, mystery: true },
    { since_heads: base, max_bytes: 4095 },
  ]) {
    const result = await read(doc, args);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "invalid_change_selector");
    assert.equal(result.body.changes, undefined);
  }
  const unknown = await read(doc, { since_heads: ["f".repeat(64)] });
  assert.equal(unknown.status, 409);
  assert.equal(unknown.body.code, "resync_required");
  assert.equal(unknown.body.changes, undefined);
});

test("the complete change envelope is bounded including retry authority and URL reserve", async (t) => {
  const { doc, base } = fixture(t);
  const result = await read(doc, { since_heads: base, max_bytes: 4096 }, async () => ({
    ...authority,
    retry_token: "x".repeat(3500),
  }));
  assert.equal(result.status, 413);
  assert.equal(result.body.changes, undefined);
  assert.ok(new TextEncoder().encode(JSON.stringify(result.body)).byteLength + 512 <= 4096);
  const oversized = A.change(A.clone(doc), (d) =>
    applyPageOperation(d, {
      operation: "edit_page",
      arguments: { operations: [{ op: "insert_markdown", markdown: "large ".repeat(3000) }] },
    }),
  );
  t.after(() => A.free(oversized));
  const rejected = await read(oversized, { since_heads: base, max_bytes: 4096 });
  assert.equal(rejected.status, 413);
  assert.equal(rejected.body.code, "changes_budget_exceeded");
  assert.equal(rejected.body.changes, undefined);
  assert.ok(JSON.stringify(rejected.body).length < 4096);
});
