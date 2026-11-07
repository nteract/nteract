import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  createPageData,
  initializePage,
  applyPageOperation,
  orderedBlockIds,
  projectPage,
  validateNodeInsertion,
} from "./page.mjs";
import { textPath, validateRich } from "./richtext.mjs";
import { documentFeatures } from "./schema-features.mjs";
import { decode, encode, PagesDataframe } from "./wordgard-doc.mjs";
import { PARQUET_MEDIA_TYPE } from "../shared/dataset-assets.mjs";

const pageId = "33333333-3333-4333-8333-333333333333";
const assetId = "d".repeat(64);
const src = `/api/pages/${pageId}/assets/${assetId}`;
const fresh = () =>
  A.change(A.from(createPageData({ pageId })), (doc) => initializePage(doc, "Intro"));
const edit = (doc, operations) => {
  let result;
  const next = A.change(A.clone(doc), (draft) => {
    result = applyPageOperation(draft, { operation: "edit_page", arguments: { operations } });
  });
  return { doc: next, result };
};
const dataframe = (attrs = {}) => ({
  op: "insert_node",
  node: { type: "dataframe", attrs: { asset_id: assetId, title: "Usage by day", ...attrs } },
});

test("insert_node writes one dataframe marker in its own block and stamps the feature", () => {
  const { doc, result } = edit(fresh(), [dataframe()]);
  const [, id] = orderedBlockIds(doc);
  assert.deepEqual(result.inserted_nodes, [
    {
      block_id: id,
      type: "dataframe",
      attrs: { asset_id: assetId, src, media_type: PARQUET_MEDIA_TYPE, title: "Usage by day" },
    },
  ]);
  const spans = A.spans(doc, textPath(id));
  assert.equal(spans.length, 1);
  assert.equal(String(spans[0].value.type), "dataframe");
  assert.equal(spans[0].value.isEmbed, false);
  assert.deepEqual(
    Object.fromEntries(Object.entries(spans[0].value.attrs).map(([k, v]) => [k, String(v)])),
    { src, media_type: PARQUET_MEDIA_TYPE, title: "Usage by day" },
  );
  for (const value of Object.values(spans[0].value.attrs))
    assert.equal(A.isImmutableString(value), true);
  validateRich(doc.blocks[id]);
  assert.ok(documentFeatures(doc).includes("dataframe"));
});

test("a dataframe reads back as a labeled link, never as a code block", () => {
  const { doc } = edit(fresh(), [dataframe({ title: "Usage [by] day" })]);
  const block = projectPage(doc).blocks[1];
  assert.equal(block.markdown, `[Dataframe: Usage \\[by\\] day](${src})`);
  const untitled = edit(fresh(), [dataframe({ title: undefined })]).doc;
  assert.equal(projectPage(untitled).blocks[1].markdown, `[Dataframe](${src})`);
});

test("the editor decodes and re-encodes a dataframe to the same marker", () => {
  const { doc } = edit(fresh(), [dataframe()]);
  const [, id] = orderedBlockIds(doc);
  const spans = A.spans(doc, textPath(id));
  const decoded = decode(spans).doc;
  assert.equal(decoded.firstChild.type, PagesDataframe);
  assert.deepEqual(decoded.firstChild.param, {
    src,
    media_type: PARQUET_MEDIA_TYPE,
    title: "Usage by day",
  });
  const reencoded = encode(decoded);
  assert.equal(reencoded.length, 1);
  assert.equal(String(reencoded[0].value.type), "dataframe");
  // Writing the editor's spans back changes nothing.
  const after = A.change(A.clone(doc), (draft) =>
    A.updateSpans(draft, textPath(id), reencoded, { expand: "none" }),
  );
  assert.deepEqual(A.getHeads(after), A.getHeads(doc));
});

