import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import * as A from "@automerge/automerge";
import { generateAutomergeUrl, interpretAsDocumentId } from "@automerge/automerge-repo";
import * as esbuild from "esbuild";
import fc from "fast-check";
import { Leaf } from "wordgard/doc";
import { GardState } from "wordgard/state";
import { validateNativeSpans } from "./native-validation.mjs";
import { validateRichSpans, pageSpans } from "./richtext-spans.mjs";
import { textPath, RICH_FORMAT } from "./richtext-format.mjs";
import { parseMarkdown } from "./markdown-import.mjs";
import { decode, encode, schema } from "./wordgard-doc.mjs";
import { COMMENT_MAX_BYTES, setCommentContent, validateCommentSpans } from "./comment-content.mjs";
import { createPageData, initializePage, applyPageOperation } from "./page.mjs";
import { commentsGenesis } from "./comments-doc.mjs";
import { applyComment } from "./comments.mjs";
import { pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";
import { createWordgardBinding } from "../viewer/wordgard-binding.mjs";
import { COMMENTS_DOC, documentMutation } from "../worker/mutations.mjs";
import { readRegistration } from "../worker/registration.mjs";

const S = (value) => new A.ImmutableString(value);
const B = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: { type: S(type), parents: parents.map(S), attrs, isEmbed },
});
const T = (value, marks = {}) => ({ type: "text", value, marks });
const pageId = "12345678-1234-4123-8123-123456789abc";
const asset = `/api/pages/${pageId}/assets/${"a".repeat(64)}`;
const dataset = { src: S(asset), media_type: S("application/vnd.apache.parquet") };
function trackDocs(t) {
  const docs = new Set();
  t.after(() => {
    for (const doc of docs) A.free(doc);
  });
  return (doc) => {
    docs.add(doc);
    return doc;
  };
}

test("native validation preserves healthy generated Wordgard documents without rewriting input", () => {
  fc.assert(
    fc.property(pageTreeArbitrary({ maxDepth: 3 }), (description) => {
      const tree = toWordgardTree(description);
      const spans = encode(tree),
        before = JSON.stringify(spans);
      validateRichSpans(spans);
      assert.equal(JSON.stringify(spans), before);
      assert.equal(decode(spans).lossy, false);
    }),
    { seed: 11082026, numRuns: 200 },
  );
});

test("known container contracts preserve partial tables, raw mutable fields and lenient attrs", () => {
  const accepted = [
    [],
    [T("\n")],
    [B("table")],
    [B("table"), T("cell")],
    [B("table-row", ["table"])],
    [B("table-cell", ["table", "table-row"])],
    [
      B("table-header", ["table", "table-row"], { align: S("right") }),
      T("h"),
      B("table-cell", ["table", "table-row"]),
      T("h2"),
      B("table-row", ["table"]),
      T("one"),
    ],
    [B("code-block", [], { params: { future: true } }), T("code", { strong: true })],
    [B("heading", [], { level: 6, future: ["hidden", { metadata: "retained" }] }), T("Title")],
    [
      B(
        "image",
        [],
        { src: S("/image.png"), alt: false, title: 0, future: { nested: true } },
        true,
      ),
    ],
    [B("dataframe", [], { ...dataset, media_type: "future/type", future: { nested: [1, 2] } })],
    [
      { type: "block", value: { type: "heading", parents: [], attrs: { level: 99 } } },
      T("raw type"),
    ],
    [
      { type: "block", value: { type: S("paragraph"), parents: ["code-block"], attrs: {} } },
      T("raw parents", { em: true }),
    ],
    [B("dataframe", [], dataset, true)],
  ];
  for (const spans of accepted)
    assert.doesNotThrow(() => validateRichSpans(spans), JSON.stringify(spans));
  for (let level = 1; level <= 6; level++) validateRichSpans([B("heading", [], { level })]);
});

