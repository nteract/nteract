// Agent writes refuse Markdown Pages can't represent with a coded error, and
// the Page host converts stored preserved blocks once, as their only writer.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { pmNodeToSpans } from "@automerge/prosemirror";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { adapter, exportMarkdown, richDoc, schema, textPath } from "../model/richtext.mjs";
import { CONVERSION_FEATURE, hasPreservedBlocks } from "../model/raw-migration.mjs";
import { documentFeatures } from "../model/schema-features.mjs";
import { fixture, pageId, trashArgs } from "./trash-fixture.mjs";

const refusedWith = (response, construct, line, column) => {
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "unsupported_markdown");
  assert.equal(response.body.unsupported.construct, construct);
  assert.equal(response.body.unsupported.line, line);
  assert.equal(response.body.unsupported.column, column);
  assert.match(response.body.error, new RegExp(`line ${line}, column ${column}`));
};

test("edits and comments with math or HTML are refused with the construct and position", async (t) => {
  const f = await fixture(t);
  const heads = f.heads();
  for (const [operation, args, construct, line, column] of [
    [
      "edit_page",
      { operations: [{ op: "insert_markdown", markdown: "Intro\n\nThe area is $\\pi r^2$." }] },
      "math",
      3,
      13,
    ],
    [
      "edit_page",
      {
        operations: [
          { op: "replace_block_markdown", block_id: f.blockId, markdown: "<details>x</details>" },
        ],
      },
      "html",
      1,
      1,
    ],
    [
      "manage_page_comment",
      { action: "add", block_id: f.blockId, body: "See $x$", body_format: "markdown" },
      "math",
      1,
      5,
    ],
  ]) {
    const refused = await f.tool("owner", operation, {
      ...args,
      base_heads: heads,
      idempotency_key: `unsupported-${operation}-${construct}`,
    });
    refusedWith(refused, construct, line, column);
  }
  assert.deepEqual(f.heads(), heads, "nothing is written");

  // The same text in a code span is fine, and a plain comment is literal.
  const accepted = await f.tool("owner", "edit_page", {
    base_heads: heads,
    idempotency_key: "supported-code-span",
    operations: [{ op: "insert_markdown", markdown: "Keep `~~x~~` and `$x$` and ~~old~~." }],
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const plain = await f.tool("owner", "manage_page_comment", {
    base_heads: f.heads(),
    idempotency_key: "plain-comment-math",
    action: "add",
    block_id: f.blockId,
    body: "Literal $x$ and <b>",
  });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
});

test("create_page refuses unsupported Markdown before reserving anything", async (t) => {
  const f = await fixture(t);
  const catalog = f.catalogOf(f.owner);
  const before = new Map(catalog.storage.values);
  const refused = await f.catalogCall("owner", "create_page", {
    title: "Math",
    markdown: "Euler: $e^{i\\pi} + 1 = 0$",
    idempotency_key: "create-with-math",
  });
  refusedWith(refused, "math", 1, 8);
  assert.deepEqual(catalog.storage.values, before);
});

// A Page as an older build stored it: preserved blocks in the body and in a
// comment message.
function preservedPage() {
  let doc = A.change(A.from(createPageData({ pageId, title: "Launch plan" })), (draft) =>
    initializePage(draft, "We ship on Friday."),
  );
  const id = orderedBlockIds(doc)[0];
  const tree = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("We ship on Friday.")]),
    schema.node("raw", {
      source: "Keep `~~x~~` and ~~drop~~.\n\n---\n\nThe value is $x + 1$.",
      importId: "",
      kind: "markdown",
    }),
  ]);
  doc = A.change(doc, (draft) =>
    A.updateSpans(draft, textPath(id), pmNodeToSpans(adapter, tree), adapter.updateSpansConfig()),
  );
  return doc;
}