test("replace_block_markdown refuses a block holding a dataframe", () => {
  const { doc } = edit(fresh(), [dataframe()]);
  const [, id] = orderedBlockIds(doc);
  assert.throws(
    () => edit(doc, [{ op: "replace_block_markdown", block_id: id, markdown: "gone" }]),
    (error) => error.code === "markdownless_node" && /no Markdown form/.test(error.message),
  );
  // Deleting the block is still allowed.
  const deleted = edit(doc, [{ op: "delete_block", block_id: id }]).doc;
  assert.equal(orderedBlockIds(deleted).length, 1);
});

test("Markdown never creates a dataframe", () => {
  const { doc } = edit(fresh(), [
    {
      op: "insert_markdown",
      markdown: `[Dataframe: Usage](${src})\n\n\`\`\`dataframe\n{}\n\`\`\``,
    },
  ]);
  const [, id] = orderedBlockIds(doc);
  assert.equal(
    A.spans(doc, textPath(id)).some((span) => String(span.value?.type) === "dataframe"),
    false,
  );
  assert.equal(documentFeatures(doc).includes("dataframe"), false);
});

test("insert_node refuses malformed operations before touching the Page", () => {
  for (const op of [
    { op: "insert_node" },
    { op: "insert_node", node: { type: "image", attrs: { asset_id: assetId } } },
    { op: "insert_node", node: { type: "dataframe", attrs: {} } },
    { op: "insert_node", node: { type: "dataframe", attrs: { asset_id: "x" } } },
    dataframe({ media_type: "text/csv" }),
    dataframe({ src: "https://example.com/x.parquet" }),
    dataframe({ title: "x".repeat(201) }),
    { ...dataframe(), extra: true },
    { ...dataframe(), after_block_id: "" },
  ]) {
    assert.throws(() => validateNodeInsertion(op), JSON.stringify(op));
    assert.throws(() => edit(fresh(), [op]), JSON.stringify(op));
  }
});

test("a stored dataframe with a foreign src fails validation", () => {
  const { doc } = edit(fresh(), [dataframe()]);
  const [, id] = orderedBlockIds(doc);
  const tampered = A.change(A.clone(doc), (draft) => {
    const spans = A.spans(draft, textPath(id));
    spans[0].value.attrs.src = new A.ImmutableString("https://example.com/x.parquet");
    A.updateSpans(draft, textPath(id), spans, { expand: "none" });
  });
  assert.throws(() => validateRich(tampered.blocks[id]), /Page asset path/);
});

const S = (value) => new A.ImmutableString(value);
const marker = (type, attrs = {}, parents = [], isEmbed = false) => ({
  type: "block",
  value: { type: S(type), parents: parents.map(S), attrs, isEmbed },
});
const dataframeMarker = (extra = {}, parents = []) =>
  marker(
    "dataframe",
    {
      src: S(src),
      media_type: S(PARQUET_MEDIA_TYPE),
      title: S("Usage by day"),
      ...extra,
    },
    parents,
  );
/** The text index of the block's first dataframe marker. */
const dataframeIndex = (doc, id) => {
  let at = 0;
  for (const span of A.spans(doc, textPath(id))) {
    if (span.type === "block" && String(span.value.type) === "dataframe") return at;
    at += span.type === "block" ? 1 : span.value.length;
  }
  return -1;
};
/** A block holding prose, a dataframe and more prose, as a browser drop makes. */
function mixed(spans = [dataframeMarker()]) {
  const doc = fresh();
  const [id] = orderedBlockIds(doc);
  const next = A.change(A.clone(doc), (draft) =>
    A.updateSpans(
      draft,
      textPath(id),
      [
        marker("paragraph"),
        { type: "text", value: "hello" },
        ...spans,
        marker("paragraph"),
        { type: "text", value: "world" },
      ],
      { expand: "none" },
    ),
  );
  return { doc: next, id };
}
const dataframes = (doc, id) =>
  A.spans(doc, textPath(id)).filter((span) => String(span.value?.type) === "dataframe");