test("strict validation refuses malformed structure, not just unreadable projections", () => {
  for (const spans of [
    [B("table-row")],
    [B("paragraph", ["table", "table-cell"])],
    [B("paragraph", ["table", "aside", "table-row"])],
    [B("code-block"), B("hard-break", [], {}, true)],
    [B("code-block"), B("image", [], { src: "/image" }, true)],
    [B("dataframe", [], dataset), T("unwrapped")],
    [B("horizontal-rule"), T("unwrapped")],
  ])
    assert.throws(() => validateRichSpans(spans), { message: "Match cannot be null" });
  assert.throws(() => validateRichSpans([B("future")]), /Unsupported rich block marker/);
  assert.throws(() => validateRichSpans([B("pages-opaque")]), /Unsupported rich block marker/);
  assert.throws(() => validateRichSpans([B("paragraph", ["future"])]), /Unsupported rich parent/);
  assert.throws(
    () => validateRichSpans([B("table", [], {}, true)]),
    /Invalid content for node table: <>/,
  );
  assert.throws(
    () => validateRichSpans([B("aside"), T("text")]),
    /Token type `aside` not supported by Markdown renderer/,
  );
  assert.throws(() => validateRichSpans([T("")]), /Empty text nodes are not allowed/);
});

test("feature attrs retain strict scalar types, URL checks and public error precedence", () => {
  for (const checked of [null, "false", 1, S("true"), {}])
    assert.throws(
      () => validateRichSpans([B("task-list-item", [], { checked })]),
      /Invalid task checked state/,
    );
  for (const level of [0, 7, 1.5, "2", S("2"), {}, null])
    assert.throws(() => validateRichSpans([B("heading", [], { level })]), /Invalid heading level/);
  assert.throws(
    () => validateRichSpans([B("table-cell", ["table", "table-row"], { align: "justify" })]),
    /Invalid table alignment/,
  );
  assert.throws(
    () =>
      validateRichSpans([B("image", [], { src: "/image", dark_src: "data:image/png,xx" }, true)]),
    /Invalid rich image URL/,
  );
  assert.throws(
    () => validateRichSpans([T("x", { link: '{"href":"javascript:x"}' })]),
    /Invalid rich link/,
  );
  assert.throws(
    () => validateRichSpans([B("dataframe", [], { ...dataset, src: "/foreign" })]),
    /Invalid dataframe: src must be a Page asset path/,
  );
  assert.throws(
    () => validateRichSpans([B("image", [], {}, true)]),
    /No value supplied for attribute src/,
  );
  assert.throws(
    () => validateRichSpans([B("heading", [], { level: 0 }), T("x", { strong: false })]),
    /Invalid rich mark value/,
  );
  assert.throws(
    () => validateRichSpans([B("heading", [], { level: 0 }), B("table-cell")]),
    /Match cannot be null/,
  );
  assert.throws(
    () =>
      validateRichSpans([
        B("code-block", [], { params: { toString: 1 } }),
        B("heading", [], { level: 0 }),
      ]),
    /Invalid heading level/,
  );
  assert.throws(
    () => validateRichSpans([B("image", [], JSON.parse('{"__proto__":{"src":"/hidden"}}'), true)]),
    /No value supplied for attribute src/,
  );
});

test("JSON byte bounds are inclusive, UTF-8 based and checked before invalid marks", () => {
  const overhead = Buffer.byteLength(JSON.stringify([T("")]));
  for (const limit of [262144, COMMENT_MAX_BYTES]) {
    for (const unit of ["x", "\u00e9", "\u{1f642}"]) {
      const remaining = limit - overhead;
      const body =
        unit.repeat(Math.floor(remaining / Buffer.byteLength(unit))) +
        "x".repeat(remaining % Buffer.byteLength(unit));
      assert.equal(Buffer.byteLength(JSON.stringify([T(body)])), limit);
      validateRichSpans([T(body)], limit);
      assert.throws(
        () => validateRichSpans([T(`${body}x`)], limit),
        /Rich block exceeds content limit/,
      );
    }
  }
  assert.throws(
    () => validateRichSpans([T("x".repeat(262144), { future: true })]),
    /Rich block exceeds content limit/,
  );
  assert.throws(
    () => validateCommentSpans([B("dataframe", [], dataset)]),
    /can't hold a dataframe/,
  );
  assert.throws(
    () => validateCommentSpans([B("image", [], { src: "/image", dark_src: "/dark" }, true)]),
    /theme image variants/,
  );
});

