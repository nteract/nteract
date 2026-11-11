// Two or three writers edit clones of one generated Page, each through a
// path a real writer uses (the editor's plain splices and marks, the
// editor's structural rewrite through encode, and the agent tools), then
// merge. Whatever the merge leaves, every reader reads it and they agree on
// the block's nodes, and repairing unmarked text changes no Markdown.
// Replay a failure with --test-name-pattern plus PAGES_FUZZ_SEED and
// PAGES_FUZZ_PATH.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { projectReadContent } from "./read-content.mjs";
import { blockMarkdown, textPath } from "./richtext.mjs";
import { markUnmarkedText } from "./richtext-page.mjs";
import { MISSING_ANCESTOR_CASES, addInside, deleteContainer } from "./richtext-test-support.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { stampSpans } from "./schema-features.mjs";
import { nativeRead } from "./native-read.mjs";
import { blockAddresses, nodeIndexAt } from "./node-addresses.mjs";
import { isKnownBlock, NODE_TYPES } from "./node-registry.mjs";
import { visibleNodeRange } from "./replace-match.mjs";
import { parentsValue, readSpans, updateSpansExactly } from "./richtext-format.mjs";
import { nodeIds } from "./node-ids.mjs";
import {
  storedParents,
  Blockquote,
  BulletList,
  decode,
  encode,
  HorizontalRule,
  ListItem,
  PagesImage,
  Paragraph,
  schema,
} from "./wordgard-doc.mjs";
import { PAGE_ID, pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";
import { fuzzParameters } from "../test/fuzz-parameters.mjs";
import { plainSpans } from "../test/plain-spans.mjs";
import { freeing } from "../test/free-docs.mjs";

const ACTORS = ["0a".repeat(16), "0b".repeat(16), "0c".repeat(16)];
const IMAGE = PagesImage.of({
  src: `/api/pages/${PAGE_ID}/assets/${"b".repeat(64)}`,
  alt: "merged",
  title: null,
});
const parameters = {
  ...fuzzParameters,
  numRuns: Number(process.env.PAGES_FUZZ_RUNS ?? 40),
};

function pageWith(tree) {
  let doc = A.change(A.from(createPageData({ pageId: PAGE_ID, title: "Merge" })), (draft) =>
    initializePage(draft),
  );
  const id = orderedBlockIds(doc)[0];
  const spans = encode(tree);
  doc = A.change(doc, (draft) => {
    A.updateSpans(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
  });
  return { doc, id };
}

/** Each stored text run: `{ start, end }` native offsets. */
function runs(doc, id) {
  const out = [];
  let at = 0;
  for (const span of readSpans(doc, textPath(id))) {
    if (span.type === "text") out.push({ start: at, end: at + span.value.length });
    at += span.type === "text" ? span.value.length : 1;
  }
  return out;
}

/** The editor's structural rewrite: a new top-level node list, written
 * through encode as the binding writes a structural transaction. */
function rewrite(doc, id, change) {
  const tree = decode(readSpans(doc, textPath(id))).doc;
  const content = change([...tree.content]);
  if (!content) return null;
  const spans = encode(schema.doc(content.length ? content : [Paragraph.create([])]));
  const next = A.change(doc, (draft) => {
    updateSpansExactly(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
  });
  // A writer stores exactly what it was given.
  assert.equal(canonical(plainSpans(readSpans(next, textPath(id)))), canonical(plainSpans(spans)));
  return next;
}

const tool = (doc, id, operation, op) =>
  A.change(doc, (draft) =>
    applyPageOperation(draft, {
      operation,
      arguments: { operations: [{ ...op, block_id: id }] },
    }),
  );

/** One writer's edit, chosen by `kind` with `pick` and `variant` as its
 * targets. Returns the new document, or null when it has no target. */
function edit(doc, id, { kind, pick, variant }) {
  const text = runs(doc, id);
  const run = text.length ? text[pick % text.length] : null;
  switch (kind) {
    case "type": {
      if (!run) return null;
      const at = run.start + (variant % (run.end - run.start + 1));
      return A.change(doc, (draft) => A.splice(draft, textPath(id), at, 0, "zz"));
    }
    case "delete-text": {
      if (!run || run.end - run.start < 2) return null;
      const from = run.start + (variant % (run.end - run.start - 1));
      return A.change(doc, (draft) => A.splice(draft, textPath(id), from, 1 + (pick % 2)));
    }
    case "bold": {
      if (!run) return null;
      return A.change(doc, (draft) =>
        A.mark(
          draft,
          textPath(id),
          { start: run.start, end: run.end, expand: "after" },
          "strong",
          true,
        ),
      );
    }
    case "delete-node": {
      // The node holding the text run another writer's same pick types in.
      const ids = nodeIds(doc, id);
      if (ids.length < 2) return null;
      const index = run
        ? nodeIndexAt(blockAddresses(readSpans(doc, textPath(id))), run.start)
        : pick % ids.length;
      if (!ids[index].id) return null;
      return tool(doc, id, "edit_page", { op: "delete_node", node_id: ids[index].id });
    }
    case "set-node":
    case "format": {
      const words = readSpans(doc, textPath(id))
        .flatMap((span) => (span.type === "text" ? span.value.split(/\s+/) : []))
        .filter((word) => /^[A-Za-z]{3,}$/.test(word));
      if (!words.length) return null;
      const match_text = words[pick % words.length];
      const op =
        kind === "set-node"
          ? { op: "set_node", match_text, type: "heading", attrs: { level: 1 + (variant % 3) } }
          : { op: "format_match", match_text, add: { em: true } };
      return tool(doc, id, "patch_page", op);
    }
    case "image":
      return rewrite(doc, id, (content) => {
        const i = pick % content.length;
        if (content[i].type !== Paragraph.type) return null;
        const children = [...content[i].content];
        children.splice(variant % (children.length + 1), 0, IMAGE);
        content[i] = Paragraph.create(children);
        return content;
      });
    case "rule":
      return rewrite(doc, id, (content) => {
        content.splice((pick % content.length) + 1, 0, HorizontalRule);
        return content;
      });
    case "enter":
      return rewrite(doc, id, (content) => {
        const i = pick % content.length;
        const node = content[i];
        if (node.type !== Paragraph.type || node.content.length < 2) return null;
        const at = 1 + (variant % (node.content.length - 1));
        content.splice(
          i,
          1,
          Paragraph.create(node.content.slice(0, at)),
          Paragraph.create(node.content.slice(at)),
        );
        return content;
      });
    case "backspace":
      return rewrite(doc, id, (content) => {
        const i = 1 + (pick % Math.max(1, content.length - 1));
        if (i >= content.length) return null;
        const [before, node] = [content[i - 1], content[i]];
        if (before.type !== Paragraph.type || node.type !== Paragraph.type) return null;
        content.splice(i - 1, 2, Paragraph.create([...before.content, ...node.content]));
        return content;
      });
    case "quote":
      return rewrite(doc, id, (content) => {
        const i = pick % content.length;
        if (content[i].type === Blockquote.type) content.splice(i, 1, ...content[i].content);
        else if (content[i].type === Paragraph.type) content[i] = Blockquote.create([content[i]]);
        else return null;
        return content;
      });
    case "indent":
      return rewrite(doc, id, (content) => {
        const i = pick % content.length;
        const list = content[i];
        if (list.type !== BulletList.type || list.content.length < 2) return null;
        const items = [...list.content];
        const k = 1 + (variant % (items.length - 1));
        const moved = items.splice(k, 1)[0];
        items[k - 1] = ListItem.create([...items[k - 1].content, BulletList.create([moved])]);
        content[i] = BulletList.create(items);
        return content;
      });
    default:
      throw Error(kind);
  }
}

const KINDS = [
  "type",
  "delete-text",
  "bold",
  "delete-node",
  "set-node",
  "format",
  "image",
  "rule",
  "enter",
  "backspace",
  "quote",
  "indent",
];
// Small picks, so writers often target the same node and their edits meet.
const intent = (kinds) =>
  fc.record({
    kind: fc.constantFrom(...kinds),
    pick: fc.nat({ max: 2 }),
    variant: fc.nat({ max: 5 }),
  });
// A marker's parents are an Automerge list, and two writers that change the
// same marker's parents at once (both indenting one list item) merge into
// parents no writer wrote (["table", "table"]). Readers draw such a block,
// lossy ("two writers that indent the same list item" and the random-marker
// property below); this property checks lossless merges, so only the first
// writer changes parents here.
const NESTING = new Set(["quote", "indent"]);
const writers = fc
  .tuple(
    fc.array(intent(KINDS), { minLength: 1, maxLength: 3 }),
    fc.array(
      fc.array(intent(KINDS.filter((kind) => !NESTING.has(kind))), { minLength: 1, maxLength: 3 }),
      { minLength: 1, maxLength: 2 },
    ),
  )
  .map(([first, rest]) => [first, ...rest]);

// Refusals a tool gives a valid target; the writer then skips that edit.
const refused = (error) =>
  error.code === "nodes_would_join" ||
  error.code === "node_not_found" ||
  /applies to .+; match_text is in |not found|no match|matches; exactly one|can't format text inside a code block/i.test(
    error.message,
  );

function write(doc, id, list) {
  for (const entry of list) {
    let next = null;
    try {
      next = edit(doc, id, entry);
    } catch (error) {
      if (!refused(error)) throw error;
    }
    if (next) doc = next;
  }
  return doc;
}

// JSON with object keys sorted: a merge orders attrs keys by arrival.
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

const permutations = (items) =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

/** What every reader says about block `id`: they must not throw, and they
 * must agree on the number of top-level nodes and their types. */
function readAll(doc, id, label, options) {
  try {
    return readEvery(doc, id, label, options);
  } catch (error) {
    throw Object.assign(Error(`${error.message}\n${label}`), { cause: error });
  }
}
function readEvery(doc, id, label, { lossy = false } = {}) {
  const spans = readSpans(doc, textPath(id));
  const decoded = decode(spans);
  if (!lossy) assert.equal(decoded.lossy, false, label);
  const tree = decoded.doc;
  const native = nativeRead(doc.blocks[id], PAGE_ID).nodes;
  const addresses = blockAddresses(spans);
  if (!lossy) assert.equal(addresses.placed, true, label);
  const outline = projectReadContent(doc, {}).outline.filter((entry) => entry.block_id === id);
  const markdown = blockMarkdown(doc.blocks[id], PAGE_ID);
  assert.equal(typeof markdown, "string", label);
  // A block holding a node this build can't place gives no ids
  // (node-ids.mjs); its outline lists the agent reader's nodes.
  if (!addresses.placed) {
    assert.ok(
      outline.every((entry) => entry.node_id === null),
      label,
    );
    return { decoded, markdown, ids: [] };
  }
  // A container this build doesn't know holds nodes in the agent reader and
  // none in decode; where that makes their nodes differ, the outline gives no
  // ids and node_index refuses the block rather than address the wrong node.
  const unknownNames = spans.some(
    (span) =>
      span.type === "block" &&
      [span.value.type, ...storedParents(span.value)].some((name) => !isKnownBlock(name)),
  );
  const ids = nodeIds(doc, id);
  if (
    unknownNames &&
    (outline.length !== addresses.nodes.length ||
      (outline.every((entry) => entry.node_id === null) && ids.some((entry) => entry.id !== null)))
  ) {
    assert.throws(() => visibleNodeRange(doc, id, 0), /node_index can't address this block/, label);
    return { decoded, markdown, ids: [] };
  }
  // Otherwise the agent outline and the node addresses agree on the nodes,
  // in order.
  assert.equal(outline.length, addresses.nodes.length, label);
  assert.equal(ids.length, addresses.nodes.length, label);
  assert.deepEqual(
    outline.map((entry) => entry.node_id),
    ids.map((entry) => entry.id),
    label,
  );
  if (lossy) return { decoded, markdown, ids };
  const types = tree.content.map((node) => node.type.name);
  assert.deepEqual(
    native.map((node) => node.type.name),
    types,
    label,
  );
  assert.equal(ids.length, types.length, label);
  // An id is null only for a paragraph of unmarked text.
  for (const [index, entry] of ids.entries())
    if (entry.id === null) assert.equal(types[index], "Paragraph", label);
  return { decoded, markdown, ids };
}

test("whatever a merge of writers leaves, every reader reads it and repair changes no Markdown", () => {
  fc.assert(
    fc.property(pageTreeArbitrary({ maxDepth: 2 }), writers, (description, writers) =>
      freeing((keep) => {
        const { doc, id } = pageWith(toWordgardTree(description));
        keep(doc);
        const peers = writers.map((list, i) =>
          keep(write(A.clone(doc, { actor: ACTORS[i] }), id, list)),
        );
        let merged = null;
        let stored = null;
        for (const order of permutations(peers)) {
          const result = keep(
            order.slice(1).reduce((left, right) => A.merge(left, right), A.clone(order[0])),
          );
          const spans = canonical(plainSpans(readSpans(result, textPath(id))));
          if (stored === null) [merged, stored] = [result, spans];
          else assert.equal(spans, stored);
        }
        const label = JSON.stringify({ writers, spans: JSON.parse(stored) });
        const before = readAll(merged, id, label);
        const repaired = keep(
          A.change(A.clone(merged), (draft) => {
            assert.equal(markUnmarkedText(draft, id), before.decoded.unmarked.length > 0, label);
          }),
        );
        const after = readAll(repaired, id, label);
        assert.deepEqual(after.decoded.unmarked, [], label);
        assert.equal(after.markdown, before.markdown, label);
        assert.ok(
          after.ids.every((entry) => typeof entry.id === "string"),
          label,
        );
        // Ids that existed before the repair keep naming the same nodes.
        for (const [index, entry] of before.ids.entries())
          if (entry.id !== null) assert.equal(after.ids[index].id, entry.id, label);
        A.change(A.clone(repaired), (draft) =>
          assert.equal(markUnmarkedText(draft, id), false, label),
        );
      }),
    ),
    parameters,
  );
});

test("a container a merge leaves with no marker reads in every reader, and repair leaves it as it is", () => {
  for (const [name, { markdown, markers }] of Object.entries(MISSING_ANCESTOR_CASES))
    freeing((keep) => {
      const doc = keep(
        A.change(A.from(createPageData({ pageId: PAGE_ID, title: "Merge" })), (draft) =>
          initializePage(draft, markdown),
        ),
      );
      const id = orderedBlockIds(doc)[0];
      const path = textPath(id);
      const deleted = keep(
        A.change(A.clone(doc, { actor: ACTORS[0] }), (draft) => deleteContainer(draft, path)),
      );
      const added = keep(
        A.change(A.clone(doc, { actor: ACTORS[1] }), (draft) => addInside(draft, path, markers)),
      );
      const merged = keep(A.merge(A.clone(deleted), added));
      const before = readAll(merged, id, name);
      if (name !== "table row") assert.ok(before.decoded.rebuilt.length, name);
      assert.match(before.markdown, /new/, name);
      // A container with no marker of its own is named by its first child's.
      assert.ok(
        before.ids.every((entry) => typeof entry.id === "string"),
        name,
      );
      const repaired = keep(
        A.change(A.clone(merged), (draft) => {
          markUnmarkedText(draft, id);
        }),
      );
      const after = readAll(repaired, id, name);
      assert.deepEqual(after.decoded.rebuilt, before.decoded.rebuilt, name);
      assert.equal(after.markdown, before.markdown, name);
      assert.deepEqual(
        after.ids.map((entry) => entry.id),
        before.ids.map((entry) => entry.id),
        name,
      );
    });
});

test("two writers that mark the same unmarked text at once leave an empty paragraph anyone can delete", () =>
  freeing((keep) => {
    // Known limit: each writer inserts its own marker before the text, both
    // survive the merge, and the first opens an empty paragraph.
    const doc = keep(
      A.change(A.from(createPageData({ pageId: PAGE_ID, title: "Merge" })), (draft) =>
        initializePage(draft, "Intro words\n\nSecond"),
      ),
    );
    const id = orderedBlockIds(doc)[0];
    const path = textPath(id);
    const text = doc.blocks[id].richText;
    const unmarked = keep(
      A.merge(
        A.change(A.clone(doc, { actor: ACTORS[0] }), (draft) =>
          A.splice(draft, path, 0, text.indexOf("Second") - 1),
        ),
        A.change(A.clone(doc, { actor: ACTORS[1] }), (draft) =>
          A.splice(draft, path, text.indexOf(" words") + 6, 0, " typed"),
        ),
      ),
    );
    assert.equal(decode(readSpans(unmarked, path)).unmarked.length, 1);
    // A host write and a second writer\'s repair, each from the same snapshot.
    const host = keep(
      tool(A.clone(unmarked, { actor: ACTORS[0] }), id, "patch_page", {
        op: "format_match",
        match_text: "Second",
        add: { strong: true },
      }),
    );
    const other = keep(
      A.change(A.clone(unmarked, { actor: ACTORS[2] }), (draft) => markUnmarkedText(draft, id)),
    );
    const merged = keep(A.merge(A.clone(host), other));
    const read = readAll(merged, id, "both repairs");
    assert.deepEqual(read.decoded.unmarked, []);
    assert.equal(
      String(read.decoded.doc),
      `Doc(Paragraph(),Paragraph(" typed"),Paragraph("Second"[Strong]))`,
    );
    assert.equal(read.markdown, " typed\n\n**Second**");
    // An agent deletes the empty paragraph by its node id.
    const cleaned = keep(
      tool(A.clone(merged), id, "edit_page", { op: "delete_node", node_id: read.ids[0].id }),
    );
    assert.equal(
      String(decode(readSpans(cleaned, path)).doc),
      `Doc(Paragraph(" typed"),Paragraph("Second"[Strong]))`,
    );
    assert.equal(readAll(cleaned, id, "cleaned").markdown, read.markdown);
  }));

// Marker parents, written as lists. Both cases leave parents no writer wrote
// and a block decode refuses ("Node type Table cannot contain child Table").
const S = (value) => new A.ImmutableString(value);
const marker = (type, parents) => ({
  type: "block",
  value: { type: S(type), parents: parents.map(S), attrs: {}, isEmbed: false },
});
const nested = (outer) => [
  ...outer.map((type, i) => marker(type, outer.slice(0, i))),
  marker("table", outer),
  marker("table-row", [...outer, "table"]),
  marker("table-header", [...outer, "table", "table-row"]),
  { type: "text", value: "a" },
  marker("table-row", [...outer, "table"]),
  marker("table-cell", [...outer, "table", "table-row"]),
  { type: "text", value: "b" },
];
const parentsOf = (doc) =>
  readSpans(doc, ["text"]).flatMap((span) =>
    span.type === "block" ? [span.value.parents.map(String)] : [],
  );

/** A Page whose one block stores `spans` exactly. */
function pageWithSpans(spans) {
  let doc = A.change(A.from(createPageData({ pageId: PAGE_ID, title: "Spans" })), (draft) =>
    initializePage(draft),
  );
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (draft) => {
    updateSpansExactly(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
  });
  return { doc, id };
}

/** `spans` with each marker's parents in their stored form, one string. */
const stored = (spans) =>
  spans.map((span) =>
    span.type === "block"
      ? { ...span, value: { ...span.value, parents: parentsValue(span.value.parents) } }
      : span,
  );
const written = (spans) =>
  spans.flatMap((span) => (span.type === "block" ? [span.value.parents.map(String)] : []));
const key = (parents) => parents.join("/");

test("a structural write stores the parents it is given, and a miswritten block still reads", () => {
  // Automerge 3.5's updateSpans, on a rewrite that drops an outer container,
  // stores a table row's parents as [table, table] when parents are lists.
  const before = nested(["blockquote", "ordered-list-item"]);
  const after = nested(["ordered-list-item"]);
  let raw = A.change(A.from({ text: "" }), (d) => A.updateSpans(d, ["text"], before));
  raw = A.change(raw, (d) => A.updateSpans(d, ["text"], after));
  assert.notDeepEqual(parentsOf(raw), written(after));
  // Stored as one string each, updateSpans alone stores what it is given.
  let scalar = A.change(A.from({ text: "" }), (d) => A.updateSpans(d, ["text"], stored(before)));
  const row = A.getCursor(scalar, ["text"], 7);
  scalar = A.change(scalar, (d) => A.updateSpans(d, ["text"], stored(after)));
  assert.deepEqual(parentsOf(scalar), written(after));
  assert.equal(typeof A.getCursorPosition(scalar, ["text"], row), "number");
  // The miswritten spans still read in every reader: the repeated table
  // drops out.
  const { doc, id } = pageWithSpans(readSpans(raw, ["text"]));
  const read = readAll(doc, id, "miswritten", { lossy: true });
  assert.equal(read.decoded.lossy, true);
  assert.equal(String(read.decoded.doc.content[0].type.name), "OrderedList");
});

/** Two writers rewrite one block from `base`, as `a` and `b`, at once. */
function concurrently(base, a, b) {
  const start = A.change(A.from({ text: "" }), (d) => updateSpansExactly(d, ["text"], base));
  const write = (actor, spans) =>
    A.change(A.clone(start, { actor }), (d) => updateSpansExactly(d, ["text"], spans));
  const merged = A.merge(write(ACTORS[0], a), write(ACTORS[1], b));
  // A marker's parents merge as one value: each marker holds parents one
  // writer gave some marker, never a mix of both.
  const given = new Set([...written(a), ...written(b)].map(key));
  for (const parents of parentsOf(merged)) assert.ok(given.has(key(parents)), key(parents));
  return pageWithSpans(readSpans(merged, ["text"]));
}

test("two writers that indent the same list item at once leave a block every reader reads", () => {
  const indented = nested(["unordered-list-item", "unordered-list-item"]);
  const { doc, id } = concurrently(nested(["unordered-list-item"]), indented, indented);
  const read = readAll(doc, id, "concurrent indent", { lossy: true });
  // Both writers insert the marker the indent shifts in, so the table's
  // first row gains an empty header cell.
  assert.equal(read.decoded.lossy, false);
  assert.equal(read.markdown, "- \n  - \n    |  | a |\n    | --- | --- |\n    | b |  |");
  assert.deepEqual(
    readSpans(doc, textPath(id)).filter((span) => String(span.value?.type) === "table-header")
      .length,
    2,
  );
});

const items = (depths, outer = []) =>
  depths.flatMap((depth, i) => {
    const around = [...outer, ...Array(depth).fill("unordered-list-item")];
    return [
      marker("unordered-list-item", around),
      marker("paragraph", [...around, "unordered-list-item"]),
      { type: "text", value: `item ${i}` },
    ];
  });

test("one writer indents list items while another quotes the list: one writer's parents win", () => {
  const indent = items([0, 1, 1]);
  const quote = [marker("blockquote", []), ...items([0, 0, 0], ["blockquote"])];
  const { doc, id } = concurrently(items([0, 0, 0]), indent, quote);
  const read = readAll(doc, id, "indent and quote", { lossy: true });
  assert.equal(read.decoded.lossy, false);
  // Each changed marker keeps the parents of the writer whose change sorts
  // last; here the quote's, so the indents are lost.
  assert.equal(read.markdown, "> - item 0\n> - item 1\n> - item 2");
});

test("two writers that indent different list items at once both keep their indent", () => {
  const { doc, id } = concurrently(items([0, 0, 0]), items([0, 1, 0]), items([0, 0, 1]));
  const read = readAll(doc, id, "different indents", { lossy: true });
  assert.equal(read.decoded.lossy, false);
  assert.equal(read.markdown, "- item 0\n  - item 1\n  - item 2");
});

// Random marker values: names from the registry and junk, in any order and
// any parents, as any client can store them through sync. Every reader
// returns, and they agree on the block's nodes.
const NAMES = [
  // An aside has no Markdown form: read_page refuses it by design.
  ...NODE_TYPES.map((type) => type.block).filter(
    (name) => !["image", "dataframe", "aside"].includes(name),
  ),
  "pages-future",
  "",
  "table",
  "table-row",
];
const nameOf = fc.oneof(fc.constantFrom(...NAMES), fc.string({ maxLength: 4 }));
const parentsArb = fc.oneof(
  { weight: 6, arbitrary: fc.array(nameOf, { maxLength: 5 }) },
  { weight: 1, arbitrary: fc.constantFrom(null, "table", 3, { 0: "table" }) },
);
const spanArb = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom("x", "two words", "").map((value) => ({ type: "text", value })),
  },
  {
    weight: 4,
    arbitrary: fc
      .record({ type: nameOf, parents: parentsArb, embed: fc.boolean() })
      .map(({ type, parents, embed }) => ({
        type: "block",
        value: {
          type: new A.ImmutableString(type),
          parents: Array.isArray(parents)
            ? parents.map((parent) => new A.ImmutableString(parent))
            : parents,
          attrs: type === "heading" ? { level: 2 } : {},
          isEmbed: embed && type === "hard-break",
        },
      })),
  },
);

test("random marker parents and types read in every reader, which agree on the nodes", () => {
  fc.assert(
    fc.property(fc.array(spanArb, { maxLength: 10 }), (spans) =>
      freeing((keep) => {
        let stored;
        try {
          stored = pageWithSpans(spans.filter((span) => span.type !== "text" || span.value));
        } catch {
          // Automerge refuses the value itself: nothing is stored.
          return;
        }
        keep(stored.doc);
        readAll(stored.doc, stored.id, JSON.stringify(spans), { lossy: true });
      }),
    ),
    { ...parameters, numRuns: Number(process.env.PAGES_FUZZ_RUNS ?? 200) },
  );
});