test("replace_block_markdown keeps a dataframe whose read-back line is unchanged", () => {
  const { doc, id } = mixed();
  const markdown = projectPage(doc).blocks[0].markdown;
  assert.equal(markdown, `hello\n\n[Dataframe: Usage by day](${src})\n\nworld`);
  const before = dataframes(doc, id);
  const { doc: after } = edit(doc, [
    { op: "replace_block_markdown", block_id: id, markdown: markdown.replace("hello", "hi") },
  ]);
  assert.deepEqual(dataframes(after, id), before);
  assert.equal(projectPage(after).blocks[0].markdown, markdown.replace("hello", "hi"));
});

test("replace_block_markdown refuses to drop or edit a dataframe's line", () => {
  const { doc, id } = mixed();
  for (const markdown of [
    "hello\n\nworld",
    `hello\n\n[Dataframe: Renamed](${src})\n\nworld`,
    `hello [Dataframe: Usage by day](${src}) world`,
  ])
    assert.throws(
      () => edit(doc, [{ op: "replace_block_markdown", block_id: id, markdown }]),
      (error) =>
        error.code === "markdownless_node" &&
        error.message.includes(`[Dataframe: Usage by day](${src})`),
      markdown,
    );
});

test("a dataframe stored in a quote or list item echoes back there, and can't move out", () => {
  const line = `[Dataframe: Usage by day](${src})`;
  const text = (value) => ({ type: "text", value });
  for (const [label, spans] of [
    ["quote", [marker("blockquote"), dataframeMarker({}, ["blockquote"])]],
    [
      "list item",
      [marker("unordered-list-item"), text("item"), dataframeMarker({}, ["unordered-list-item"])],
    ],
  ]) {
    const { doc, id } = mixed(spans);
    const markdown = projectPage(doc).blocks[0].markdown;
    assert.ok(markdown.includes(line), label);
    assert.ok(!markdown.includes(`\n\n${line}\n\n`), `${label}: the line is inside its container`);
    const cursor = A.getCursor(doc, textPath(id), dataframeIndex(doc, id));
    for (const rewrite of [markdown, markdown.replace("hello", "hi")]) {
      const { doc: after } = edit(doc, [
        { op: "replace_block_markdown", block_id: id, markdown: rewrite },
      ]);
      assert.equal(projectPage(after).blocks[0].markdown, rewrite, label);
      assert.equal(A.getCursor(after, textPath(id), dataframeIndex(after, id)), cursor, label);
    }
    assert.throws(
      () =>
        edit(doc, [
          {
            op: "replace_block_markdown",
            block_id: id,
            markdown: `hello\n\n${line}\n\nworld`,
          },
        ]),
      (error) =>
        error.code === "markdownless_node" && /out of the quote or list item/.test(error.message),
      label,
    );
  }
});

test("a block holding two identical dataframes keeps one line for each", () => {
  const line = `[Dataframe: Usage by day](${src})`;
  const { doc, id } = mixed([dataframeMarker(), dataframeMarker()]);
  const markdown = projectPage(doc).blocks[0].markdown;
  assert.equal(markdown, `hello\n\n${line}\n\n${line}\n\nworld`);
  const { doc: after } = edit(doc, [
    { op: "replace_block_markdown", block_id: id, markdown: markdown.replace("hello", "hi") },
  ]);
  assert.equal(dataframes(after, id).length, 2);
  // Dropping one names the line and says the block holds two.
  assert.throws(
    () =>
      edit(doc, [
        {
          op: "replace_block_markdown",
          block_id: id,
          markdown: `hello\n\n${line}\n\nworld`,
        },
      ]),
    (error) =>
      error.code === "markdownless_node" &&
      error.message.includes(`${line} (the block holds 2; keep one line for each)`),
  );
  assert.throws(
    () =>
      edit(doc, [
        {
          op: "replace_block_markdown",
          block_id: id,
          markdown: `hello\n\n${line}\n\n${line}\n\n${line}\n\nworld`,
        },
      ]),
    /appears more times than the block has/,
  );
});

test("duplicate dataframe lines with different hidden attrs refuse Markdown rewrites", () => {
  const first = dataframeMarker(),
    second = dataframeMarker();
  first.value.attrs.future = "first";
  second.value.attrs.future = "second";
  const { doc, id } = mixed([first, second]);
  assert.throws(
    () =>
      edit(doc, [
        {
          op: "replace_block_markdown",
          block_id: id,
          markdown: projectPage(doc).blocks[0].markdown,
        },
      ]),
    (error) =>
      error.code === "markdownless_node" && /different hidden attributes/.test(error.message),
  );
});