test("the host converts preserved blocks once, through the operation journal", async (t) => {
  const plain = await fixture(t);
  const stored = preservedPage();
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(stored) });
  A.free(stored);
  assert.ok(hasPreservedBlocks(f.doc()));
  // Two triggers at once, as a load and a creation could race: both resolve
  // to one journal entry keyed by the converted heads.
  await Promise.all([f.page.convertPreservedMarkdown(), f.page.convertPreservedMarkdown()]);
  assert.equal(hasPreservedBlocks(f.doc()), false);
  const id = orderedBlockIds(f.doc())[0];
  const markdown = exportMarkdown(richDoc(f.doc().blocks[id]));
  assert.equal(
    markdown,
    "We ship on Friday.\n\nKeep `~~x~~` and ~~drop~~.\n\n---\n\nThe value is \\$x + 1\\$.",
  );
  assert.equal(markdown.split("drop").length, 2, "converted once");
  assert.ok(documentFeatures(f.doc()).includes(CONVERSION_FEATURE));
  const journal = [
    ...(await f.storage.list({ prefix: "host/operation/internal:preserved_markdown_" })),
  ];
  assert.equal(journal.length, 1);
  assert.equal(journal[0][1].pending, false);
  // Idempotent: a later load finds nothing to convert and writes nothing.
  const heads = f.heads();
  await f.page.convertPreservedMarkdown();
  await (await f.restart()).convertPreservedMarkdown();
  assert.deepEqual(f.heads(), heads);
});

test("the host leaves a Page alone when this build can't write it", async (t) => {
  const plain = await fixture(t);
  const stored = A.change(preservedPage(), (draft) => {
    draft.schema = { features: ["future-feature"] };
  });
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(stored) });
  A.free(stored);
  const heads = f.heads();
  await f.page.convertPreservedMarkdown();
  assert.deepEqual(f.heads(), heads);
  assert.ok(hasPreservedBlocks(f.doc()));
});

// Cut the conversion after its durable intent and before the document bytes
// reach storage, then rebuild the host from storage alone. Journal recovery
// applies the recorded change, and the load's conversion finds nothing left.
test("a crash after the conversion intent and before the document flush converts exactly once", async (t) => {
  const plain = await fixture(t);
  const stored = preservedPage();
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(stored) });
  A.free(stored);
  let flushes = 0;
  // documentMutation flushes the base, persists the intent, applies, then
  // flushes the result: the second flush is the cut.
  f.hooks.flush = () => {
    if (++flushes === 2) throw Object.assign(Error("process killed"), { cut: true });
  };
  await f.page.convertPreservedMarkdown();
  const journal = async () => [
    ...(await f.storage.list({ prefix: "host/operation/internal:preserved_markdown_" })),
  ];
  const [[, intent]] = await journal();
  assert.equal(intent.pending, true, "the intent is durable and unfinished");
  f.hooks.flush = undefined;

  await f.crashRestart();
  assert.equal(hasPreservedBlocks(f.doc()), false);
  const id = orderedBlockIds(f.doc())[0];
  const markdown = exportMarkdown(richDoc(f.doc().blocks[id]));
  assert.equal(markdown.split("drop").length, 2, "converted once");
  const entries = await journal();
  assert.equal(entries.length, 1);
  assert.equal(entries[0][1].pending, false);
  // Another crash restart writes nothing.
  const heads = f.heads();
  await f.crashRestart();
  assert.deepEqual(f.heads(), heads);
});

test("restoring a trashed Page converts its preserved blocks before access reopens", async (t) => {
  const plain = await fixture(t);
  const stored = preservedPage();
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(stored) });
  A.free(stored);
  // Trash it before the host converts, as a Page trashed under an older build.
  const trashed = await f.catalogCall("owner", "delete_page", trashArgs(f));
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  await f.page.convertPreservedMarkdown();
  assert.ok(hasPreservedBlocks(f.doc()), "a trashed Page is not converted");
  let convertedBeforeAccess;
  const refresh = f.page.policy.refreshAccess.bind(f.page.policy);
  f.page.policy.refreshAccess = async (...args) => {
    convertedBeforeAccess ??= !hasPreservedBlocks(f.doc());
    return refresh(...args);
  };
  const restored = await f.catalogCall("owner", "restore_page", {
    page_id: pageId,
    idempotency_key: "restore-preserved",
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  // No restart: the restore itself converted, before access refreshed.
  assert.equal(convertedBeforeAccess, true);
  assert.equal(hasPreservedBlocks(f.doc()), false);
  assert.ok(documentFeatures(f.doc()).includes(CONVERSION_FEATURE));
});

