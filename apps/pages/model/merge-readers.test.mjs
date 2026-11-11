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
import { nodeIds } from "./node-ids.mjs";
import {
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
  for (const span of A.spans(doc, textPath(id))) {
    if (span.type === "text") out.push({ start: at, end: at + span.value.length });
    at += span.type === "text" ? span.value.length : 1;
  }
  return out;
}

/** The editor's structural rewrite: a new top-level node list, written
 * through encode as the binding writes a structural transaction. */
function rewrite(doc, id, change) {
  const tree = decode(A.spans(doc, textPath(id))).doc;
  const content = change([...tree.content]);
  if (!content) return null;
  const spans = encode(schema.doc(content.length ? content : [Paragraph.create([])]));
  const next = A.change(A.clone(doc), (draft) => {
    A.updateSpans(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
  });
  // Automerge 3.5's updateSpans can store a marker's parents other than the
  // ones it was given when a rewrite shifts the parents of several markers
  // (see "updateSpans stores the parents it is given" below). That write is
  // a writer's bug, not a merge result, so this property leaves it out.
  if (canonical(plainSpans(A.spans(next, textPath(id)))) !== canonical(plainSpans(spans)))
    return null;
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
        ? nodeIndexAt(blockAddresses(A.spans(doc, textPath(id))), run.start)
        : pick % ids.length;
      if (!ids[index].id) return null;
      return tool(doc, id, "edit_page", { op: "delete_node", node_id: ids[index].id });
    }
    case "set-node":
    case "format": {
      const words = A.spans(doc, textPath(id))
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
// parents no writer wrote (["table", "table"]; the todo test "two writers
// that indent the same list item" below). Until a marker's parents merge as
// one value, only the first writer changes parents here.
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
function readAll(doc, id, label) {
  try {
    return readEvery(doc, id, label);
  } catch (error) {
    throw Object.assign(Error(`${error.message}\n${label}`), { cause: error });
  }
}
function readEvery(doc, id, label) {
  const spans = A.spans(doc, textPath(id));
  const decoded = decode(spans);
  assert.equal(decoded.lossy, false, label);
  const tree = decoded.doc;
  const native = nativeRead(doc.blocks[id], PAGE_ID).nodes;
  const addresses = blockAddresses(spans);
  assert.equal(addresses.placed, true, label);
  const ids = nodeIds(doc, id);
  const outline = projectReadContent(doc, {}).outline.filter((entry) => entry.block_id === id);
  const markdown = blockMarkdown(doc.blocks[id], PAGE_ID);
  const types = tree.content.map((node) => node.type.name);
  assert.deepEqual(
    native.map((node) => node.type.name),
    types,
    label,
  );
  for (const count of [addresses.nodes.length, ids.length, outline.length])
    assert.equal(count, types.length, label);
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
          const spans = canonical(plainSpans(A.spans(result, textPath(id))));
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
    assert.equal(decode(A.spans(unmarked, path)).unmarked.length, 1);
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
      String(decode(A.spans(cleaned, path)).doc),
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
  A.spans(doc, ["text"]).flatMap((span) =>
    span.type === "block" ? [span.value.parents.map(String)] : [],
  );

test(
  "updateSpans stores the parents it is given",
  {
    todo: "Automerge 3.5 updateSpans: a rewrite that drops an outer container writes table-row parents [table, table]",
  },
  () => {
    let doc = A.change(A.from({ text: "" }), (d) =>
      A.updateSpans(d, ["text"], nested(["blockquote", "ordered-list-item"])),
    );
    doc = A.change(doc, (d) => A.updateSpans(d, ["text"], nested(["ordered-list-item"])));
    assert.deepEqual(
      parentsOf(doc),
      nested(["ordered-list-item"]).flatMap((span) =>
        span.type === "block" ? [span.value.parents.map(String)] : [],
      ),
    );
  },
);

test(
  "two writers that indent the same list item at once merge into parents one of them wrote",
  { todo: "Marker parents merge element by element: both indents survive as [..., table, table]" },
  () => {
    const base = A.change(A.from({ text: "" }), (d) =>
      A.updateSpans(d, ["text"], nested(["unordered-list-item"])),
    );
    const indent = (actor) =>
      A.change(A.clone(base, { actor }), (d) =>
        A.updateSpans(d, ["text"], nested(["unordered-list-item", "unordered-list-item"])),
      );
    const merged = A.merge(indent(ACTORS[0]), indent(ACTORS[1]));
    assert.doesNotThrow(() => decode(A.spans(merged, ["text"])));
  },
);