test("validation leaves merged saved bytes, marker identities and the next keystroke unchanged", (t) => {
  const keep = trackDocs(t);
  const path = textPath("one");
  let original = keep(A.from({ blocks: { one: { format: RICH_FORMAT, richText: "" } } }));
  original = A.change(original, (doc) =>
    A.updateSpans(
      doc,
      path,
      pageSpans(
        parseMarkdown("Before\n\n- [x] task\n- item\n\n| A | B |\n| --- | --- |\n| x | y |"),
      ),
    ),
  );
  const left = keep(A.change(A.clone(original), (doc) => A.splice(doc, path, 1, 0, "left ")));
  const right = keep(
    A.change(A.clone(original), (doc) =>
      A.mark(doc, path, { start: 1, end: 3, expand: "both" }, "strong", true),
    ),
  );
  const merged = A.merge(left, right);
  const loaded = keep(A.load(A.save(merged)));
  for (const doc of [merged, loaded]) {
    const bytes = A.save(doc),
      heads = A.getHeads(doc),
      spans = A.spans(doc, path);
    const ids = spans
      .filter((span) => span.type === "block")
      .map((span) => A.getObjectId(span.value));
    for (let i = 0; i < 4; i++) validateRichSpans(A.spans(doc, path));
    assert.deepEqual(A.save(doc), bytes);
    assert.deepEqual(A.getHeads(doc), heads);
    assert.deepEqual(
      A.spans(doc, path)
        .filter((span) => span.type === "block")
        .map((span) => A.getObjectId(span.value)),
      ids,
    );
    const type = (checked) => {
      let current = keep(A.clone(doc, { actor: "ab".repeat(16) }));
      const observers = new Set();
      const replica = {
        get doc() {
          return current;
        },
        change(fn) {
          const before = current;
          current = A.change(current, (draft) => {
            if (checked) validateRichSpans(A.spans(draft, path));
            fn(draft);
          });
          for (const listener of observers)
            listener({ remote: false, patchInfo: { before, after: current } });
        },
        observeChange(fn) {
          observers.add(fn);
          return () => observers.delete(fn);
        },
      };
      const binding = createWordgardBinding(replica, "one");
      const state = GardState.create({
        doc: binding.current.doc,
        config: [GardState.schemaElement.of(schema.elements)],
      });
      binding.applyEditorTransaction(
        state.update({ changes: { from: 2, insert: [Leaf.text("K")] } }),
      );
      binding.destroy();
      return current;
    };
    const withoutValidation = type(false),
      withValidation = type(true);
    assert.deepEqual(A.spans(withValidation, path), A.spans(withoutValidation, path));
    assert.deepEqual(
      A.decodeChange(A.getLastLocalChange(withValidation)).ops,
      A.decodeChange(A.getLastLocalChange(withoutValidation)).ops,
    );
    validateRichSpans(A.spans(withValidation, path));
  }
});

