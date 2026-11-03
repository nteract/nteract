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
import { decode, encode, PagesDataframe } from "../viewer/wordgard-model.mjs";
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
const dataframeMarker = (extra = {}) =>
  marker("dataframe", {
    src: S(src),
    media_type: S(PARQUET_MEDIA_TYPE),
    title: S("Usage by day"),
    ...extra,
  });
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

test("a read-back line for a dataframe the block doesn't hold stays a link", () => {
  const { doc, id } = mixed();
  const other = `/api/pages/${pageId}/assets/${"f".repeat(64)}`;
  const markdown = `${projectPage(doc).blocks[0].markdown}\n\n[Dataframe: Other](${other})`;
  const { doc: after } = edit(doc, [{ op: "replace_block_markdown", block_id: id, markdown }]);
  assert.equal(dataframes(after, id).length, 1);
});

test("replace_match and set_node beside a dataframe leave it unchanged", () => {
  const { doc, id } = mixed();
  const before = dataframes(doc, id);
  const { doc: after } = edit(doc, [
    { op: "replace_match", block_id: id, match_text: "hello", replacement: "hi" },
    { op: "set_node", block_id: id, match_text: "world", heading_level: 2 },
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

test("an unreadable dataframe reports readable: false and none of its stored attrs", async () => {
  const { projectReadContent } = await import("./read-content.mjs");
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
    const entry = projectReadContent(next, {}).outline.find((item) => item.type === "dataframe");
    assert.equal(entry.readable, false, stored);
    assert.equal(entry.attrs, undefined, stored);
    const change = projectReadChanges(next, { since_heads: heads, comments: "none" }).changes.find(
      (item) => item.type === "dataframe",
    );
    assert.equal(change.readable, false, stored);
    assert.equal(change.attrs, undefined, stored);
    // An outline entry carries no Markdown, so nothing of the stored src.
    assert.ok(!JSON.stringify(entry).includes(stored), stored);
  }
});
