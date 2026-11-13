import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createPageData, initializePage, applyPageOperation } from "../model/page.mjs";
import { readChangesTool } from "./tool-changes.mjs";
import { blockAddress, nodeAddresses } from "../model/addresses.mjs";
import { revisionTable } from "./revisions-fixture.mjs";

const read = (f, args, revisions = f.revisions, doc = f.doc) =>
  readChangesTool(doc, args, { revisions });
async function fixture(t) {
  const revisions = revisionTable();
  let doc = A.from(createPageData({ pageId: "changes-test", title: "Changes" }));
  doc = A.change(doc, (d) => initializePage(d, "# First\n\nKeep this.\n\n# Second\n\nEdit this."));
  const base = await revisions.handle("page", A.getHeads(doc)),
    id = Object.keys(doc.blocks)[0];
  doc = A.change(doc, (d) =>
    applyPageOperation(d, {
      operation: "edit_page",
      arguments: {
        operations: [
          {
            op: "replace_match",
            node_id: blockAddress(d, id),
            match_text: "Edit this.",
            replacement: "Changed passage.",
          },
        ],
      },
    }),
  );
  t.after(() => A.free(doc));
  return { doc, base, id, revisions };
}

test("change reads capture delta and heads before the revision is named", async (t) => {
  const f = await fixture(t),
    heads = A.getHeads(f.doc);
  let newer;
  const result = await read(
    f,
    { since_revision: f.base },
    {
      ...f.revisions,
      async handles(requests) {
        newer ??= A.change(A.clone(f.doc), (d) => {
          d.title = "Later title";
        });
        return f.revisions.handles(requests);
      },
    },
  );
  t.after(() => A.free(newer));
  assert.equal(result.status, 200);
  assert.deepEqual(await f.revisions.heads("page", result.body.revision), heads);
  assert.equal(result.body.since_revision, f.base);
  assert.equal(result.body.title_changed, false);
  assert.equal(result.body.retry_token, undefined);
  assert.equal(result.body.changes.length, 1);
  assert.equal(result.body.changes[0].markdown, "Changed passage.");
  // The fourth node of the block: the paragraph under "# Second".
  const [change] = result.body.changes;
  assert.ok(nodeAddresses(f.doc, f.id)[3]);
  assert.equal(change.node_id, nodeAddresses(f.doc, f.id)[3]);
  assert.equal(change.block, blockAddress(f.doc, f.id));
  assert.equal(change.node_index, undefined);
  assert.equal(result.body.attribution, "unavailable");
  assert.doesNotMatch(JSON.stringify(result.body), /[a-f0-9]{64}/);
  assert.equal((await read(f, { since_revision: result.body.revision })).body.changes.length, 0);
});

test("invalid/unknown history and unknown options never masquerade as an empty change feed", async (t) => {
  const f = await fixture(t);
  for (const args of [
    {},
    { since_revision: f.base, mystery: true },
    { since_revision: f.base, max_bytes: 4095 },
    { since_heads: [] },
  ]) {
    const result = await read(f, args);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "invalid_change_selector");
    assert.equal(result.body.changes, undefined);
  }
  for (const since_revision of ["", "bad", "c1", ["r1"]])
    await assert.rejects(read(f, { since_revision }), { code: "invalid_revision" });
  await assert.rejects(read(f, { since_revision: f.base, since_comment_revision: "r1" }), {
    code: "invalid_revision",
  });
  const unknown = await read(f, { since_revision: "r999" });
  assert.equal(unknown.status, 409);
  assert.equal(unknown.body.code, "resync_required");
  assert.equal(unknown.body.changes, undefined);
  assert.match(unknown.body.revision, /^r\d+$/);
});

test("the complete change envelope is bounded including revisions and URL reserve", async (t) => {
  const f = await fixture(t);
  const oversized = A.change(A.clone(f.doc), (d) =>
    applyPageOperation(d, {
      operation: "edit_page",
      arguments: { operations: [{ op: "insert_markdown", markdown: "large ".repeat(3000) }] },
    }),
  );
  t.after(() => A.free(oversized));
  const rejected = await read(
    f,
    { since_revision: f.base, max_bytes: 4096 },
    f.revisions,
    oversized,
  );
  assert.equal(rejected.status, 413);
  assert.equal(rejected.body.code, "changes_budget_exceeded");
  assert.equal(rejected.body.changes, undefined);
  assert.match(rejected.body.revision, /^r\d+$/);
  assert.ok(new TextEncoder().encode(JSON.stringify(rejected.body)).byteLength + 512 <= 4096);
  assert.equal(
    rejected.body.error,
    "Changes exceed max_bytes (4096); no partial delta was returned. Raise it, up to 262144, or use comments:none, or read_page with section or node_ids for a new baseline.",
  );
  // At the largest budget, raising it is no longer advice.
  const huge = A.change(A.clone(f.doc), (d) =>
    applyPageOperation(d, {
      operation: "edit_page",
      arguments: { operations: [{ op: "insert_markdown", markdown: "large ".repeat(50000) }] },
    }),
  );
  t.after(() => A.free(huge));
  const capped = await read(f, { since_revision: f.base, max_bytes: 262144 }, f.revisions, huge);
  assert.equal(capped.body.code, "changes_budget_exceeded");
  assert.equal(
    capped.body.error,
    "Changes exceed max_bytes (262144); no partial delta was returned. Use comments:none, or read_page with section or node_ids for a new baseline.",
  );
});