test("agent writes that would lose content are refused with the construct and position", async (t) => {
  const f = await fixture(t);
  for (const [markdown, construct, line, column] of [
    ["[![caption](image.png)](https://example.org)", "wrapped-image", 1, 2],
    ["| A |\n| --- |\n| b | c |", "table-cells", 3, 5],
    ["See [](https://example.org)", "empty-link", 1, 5],
    ["Prose.\n\n[unused]: https://example.org", "definition", 3, 1],
  ]) {
    const refused = await f.tool("owner", "edit_page", {
      base_heads: f.heads(),
      idempotency_key: `lossy-${construct}`,
      operations: [{ op: "insert_markdown", markdown }],
    });
    refusedWith(refused, construct, line, column);
  }
});

test("a preserved block whose source would lose content converts to literal text", async (t) => {
  const plain = await fixture(t);
  let stored = A.change(A.from(createPageData({ pageId, title: "Lossy" })), (draft) =>
    initializePage(draft, ""),
  );
  const id = orderedBlockIds(stored)[0];
  const source = "[![caption](image.png)](https://example.org)\n\n| A |\n| --- |\n| b | c |";
  stored = A.change(stored, (draft) =>
    A.updateSpans(
      draft,
      textPath(id),
      pmNodeToSpans(
        adapter,
        schema.node("doc", null, [schema.node("raw", { source, importId: "", kind: "markdown" })]),
      ),
      adapter.updateSpansConfig(),
    ),
  );
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(stored) });
  A.free(stored);
  await f.page.convertPreservedMarkdown();
  const doc = richDoc(f.doc().blocks[id]);
  // Every character survives as text: the link, the image and every cell.
  for (const part of source.split("\n").filter(Boolean)) assert.ok(doc.textContent.includes(part));
  doc.descendants((node) => {
    assert.ok(!["image", "table", "raw"].includes(node.type.name), node.type.name);
  });
});

const settle = async (predicate) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(predicate(), "condition reached");
};

// Discovery while fenced: readable, a `converting` notice, and the grant
// unchanged so the viewer keeps its writer key.
async function assertConverting(f) {
  const discovery = await f.pageCall("owner", `/api/connect?page=${pageId}`, undefined, "GET");
  assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
  assert.equal(discovery.body.converting?.code, "preserved_markdown_converting");
  assert.equal(discovery.body.access.canWrite, true);
  return discovery.body;
}
async function trashedPreservedPage(t) {
  const plain = await fixture(t);
  const stored = preservedPage();
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(stored) });
  A.free(stored);
  assert.equal((await f.catalogCall("owner", "delete_page", trashArgs(f))).status, 200);
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "held");
  return f;
}

test("restore keeps native writes fenced until the conversion finishes", async (t) => {
  const f = await trashedPreservedPage(t);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  f.hooks.flush = () => gate;
  const restoring = f.catalogCall("owner", "restore_page", {
    page_id: pageId,
    idempotency_key: "restore-fenced",
  });
  // The active record is installed and the conversion is running.
  await settle(() => f.page.conversion.name === "converting");
  assert.equal(f.page.metadata.trash, undefined, "the record is active");
  // No key can write. (Discovery waits behind the restore in the request
  // queue; the failed-conversion test below reads it while fenced.)
  const key = "ab".repeat(32);
  await f.bind(key, f.owner);
  await assert.rejects(f.page.policy.put(key, key, f.page.metadata.tree), {
    code: "preserved_markdown_converting",
  });
  assert.ok(hasPreservedBlocks(f.doc()));
  release();
  f.hooks.flush = undefined;
  assert.equal((await restoring).status, 200);
  assert.equal(f.page.conversion.name, "clear");
  assert.equal(hasPreservedBlocks(f.doc()), false);
  assert.equal(f.page.conversionWriteFence(), undefined);
  // The fence is down: the same put is admitted.
  await f.page.policy.put(key, key, f.page.metadata.tree);
});