test("actual comment writers reject before journaling and successful Page/comment receipts remain valid", async (t) => {
  const keep = trackDocs(t);
  const identity = { principal: "user:test", driver: "test" };
  const storage = {
    entries: new Map(),
    puts: 0,
    get: async (key) => storage.entries.get(key),
    put: async (key, value) => {
      storage.puts++;
      storage.entries.set(key, value);
    },
    delete: async (key) => storage.entries.delete(key),
    sync: async () => {},
    list: async ({ prefix = "", startAfter, limit = Infinity } = {}) =>
      new Map(
        [...storage.entries]
          .sort(([a], [b]) => a.localeCompare(b))
          .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
          .slice(0, limit),
      ),
  };
  let page = keep(
    A.change(A.from(createPageData({ pageId, title: "Title" })), (doc) =>
      initializePage(doc, "Before"),
    ),
  );
  const blockId = Object.keys(page.blocks)[0];
  const handle = {
    doc: () => page,
    update: async (fn) => {
      page = fn(page);
    },
  };
  const mutate = (operations, key) =>
    documentMutation({
      storage,
      handle,
      identity,
      flush: async () => {},
      operation: "edit_page",
      args: { idempotency_key: key, base_heads: A.getHeads(page), operations },
      apply: (doc) =>
        applyPageOperation(doc, { operation: "edit_page", arguments: { operations } }),
    });
  const receipt = await mutate(
    [
      {
        op: "replace_block_markdown",
        block_id: blockId,
        markdown: "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [x] Done",
      },
    ],
    "healthy-block",
  );
  assert.deepEqual(receipt.heads, A.getHeads(page));
  validateRichSpans(A.spans(page, textPath(blockId)));

  const genesis = keep(commentsGenesis(pageId));
  let comments = keep(A.clone(genesis));
  const commentHandle = {
    doc: () => comments,
    update: async (fn) => {
      comments = fn(comments);
    },
  };
  const body = {
    action: "add",
    block_id: blockId,
    body: "**Healthy** comment",
    body_format: "markdown",
  };
  const baseHeads = A.getHeads(comments);
  const request = (args) => ({
    storage,
    handle: commentHandle,
    doc: COMMENTS_DOC,
    pageId,
    identity,
    flush: async () => {},
    operation: "manage_page_comment",
    args: { ...args, base_heads: baseHeads, idempotency_key: "healthy-comment" },
    apply: (doc) => applyComment(doc, args, identity, undefined, { page, role: "editor" }),
  });
  const puts = storage.puts,
    beforeComments = A.save(comments);
  const tooLarge = { ...body, body: `![${"x".repeat(65300)}](/image "${"y".repeat(200)}")` };
  await assert.rejects(
    documentMutation({
      ...request(tooLarge),
      args: { ...tooLarge, idempotency_key: "bad-comment", base_heads: baseHeads },
    }),
    /Rich comment exceeds 64 KiB content limit/,
  );
  assert.equal(storage.puts, puts);
  assert.deepEqual(A.save(comments), beforeComments);
  const unsafe = [B("image", [], { src: S("javascript:x"), alt: S("image") }, true)];
  await assert.rejects(
    documentMutation({
      ...request(body),
      args: { ...body, idempotency_key: "unsafe-comment", base_heads: baseHeads },
      apply: (doc) => applyComment(doc, body, identity, unsafe, { page, role: "editor" }),
    }),
    /Invalid Pages image/,
  );
  assert.equal(storage.puts, puts);
  assert.deepEqual(A.save(comments), beforeComments);
  const commentReceipt = await documentMutation(request(body));
  assert.deepEqual(await documentMutation(request(body)), commentReceipt);
  assert.deepEqual(A.getHeads(comments), commentReceipt.heads);
  const saved = A.save(comments),
    previousHeads = A.getHeads(comments);
  assert.throws(
    () =>
      A.change(comments, (doc) =>
        setCommentContent(
          doc,
          [
            "threads",
            commentReceipt.result.thread_id,
            "messages",
            commentReceipt.result.message_id,
          ],
          { body_format: "markdown", body: "**new** $math$" },
        ),
      ),
    /math|Math/,
  );
  assert.deepEqual(A.save(comments), saved);
  assert.deepEqual(A.getHeads(comments), previousHeads);
});

test("Page bootstrap uses native validation and preserves its existing HTTP refusal", (t) => {
  const keep = trackDocs(t);
  const original = keep(
    A.change(A.from(createPageData({ pageId, title: "Title" })), (doc) =>
      initializePage(doc, "Before"),
    ),
  );
  const id = Object.keys(original.blocks)[0];
  const args = (doc) => ({
    page_id: pageId,
    document_id: interpretAsDocumentId(generateAutomergeUrl()),
    expected_principal: "user:test",
    title: "Title",
    initial_snapshot_base64: Buffer.from(A.save(doc)).toString("base64"),
  });
  const partial = keep(
    A.change(A.clone(original), (doc) => A.updateSpans(doc, textPath(id), [B("table")])),
  );
  const loaded = readRegistration(args(partial));
  keep(loaded.doc);
  assert.deepEqual(A.save(loaded.doc), A.save(partial));
  for (const spans of [
    [B("table-row")],
    [B("heading", [], { level: S("2") })],
    [B("image", [], { src: S("javascript:x") }, true)],
  ]) {
    const bad = keep(A.change(A.clone(original), (doc) => A.updateSpans(doc, textPath(id), spans)));
    const saved = A.save(bad);
    assert.throws(() => readRegistration(args(bad)), {
      status: 400,
      message: "Invalid initial Page snapshot",
    });
    assert.deepEqual(A.save(bad), saved);
  }
});

test("native helper import graph contains no PM, parser or tolerant read fallback", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const graph = async (entry) => {
    const { metafile } = await esbuild.build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      treeShaking: false,
      metafile: true,
      logLevel: "silent",
      external: ["cloudflare:workers"],
    });
    return Object.keys(metafile.inputs);
  };
  const native = await graph("model/native-validation.mjs");
  assert.deepEqual(
    native.filter((path) =>
      /prosemirror|pm-adapter|native-read|markdown-import|richtext-spans/.test(path),
    ),
    [],
  );
  assert.ok(native.some((path) => path.includes("wordgard/dist")));
  const barrel = await graph("model/richtext-spans.mjs");
  assert.ok(
    barrel.some((path) => path.includes("prosemirror")),
    "the remaining writer barrel is not a PM-free claim",
  );
  assert.equal(typeof validateNativeSpans, "function");
});