test("replace_block_markdown keeps a dataframe only as its own top-level line, once", () => {
  const { doc, id } = mixed();
  const line = `[Dataframe: Usage by day](${src})`;
  const other = `[Dataframe: Other](/api/pages/${pageId}/assets/${"f".repeat(64)})`;
  const refused = (markdown, pattern) =>
    assert.throws(
      () => edit(doc, [{ op: "replace_block_markdown", block_id: id, markdown }]),
      (error) => error.code === "markdownless_node" && pattern.test(error.message),
      markdown,
    );
  // Moved into a container: refused with a code, not "Match cannot be null".
  refused(`hello\n\n- ${line}\n\nworld`, /can't go inside a quote, list or table/);
  refused(`hello\n\n> ${line}\n\nworld`, /can't go inside a quote, list or table/);
  refused(`hello\n\n| a |\n| --- |\n| ${line} |`, /can't go inside/);
  // Duplicated: refused instead of leaving a look-alike link.
  refused(`hello\n\n${line}\n\n${line}\n\nworld`, /appears more times than the block has/);
  // A line for a dataframe the block doesn't hold reads like one: refused.
  refused(`hello\n\n${line}\n\n${other}\n\nworld`, /doesn't hold/);
  // Text around the line can change; the node keeps its stored marker, the
  // same Automerge character, so a cursor on it still resolves to it.
  const before = dataframes(doc, id);
  const markerAt = (d) => {
    let at = 0;
    for (const span of A.spans(d, textPath(id))) {
      if (span.type === "block" && String(span.value.type) === "dataframe") return at;
      at += span.type === "block" ? 1 : span.value.length;
    }
    return -1;
  };
  const cursor = A.getCursor(doc, textPath(id), markerAt(doc));
  const { doc: after } = edit(doc, [
    { op: "replace_block_markdown", block_id: id, markdown: `Intro\n\nhello\n\n${line}\n\nworld` },
  ]);
  assert.deepEqual(dataframes(after, id), before);
  assert.equal(A.getCursor(after, textPath(id), markerAt(after)), cursor);
  // A line in a heading reads like the node too: refused, not kept as a link.
  refused(`# ${line}\n\nhello\n\n${line}\n\nworld`, /into a heading/);
  refused(`# ${other}\n\nhello\n\n${line}\n\nworld`, /doesn't hold/);
  // Moving the line among its neighbours keeps the node and its attrs, but
  // updateSpans writes a new marker for it.
  const { doc: reordered } = edit(doc, [
    { op: "replace_block_markdown", block_id: id, markdown: `hello\n\nworld\n\n${line}` },
  ]);
  assert.deepEqual(
    dataframes(reordered, id).map((span) => span.value),
    before.map((span) => span.value),
  );
  assert.notEqual(A.getCursor(reordered, textPath(id), markerAt(reordered)), cursor);
  // Ordinary links stay links.
  const { doc: linked } = edit(doc, [
    {
      op: "replace_block_markdown",
      block_id: id,
      markdown: `hello\n\n${line}\n\n[docs](https://example.com)`,
    },
  ]);
  assert.equal(dataframes(linked, id).length, 1);
});

test("replace_match and set_node beside a dataframe leave it unchanged", () => {
  const { doc, id } = mixed();
  const before = dataframes(doc, id);
  const { doc: after } = edit(doc, [
    { op: "replace_match", block_id: id, match_text: "hello", replacement: "hi" },
    { op: "set_node", block_id: id, match_text: "world", type: "heading", attrs: { level: 2 } },
  ]);
  assert.deepEqual(dataframes(after, id), before);
  assert.equal(
    projectPage(after).blocks[0].markdown,
    `hi\n\n[Dataframe: Usage by day](${src})\n\n## world`,
  );
});

test("a later build's dataframe attrs and media type decode, encode and survive a rewrite", () => {
  const future = dataframeMarker({ media_type: S("text/csv"), view_id: S("v1") });
  const { doc, id } = mixed([future]);
  validateRich(doc.blocks[id]);
  const spans = A.spans(doc, textPath(id));
  const decoded = decode(spans).doc;
  const leaf = decoded.content.find((node) => node.type === PagesDataframe);
  assert.equal(leaf.param.view_id, "v1");
  assert.equal(leaf.param.media_type, "text/csv");
  const written = A.change(A.clone(doc), (draft) =>
    A.updateSpans(draft, textPath(id), encode(decoded), { expand: "none" }),
  );
  // Encode writes every attr back, unknown ones included.
  const plain = (spans) =>
    spans.map((span) =>
      Object.fromEntries(Object.entries(span.value.attrs).map(([k, v]) => [k, String(v)])),
    );
  assert.deepEqual(plain(dataframes(written, id)), plain(dataframes(doc, id)));
  const markdown = projectPage(doc).blocks[0].markdown.replace("hello", "hi");
  const { doc: after } = edit(doc, [{ op: "replace_block_markdown", block_id: id, markdown }]);
  assert.deepEqual(dataframes(after, id), dataframes(doc, id));
});

test("a stored dataframe this build can't read projects a notice and refuses a rewrite", () => {
  const { doc, id } = mixed([
    marker("dataframe", { src: S("https://evil.example/x.parquet"), media_type: S("x") }),
  ]);
  const markdown = projectPage(doc).blocks[0].markdown;
  assert.equal(markdown, "hello\n\n\\[Unsupported node: dataframe\\]\n\nworld");
  assert.doesNotMatch(markdown, /evil/);
  assert.throws(
    () => edit(doc, [{ op: "replace_block_markdown", block_id: id, markdown }]),
    (error) => error.code === "markdownless_node",
  );
});

test("a stored title with a newline reads back on one line and still round-trips", () => {
  const { doc, id } = mixed([
    marker("dataframe", {
      src: S(src),
      media_type: S(PARQUET_MEDIA_TYPE),
      title: S("Usage\nby day"),
    }),
  ]);
  const markdown = projectPage(doc).blocks[0].markdown;
  assert.equal(markdown, `hello\n\n[Dataframe: Usage by day](${src})\n\nworld`);
  const { doc: after } = edit(doc, [
    { op: "replace_block_markdown", block_id: id, markdown: markdown.replace("hello", "hi") },
  ]);
  assert.deepEqual(dataframes(after, id), dataframes(doc, id));
});

test("a peer-written dataframe inside a table cell projects a notice and refuses a rewrite", () => {
  const doc = fresh();
  const [id] = orderedBlockIds(doc);
  const cell = ["table", "table-row", "table-cell"];
  const next = A.change(A.clone(doc), (draft) =>
    A.updateSpans(
      draft,
      textPath(id),
      [
        marker("table", { columns: S("[]") }),
        marker("table-row", {}, ["table"]),
        marker("table-cell", {}, ["table", "table-row"]),
        { type: "text", value: "Af" },
        marker("dataframe", { src: S(src), media_type: S(PARQUET_MEDIA_TYPE) }, cell),
        { type: "text", value: "ter" },
      ],
      { expand: "none" },
    ),
  );
  const markdown = projectPage(next).blocks[0].markdown;
  assert.match(markdown, /Unsupported node: dataframe/);
  assert.doesNotMatch(markdown, /assets/);
  assert.throws(
    () => edit(next, [{ op: "replace_block_markdown", block_id: id, markdown: "x" }]),
    (error) => error.code === "markdownless_node",
  );
  const decoded = decode(A.spans(next, textPath(id)));
  assert.equal(decoded.lossy, true);
});

test("a synced dataframe naming another Page's asset reads as a notice and refuses a rewrite", () => {
  const foreign = `/api/pages/44444444-4444-4444-8444-444444444444/assets/${"e".repeat(64)}`;
  const { doc, id } = mixed([
    marker("dataframe", { src: S(foreign), media_type: S(PARQUET_MEDIA_TYPE), title: S("Theirs") }),
  ]);
  const markdown = projectPage(doc).blocks[0].markdown;
  assert.equal(markdown, "hello\n\n\\[Unsupported node: dataframe\\]\n\nworld");
  assert.doesNotMatch(markdown, /44444444/);
  assert.throws(
    () => edit(doc, [{ op: "replace_block_markdown", block_id: id, markdown }]),
    (error) => error.code === "markdownless_node",
  );
  // replace_match beside it still works, and leaves it alone.
  const { doc: after } = edit(doc, [
    { op: "replace_match", block_id: id, match_text: "hello", replacement: "hi" },
  ]);
  assert.deepEqual(dataframes(after, id), dataframes(doc, id));
});

test("a dataframe's outline entry carries its attrs in insert_node's receipt shape", async () => {
  const { projectReadContent } = await import("./read-content.mjs");
  const { doc, result } = edit(fresh(), [dataframe()]);
  const entry = projectReadContent(doc, {}).outline.find((item) => item.type === "dataframe");
  assert.deepEqual(entry.attrs, result.inserted_nodes[0].attrs);
});

test("an unreadable dataframe exposes none of its stored attrs in typed reads", async () => {
  const { projectReadContent, nodeFields } = await import("./read-content.mjs");
  const { projectReadChanges } = await import("./read-changes.mjs");
  const base = fresh();
  const id = orderedBlockIds(base)[0];
  const heads = A.getHeads(base);
  const otherPage = `/api/pages/44444444-4444-4444-8444-444444444444/assets/${assetId}`;
  for (const stored of ["https://evil.example/x.parquet", otherPage]) {
    const next = A.change(A.clone(base), (draft) =>
      A.splitBlock(draft, textPath(id), draft.blocks[id].richText.length, {
        type: new A.ImmutableString("dataframe"),
        parents: [],
        attrs: {
          src: new A.ImmutableString(stored),
          media_type: new A.ImmutableString(PARQUET_MEDIA_TYPE),
        },
        isEmbed: false,
      }),
    );
    // richDoc reads it as a notice paragraph, so no dataframe entry exists.
    const outline = projectReadContent(next, {}).outline;
    assert.equal(
      outline.find((item) => item.type === "dataframe"),
      undefined,
      stored,
    );
    assert.ok(!JSON.stringify(outline).includes(stored), stored);
    const changes = projectReadChanges(next, { since_heads: heads, comments: "none" }).changes;
    assert.ok(!JSON.stringify(changes).includes(stored), stored);
    // The backstop, if such a node ever reaches nodeFields.
    const { PagesDataframe } = await import("./wordgard-doc.mjs");
    const node = PagesDataframe.of({ src: stored, media_type: PARQUET_MEDIA_TYPE });
    assert.deepEqual(nodeFields(node, { pageId }), { readable: false }, stored);
  }
});

test("a peer-written dataframe's title reads back normalized and bounded", async () => {
  const { projectReadContent } = await import("./read-content.mjs");
  const { DATAFRAME_TITLE_MAX } = await import("../shared/dataset-assets.mjs");
  const base = fresh();
  const id = orderedBlockIds(base)[0];
  const next = A.change(A.clone(base), (draft) =>
    A.splitBlock(draft, textPath(id), draft.blocks[id].richText.length, {
      type: new A.ImmutableString("dataframe"),
      parents: [],
      attrs: {
        src: new A.ImmutableString(src),
        media_type: new A.ImmutableString(PARQUET_MEDIA_TYPE),
        title: new A.ImmutableString(`  ${"t".repeat(DATAFRAME_TITLE_MAX + 50)}  `),
      },
      isEmbed: false,
    }),
  );
  const entry = projectReadContent(next, {}).outline.find((item) => item.type === "dataframe");
  assert.equal(entry.attrs.title.length, DATAFRAME_TITLE_MAX);
  assert.equal(entry.attrs.title.trim(), entry.attrs.title);
});