test("a failed conversion keeps the fence after restore; edits wait for the retry", async (t) => {
  const f = await trashedPreservedPage(t);
  f.hooks.flush = () => {
    throw Error("storage unavailable");
  };
  const restored = await f.catalogCall("owner", "restore_page", {
    page_id: pageId,
    idempotency_key: "restore-failing",
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(f.page.conversion.name, "failed");
  assert.ok(hasPreservedBlocks(f.doc()), "nothing half-written");
  // Read-only: discovery reports the hold, and HTTP edits are refused
  // without starting a retry before its backoff.
  await assertConverting(f);
  let edits = 0;
  const edit = () =>
    f.tool("owner", "edit_page", {
      base_heads: f.heads(),
      idempotency_key: `after-restore-${++edits}`,
      operations: [{ op: "insert_markdown", markdown: "Added after restore." }],
    });
  const refused = await edit();
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "preserved_markdown_converting");
  assert.deepEqual(f.page.conversion, { name: "failed", mode: "native", attempt: 1 });
  // Storage recovers and the retry timer fires: the same run finishes, and
  // the next edit lands.
  f.hooks.flush = undefined;
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "clear");
  const accepted = await edit();
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(hasPreservedBlocks(f.doc()), false);
  const markdown = exportMarkdown(richDoc(f.doc().blocks[orderedBlockIds(f.doc())[0]]));
  assert.equal(markdown.split("drop").length, 2, "converted once");
});

// A stand-in for DocumentAdmission's intent bookkeeping: one reservation per
// key until release, replay applies the recorded changes.
function fakeAdmission() {
  const intents = new Map();
  return {
    intents,
    get hasPending() {
      return intents.size > 0;
    },
    pending: (key) => (intents.has(key) ? structuredClone(intents.get(key)) : undefined),
    async reserve(key, entry, _candidate, _base, persist) {
      intents.set(key, structuredClone(entry));
      await persist();
    },
    async replay(_key, entry, handle) {
      await handle.update((doc) => A.applyChanges(doc, entry.changes)[0]);
    },
    async apply(_keys, changes, handle) {
      await handle.update((doc) => A.applyChanges(doc, changes)[0]);
    },
    async release(key) {
      intents.delete(key);
    },
  };
}
async function preservedFixture(t) {
  const plain = await fixture(t);
  const stored = preservedPage();
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(stored) });
  A.free(stored);
  return f;
}
const internalEntries = async (f) => [
  ...(await f.storage.list({ prefix: "host/operation/internal:" })),
];

test("a full legacy receipt store doesn't block the conversion", async (t) => {
  const f = await preservedFixture(t);
  for (let n = 0; n < 1000; n++)
    await f.storage.put(`host/operation/legacy-${String(n).padStart(4, "0")}`, {
      fingerprint: `fixture-${n}`,
      pending: false,
      createdAt: "2000-01-01T00:00:00.000Z",
      receipt: { page_id: pageId },
    });
  // The host's own conversion has its own key space and capacity.
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "clear");
  assert.equal(hasPreservedBlocks(f.doc()), false);
  const [[key, entry]] = await internalEntries(f);
  assert.match(key, /^host\/operation\/internal:preserved_markdown_/);
  assert.equal(entry.pending, false);
  const legacy = await f.tool("owner", "edit_page", {
    base_heads: f.heads(),
    idempotency_key: "legacy-overflow",
    operations: [{ op: "insert_markdown", markdown: "More." }],
  });
  assert.equal(legacy.body.code, "operation_receipt_capacity", "client budgets are unchanged");
});

test("a conversion that applied but failed to finish replays until its journal entry is terminal", async (t) => {
  const f = await preservedFixture(t);
  const admission = fakeAdmission();
  f.page.admission = admission;
  let flushes = 0;
  // documentMutation flushes the base, reserves, applies, then flushes the
  // result: fail that second flush, after the change applied.
  f.hooks.flush = () => {
    if (++flushes === 2) throw Error("storage unavailable");
  };
  await f.page.convertPreservedMarkdown();
  assert.equal(hasPreservedBlocks(f.doc()), false, "the change applied");
  assert.equal(f.page.conversion.name, "failed", "the fence stays");
  assert.ok(admission.hasPending, "the reservation is still held");
  const [[, pending]] = await internalEntries(f);
  assert.equal(pending.pending, true);
  // No restart: the next observation replays the same intent.
  f.hooks.flush = undefined;
  const heads = f.heads();
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "clear");
  assert.equal(admission.hasPending, false, "the reservation is released");
  const [[, finished]] = await internalEntries(f);
  assert.equal(finished.pending, false);
  assert.deepEqual(f.heads(), heads, "the replay added nothing");
  // Later edits aren't blocked by pending_operation_capacity.
  const edit = await f.tool("owner", "edit_page", {
    base_heads: f.heads(),
    idempotency_key: "after-replay",
    operations: [{ op: "insert_markdown", markdown: "Next." }],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const markdown = exportMarkdown(richDoc(f.doc().blocks[orderedBlockIds(f.doc())[0]]));
  assert.equal(markdown.split("drop").length, 2, "converted once");
});

test("a conversion that fails for good falls back to literal text", async (t) => {
  const f = await preservedFixture(t);
  let native = true;
  f.hooks.flush = () => {
    // The first (native) run is too large; the literal run fits.
    if (native) {
      native = false;
      throw Object.assign(Error("too large"), { status: 413 });
    }
  };
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "clear");
  assert.equal(hasPreservedBlocks(f.doc()), false);
  const tree = richDoc(f.doc().blocks[orderedBlockIds(f.doc())[0]]);
  // Plain text: the source's Markdown syntax is kept as characters.
  assert.match(tree.textContent, /Keep `~~x~~` and ~~drop~~\./);
  tree.descendants((node) => assert.notEqual(node.type.name, "horizontal_rule"));
});

test("when both modes fail for good the Page is stuck, logged, and open", async (t) => {
  const f = await preservedFixture(t);
  const logged = [];
  t.mock.method(console, "error", (line) => logged.push(String(line)));
  f.hooks.flush = () => {
    throw Object.assign(Error("too large"), { status: 413 });
  };
  await f.page.convertPreservedMarkdown();
  assert.deepEqual(f.page.conversion, { name: "stuck", reason: "status_413" });
  assert.ok(logged.some((line) => line.includes('"page.preserved_markdown_stuck"')));
  // Never unrecoverable: the fence is down, and the preserved block stays
  // read-only until an edit replaces it (DEPLOYMENT.md).
  assert.equal(f.page.conversionWriteFence(), undefined);
  assert.ok(hasPreservedBlocks(f.doc()));
  f.hooks.flush = undefined;
  // The recovery: replace the block with the Markdown read_page shows for it.
  const read = await f.tool("owner", "read_page", { page_id: pageId, comments: "none" });
  const [block] = read.body.blocks;
  const blockId = orderedBlockIds(f.doc())[0];
  const replaced = await f.tool("owner", "edit_page", {
    base_heads: f.heads(),
    idempotency_key: "operator-recovery",
    operations: [{ op: "replace_block_markdown", block_id: blockId, markdown: block.markdown }],
  });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal(hasPreservedBlocks(f.doc()), false);
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "clear");
});

// A 413 after the journal entry is reserved, such as the record store
// refusing the conversion's records on install. The run's change may already
// be in the serving document, so it keeps the fence and retries that exact
// intent, never a fallback, until storage recovers.
test("a permanent failure after the reservation retries the same intent until storage recovers", async (t) => {
  const { STUCK_LOG_EVERY } = await import("./preserved-conversion.mjs");
  const f = await preservedFixture(t);
  const admission = fakeAdmission();
  f.page.admission = admission;
  const logged = [];
  t.mock.method(console, "error", (line) => logged.push(String(line)));
  // Every flush after the change applied is refused for capacity.
  f.hooks.flush = () => {
    if (!hasPreservedBlocks(f.doc()))
      throw Object.assign(Error("record capacity"), { status: 413 });
  };
  await f.page.convertPreservedMarkdown();
  const [[key]] = await internalEntries(f);
  const attempts = STUCK_LOG_EVERY * 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    assert.deepEqual(f.page.conversion, { name: "failed", mode: "native", attempt });
    assert.ok(f.page.conversionWriteFence(), "the fence stays");
    assert.ok(admission.pending(key), "still reserved");
    const entries = await internalEntries(f);
    assert.deepEqual(
      entries.map(([name]) => name),
      [key],
      "the same key, no other run",
    );
    assert.equal(entries[0][1].pending, true);
    if (attempt < attempts) await f.page.convertPreservedMarkdown();
  }
  const stuckLines = logged.filter((line) => line.includes('"page.preserved_markdown_stuck"'));
  assert.equal(stuckLines.length, 3, "logged every STUCK_LOG_EVERY failures");
  assert.match(stuckLines[0], /"reason":"status_413"/);
  // Edits are refused, never pending_operation_capacity.
  const refused = await f.tool("owner", "edit_page", {
    base_heads: f.heads(),
    idempotency_key: "while-fenced",
    operations: [{ op: "insert_markdown", markdown: "Next." }],
  });
  assert.equal(refused.body.code, "preserved_markdown_converting");
  // An operator frees capacity: the next retry finishes the same intent.
  f.hooks.flush = undefined;
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "clear");
  assert.equal(admission.hasPending, false);
  const [[finishedKey, finished]] = await internalEntries(f);
  assert.equal(finishedKey, key);
  assert.equal(finished.pending, false);
  assert.equal(finished.abandoned, undefined);
  const markdown = exportMarkdown(richDoc(f.doc().blocks[orderedBlockIds(f.doc())[0]]));
  assert.equal(markdown.split("drop").length, 2, "converted once");
  const edit = await f.tool("owner", "edit_page", {
    base_heads: f.heads(),
    idempotency_key: "after-recovery",
    operations: [{ op: "insert_markdown", markdown: "Next." }],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
});

test("a restart during the retry loop resumes the same intent and finishes it once", async (t) => {
  const f = await preservedFixture(t);
  t.mock.method(console, "error", () => {});
  f.hooks.flush = () => {
    if (!hasPreservedBlocks(f.doc()))
      throw Object.assign(Error("record capacity"), { status: 413 });
  };
  await f.page.convertPreservedMarkdown();
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "failed");
  const [[key, pending]] = await internalEntries(f);
  assert.equal(pending.pending, true);
  // The process dies; storage has the journal entry but not the converted
  // document. Capacity is freed before it starts again.
  f.hooks.flush = undefined;
  await f.crashRestart();
  assert.equal(f.page.conversion.name, "clear");
  assert.equal(hasPreservedBlocks(f.doc()), false);
  const entries = await internalEntries(f);
  assert.deepEqual(
    entries.map(([name]) => name),
    [key],
    "no second run",
  );
  assert.equal(entries[0][1].pending, false);
  const markdown = exportMarkdown(richDoc(f.doc().blocks[orderedBlockIds(f.doc())[0]]));
  assert.equal(markdown.split("drop").length, 2, "converted once");
  // Restarting again changes nothing.
  const heads = f.heads();
  await f.crashRestart();
  assert.deepEqual(f.heads(), heads);
});

test("a restart before capacity recovers keeps the Page readable and retrying", async (t) => {
  const f = await preservedFixture(t);
  t.mock.method(console, "error", () => {});
  const refuse = () => {
    if (!hasPreservedBlocks(f.doc()))
      throw Object.assign(Error("record capacity"), { status: 413 });
  };
  f.hooks.flush = refuse;
  await f.page.convertPreservedMarkdown();
  const [[key]] = await internalEntries(f);
  // The process dies and starts again while capacity is still unavailable:
  // journal recovery's flush fails too. Startup must still finish.
  await f.crashRestart();
  assert.equal(f.page.conversion.name, "failed", "fenced, retry scheduled");
  assert.ok(f.page.conversionWriteFence());
  const read = await f.tool("owner", "read_page", { page_id: pageId, comments: "none" });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  await assertConverting(f);
  const refused = await f.tool("owner", "edit_page", {
    base_heads: f.heads(),
    idempotency_key: "while-restarted",
    operations: [{ op: "insert_markdown", markdown: "Next." }],
  });
  assert.equal(refused.body.code, "preserved_markdown_converting");
  // Capacity returns: the next retry finishes the same entry.
  f.hooks.flush = undefined;
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "clear");
  const entries = await internalEntries(f);
  assert.deepEqual(
    entries.map(([name]) => name),
    [key],
    "no second run",
  );
  assert.equal(entries[0][1].pending, false);
  const markdown = exportMarkdown(richDoc(f.doc().blocks[orderedBlockIds(f.doc())[0]]));
  assert.equal(markdown.split("drop").length, 2, "converted once");
  const discovery = await f.pageCall("owner", `/api/connect?page=${pageId}`, undefined, "GET");
  assert.equal(discovery.body.converting, undefined);
});

// While fenced, peers connect and sync down; every put is refused, which is
// what keeps a competing conversion out. When the fence drops, connected
// peers are closed with a transient code so they rediscover and edit.
test("a fenced Page admits connections, refuses every put, and closes them when the fence drops", async (t) => {
  const f = await preservedFixture(t);
  t.mock.method(console, "error", () => {});
  f.hooks.flush = () => {
    if (!hasPreservedBlocks(f.doc()))
      throw Object.assign(Error("record capacity"), { status: 413 });
  };
  await f.page.convertPreservedMarkdown();
  assert.ok(f.page.conversionWriteFence());
  const closed = [];
  const reader = {
    disconnect: async (code, reason) => closed.push({ code, reason }),
  };
  f.page.wires.add(reader);
  // A connected key, even the old tab's, can't put.
  for (const key of ["cd".repeat(32), "ef".repeat(32)]) {
    await f.bind(key, f.owner);
    await assert.rejects(f.page.policy.put(key, key, f.page.metadata.tree), {
      code: "preserved_markdown_converting",
    });
  }
  assert.deepEqual(closed, [], "readers stay connected while fenced");
  f.hooks.flush = undefined;
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "clear");
  assert.deepEqual(closed, [{ code: 4503, reason: "temporarily_unavailable" }]);
  f.page.wires.delete(reader);
});

// Many connections and edits after a failure start no extra attempts before
// the retry deadline; the timer's retry is the only one.
test("connections and edits after a failure don't skip the backoff", async (t) => {
  const f = await preservedFixture(t);
  t.mock.method(console, "error", () => {});
  let flushes = 0;
  f.hooks.flush = () => {
    flushes++;
    throw Error("storage unavailable");
  };
  await f.page.convertPreservedMarkdown();
  assert.deepEqual(f.page.conversion, { name: "failed", mode: "native", attempt: 1 });
  const before = flushes;
  // Each nudge runs as a connection would, after its capacity check.
  for (let n = 0; n < 50; n++) f.page.observeConversion();
  for (let n = 0; n < 5; n++)
    await f.tool("owner", "edit_page", {
      base_heads: f.heads(),
      idempotency_key: `nudge-edit-${n}`,
      operations: [{ op: "insert_markdown", markdown: "x" }],
    });
  assert.equal(f.page.conversionRun, undefined, "nothing started");
  assert.equal(flushes, before, "no run touched storage");
  assert.deepEqual(f.page.conversion, { name: "failed", mode: "native", attempt: 1 });
  // The timer is the retry.
  f.hooks.flush = undefined;
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "clear");
});

// Cloudflare's socket globals, enough for connect() to answer an upgrade.
function socketGlobals(t) {
  const closed = [];
  const globals = {
    WebSocketPair: class {
      constructor() {
        const socket = () => ({
          accept() {},
          close: (code, reason) => closed.push({ code, reason }),
          addEventListener() {},
          send() {},
        });
        this[0] = socket();
        this[1] = socket();
      }
    },
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  // Node's Response refuses status 101.
  t.mock.method(globalThis, "Response", function (body, options) {
    return { status: options?.status, webSocket: options?.webSocket };
  });
  return closed;
}

// Discovery reports `converting`, the conversion finishes, then the viewer's
// upgrade arrives. It never joined `wires`, so it missed the completion
// close: the host refuses the upgrade so the tab rediscovers.
test("an upgrade from a tab that discovered converting, after completion, is sent back", async (t) => {
  const f = await preservedFixture(t);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  f.hooks.flush = () => {
    if (!hasPreservedBlocks(f.doc())) throw Error("storage unavailable");
  };
  await f.page.convertPreservedMarkdown();
  await assertConverting(f);
  f.hooks.flush = undefined;
  await f.page.convertPreservedMarkdown();
  assert.equal(f.page.conversion.name, "clear");
  const closed = socketGlobals(t);
  const upgrade = (query) =>
    f.page.connect(
      new Request(`http://localhost/api/sync?page=${pageId}${query}`, {
        headers: { upgrade: "websocket" },
      }),
      { ...f.identity(f.owner), credentialKind: "oidc" },
    );
  const response = upgrade("&converting=1");
  assert.equal(response.status, 101);
  assert.deepEqual(closed, [{ code: 4503, reason: "temporarily_unavailable" }]);
  assert.equal(f.page.wires.size, 0, "never admitted");
});
