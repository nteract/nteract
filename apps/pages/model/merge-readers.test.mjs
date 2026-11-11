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
import {
  applyPageOperation,
  createPageData,
  initializePage,
  orderedBlockIds,
  projectPage,
} from "./page.mjs";
import { projectReadChanges } from "./read-changes.mjs";
import { guardPassageEdits } from "./passage-edits.mjs";
import { surfaceRead } from "./page-surface-read.mjs";
import { readMarkdown } from "./native-read.mjs";
import { imageIds } from "./image-ids.mjs";
import { commentBodyProjection } from "./comment-read.mjs";
import { commentDraftsMarkdown, pageMarkdown } from "./markdown-export.mjs";
import { blockPreview } from "./page-preview.mjs";
import { cardContent } from "./page-card.mjs";
import { openingTitleWarning } from "./title-warning.mjs";
import { shellBlocks } from "../viewer/card-shell.mjs";
import { projectReadContent } from "./read-content.mjs";
import { blockMarkdown, textPath } from "./richtext.mjs";
import { repairBlockMarkers } from "./richtext-page.mjs";
import {
  ADJUSTED_NESTING_CASES,
  ADJUSTED_NESTING_WORDS,
  MISSING_ANCESTOR_CASES,
  SHADOWED,
  UNREADABLE_MARKERS,
  UNREADABLE_MARKS,
  addInside,
  deleteContainer,
  nestedTable,
} from "./richtext-test-support.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { stampSpans } from "./schema-features.mjs";
import { nativeRead, nativeReadSpans } from "./native-read.mjs";
import { blockAddresses, nodeIndexAt } from "./node-addresses.mjs";
import { isKnownBlock, NODE_TYPES } from "./node-registry.mjs";
import { visibleNodeRange } from "./replace-match.mjs";
import { updateSpansExactly } from "./richtext-format.mjs";
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
  PagesUnknownBlock,
  PagesUnknownEmbed,
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
  const next = A.change(doc, (draft) => {
    updateSpansExactly(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
  });
  // A writer stores exactly what it was given.
  assert.equal(canonical(plainSpans(A.spans(next, textPath(id)))), canonical(plainSpans(spans)));
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
// Every writer may quote and indent. A marker's parents are an Automerge
// list, and two writers that change the same marker's parents at once merge
// into parents no writer wrote (["table", "table"]): readers draw the block
// with adjusted nesting, and repair stores what they drew.
const writers = fc
  .tuple(
    fc.array(intent(KINDS), { minLength: 1, maxLength: 3 }),
    fc.array(fc.array(intent(KINDS), { minLength: 1, maxLength: 3 }), {
      minLength: 1,
      maxLength: 2,
    }),
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
  const spans = A.spans(doc, textPath(id));
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
  // Content from a newer build (a container this build doesn't know, a
  // marker value it can't read) can read as different nodes in the agent
  // reader and decode; where it does, the outline gives no ids and
  // node_index refuses the block rather than address the wrong node.
  const unknownNames =
    decoded.newer ||
    spans.some(
      (span) =>
        span.type === "block" &&
        [span.value?.type, ...storedParents(span.value)].some((name) => !isKnownBlock(name)),
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
  // Without newer content, the agent reader and decode draw the same
  // top-level nodes, nesting adjusted or not.
  if (decoded.newer) return { decoded, markdown, ids };
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

/** The readers past the block: the change feed, the card and preview, the
 * title warning, the Markdown export, a comment holding the same spans and an
 * unsent draft of them. None may throw; returns what they show (all but the
 * draft) as text, so a test can check no unsafe value reaches it. */
function readOthers(doc, id, since) {
  const out = [];
  const show = (value) => out.push(JSON.stringify(value ?? null));
  show(projectReadChanges(doc, { since_heads: since, comments: "none" }));
  show(blockPreview(doc.blocks[id]));
  show(cardContent(doc));
  show(shellBlocks(doc).map((block) => block.spans.length));
  show(openingTitleWarning(doc));
  show(pageMarkdown(projectPage(doc)));
  const spans = A.spans(doc, textPath(id));
  // A draft the export can't read whole is kept as its spans' JSON, in a
  // code fence: inert text, so it isn't part of what is shown.
  commentDraftsMarkdown([
    { kind: "comment", body: "draft", spans: JSON.parse(JSON.stringify(spans)) },
  ]);
  const message = A.change(A.from({ message: { richText: "" } }), (draft) =>
    A.updateSpans(draft, ["message", "richText"], spans, updateSpansConfig),
  );
  try {
    show(commentBodyProjection(message.message));
  } finally {
    A.free(message);
  }
  return out.join("\n");
}

/** Stored spans as comparable JSON: adjacent text runs with the same marks
 * joined, marks always present, keys sorted. Names stay as stored, so a map
 * stored as a name compares as that map. */
function storedJSON(spans) {
  const out = [];
  for (const span of JSON.parse(JSON.stringify(spans))) {
    const last = out.at(-1);
    if (span.type !== "text") out.push(span);
    else if (!span.value) continue;
    else if (last?.type === "text" && canonical(last.marks) === canonical(span.marks ?? {}))
      last.value += span.value;
    else out.push({ type: "text", value: span.value, marks: span.marks ?? {} });
  }
  return canonical(out);
}

// Generated Pages, and short bullet lists (one item may hold a table), where
// two writers' indents often meet on one item.
const textNode = (value) => ({ kind: "text", value, marks: {} });
const paragraphNode = (value) => ({ kind: "paragraph", children: [textNode(value)] });
const TABLE_NODE = {
  kind: "table",
  children: [
    { kind: "row", children: [{ kind: "header", align: null, children: [textNode("h")] }] },
    { kind: "row", children: [{ kind: "cell", align: null, children: [textNode("c")] }] },
  ],
};
const listPage = fc
  .record({ items: fc.integer({ min: 2, max: 4 }), table: fc.nat({ max: 3 }) })
  .map(({ items, table }) => ({
    kind: "doc",
    children: [
      {
        kind: "bullet",
        children: Array.from({ length: items }, (_, i) => ({
          kind: "item",
          children: [paragraphNode(`item ${i}`), ...(i === table ? [TABLE_NODE] : [])],
        })),
      },
      paragraphNode("after"),
    ],
  }));
// On a list, both writers indent the same item first, then make any edits.
const listWriters = fc
  .tuple(
    fc.nat({ max: 5 }),
    fc.array(intent(KINDS), { maxLength: 2 }),
    fc.array(intent(KINDS), { maxLength: 2 }),
  )
  .map(([variant, a, b]) => [
    [{ kind: "indent", pick: 0, variant }, ...a],
    [{ kind: "indent", pick: 0, variant }, ...b],
  ]);
const cases = fc.oneof(
  fc.tuple(pageTreeArbitrary({ maxDepth: 2 }), writers),
  fc.tuple(listPage, listWriters),
);

test("whatever a merge of writers leaves, every reader reads it and repair changes no Markdown", () => {
  // How many merges reached each repair, so the test fails if the writers
  // stop producing either.
  const reached = { unmarked: 0, adjusted: 0 };
  fc.assert(
    fc.property(cases, ([description, writers]) =>
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
        // These writers use only names this build knows: a merge can leave
        // adjusted nesting, never newer content, and repair stores what every
        // reader drew.
        const before = readAll(merged, id, label, { lossy: true });
        assert.equal(before.decoded.newer, false, label);
        if (before.decoded.unmarked.length) reached.unmarked++;
        if (before.decoded.adjusted) reached.adjusted++;
        const repaired = keep(
          A.change(A.clone(merged), (draft) => {
            assert.equal(
              repairBlockMarkers(draft, id),
              before.decoded.unmarked.length > 0 || before.decoded.moved.length > 0,
              label,
            );
          }),
        );
        const after = readAll(repaired, id, label);
        assert.equal(after.decoded.adjusted, false, label);
        assert.deepEqual(after.decoded.unmarked, [], label);
        // Repair stores what every reader drew: the editor's tree and the
        // agent's Markdown are unchanged.
        assert.ok(after.decoded.doc.eq(before.decoded.doc), label);
        assert.equal(after.markdown, before.markdown, label);
        assert.ok(
          after.ids.every((entry) => typeof entry.id === "string"),
          label,
        );
        // Ids that existed before the repair keep naming the same nodes.
        for (const [index, entry] of before.ids.entries())
          if (entry.id !== null) assert.equal(after.ids[index].id, entry.id, label);
        A.change(A.clone(repaired), (draft) =>
          assert.equal(repairBlockMarkers(draft, id), false, label),
        );
      }),
    ),
    parameters,
  );
  if (process.env.PAGES_FUZZ_SEED === undefined && process.env.PAGES_FUZZ_RUNS === undefined) {
    assert.ok(reached.unmarked > 0, JSON.stringify(reached));
    assert.ok(reached.adjusted > 0, JSON.stringify(reached));
  }
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
          repairBlockMarkers(draft, id);
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
      A.change(A.clone(unmarked, { actor: ACTORS[2] }), (draft) => repairBlockMarkers(draft, id)),
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

const S = (value) => new A.ImmutableString(value);
const marker = (type, parents) => ({
  type: "block",
  value: { type: S(type), parents: parents.map(S), attrs: {}, isEmbed: false },
});
// Marker parents, written as lists. Concurrent changes to one marker's
// parents, and Automerge 3.5's updateSpans on its own, can store parents no
// writer wrote.
const parentsOf = (doc) =>
  A.spans(doc, ["text"]).flatMap((span) =>
    span.type === "block" ? [span.value.parents.map(String)] : [],
  );

/** A Page whose one block stores `spans` exactly. */
function pageWithSpans(spans) {
  let doc = A.change(A.from(createPageData({ pageId: PAGE_ID, title: "Spans" })), (draft) =>
    initializePage(draft),
  );
  const id = orderedBlockIds(doc)[0];
  const since = A.getHeads(doc);
  doc = A.change(doc, (draft) => {
    updateSpansExactly(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
  });
  return { doc, id, since };
}

test("a structural write stores the parents it is given and keeps every marker", () => {
  // Automerge 3.5's updateSpans, on a rewrite that drops an outer container,
  // stores a table row's parents as [table, table].
  const before = nestedTable(["blockquote", "ordered-list-item"]);
  const after = nestedTable(["ordered-list-item"]);
  const given = after.flatMap((span) =>
    span.type === "block" ? [span.value.parents.map(String)] : [],
  );
  let raw = A.change(A.from({ text: "" }), (d) => A.updateSpans(d, ["text"], before));
  raw = A.change(raw, (d) => A.updateSpans(d, ["text"], after));
  assert.notDeepEqual(parentsOf(raw), given);
  // The writers' path gives every marker the value it was given, and the
  // markers that stay keep their cursors (their node ids).
  let exact = A.change(A.from({ text: "" }), (d) => A.updateSpans(d, ["text"], before));
  const cursors = new Set([...Array(10).keys()].map((at) => A.getCursor(exact, ["text"], at)));
  exact = A.change(exact, (d) => updateSpansExactly(d, ["text"], after));
  assert.deepEqual(parentsOf(exact), given);
  // No marker was replaced: every character is one that was stored before.
  for (let at = 0; at < 9; at++) assert.ok(cursors.has(A.getCursor(exact, ["text"], at)), `${at}`);
});

test("parents no writer wrote read in every reader, and the next host write repairs them", () => {
  for (const [name, spansOf] of Object.entries(ADJUSTED_NESTING_CASES)) {
    const { doc, id } = pageWithSpans(spansOf());
    const before = readAll(doc, id, name, { lossy: true });
    assert.equal(before.decoded.adjusted, true, name);
    assert.equal(before.decoded.newer, false, name);
    // A replace_match to text unrelated to the bad markers repairs them in
    // the same change: the block reads as drawn, nothing is adjusted, and
    // every node keeps its id.
    const word = ADJUSTED_NESTING_WORDS[name];
    const after = A.change(doc, (draft) =>
      applyPageOperation(draft, {
        operation: "patch_page",
        arguments: {
          operations: [{ op: "replace_match", block_id: id, match_text: word, replacement: "z" }],
        },
      }),
    );
    const read = readAll(after, id, name);
    assert.equal(read.decoded.lossy, false, name);
    assert.equal(read.markdown, before.markdown.replace(new RegExp(`\\b${word}\\b`), "z"), name);
    assert.deepEqual(
      read.ids.map((entry) => entry.id),
      before.ids.map((entry) => entry.id),
      name,
    );
    A.change(A.clone(after), (draft) => assert.equal(repairBlockMarkers(draft, id), false, name));
  }
});

test("a re-homed node keeps its node id when repair stores where it is drawn", () => {
  const { doc, id } = pageWithSpans([
    marker("paragraph", []),
    { type: "text", value: "one" },
    marker("paragraph", ["table-row", "table-row"]),
    { type: "text", value: "two" },
  ]);
  const before = readAll(doc, id, "re-homed", { lossy: true });
  assert.deepEqual(before.decoded.moved, [{ at: 4, parents: [] }]);
  const repaired = A.change(doc, (draft) => assert.ok(repairBlockMarkers(draft, id)));
  const after = readAll(repaired, id, "re-homed");
  assert.deepEqual(
    after.ids.map((entry) => entry.id),
    before.ids.map((entry) => entry.id),
  );
  assert.equal(after.markdown, before.markdown);
});

// Marker values this build can't read or must not render, as a peer can
// store them through sync.
const UNREADABLE = {
  "unsafe image src": [
    marker("paragraph", []),
    { type: "text", value: "a" },
    {
      type: "block",
      value: {
        type: S("image"),
        parents: [S("paragraph")],
        attrs: { src: S("javascript:alert(1)"), alt: S("x") },
        isEmbed: true,
      },
    },
  ],
  "image with no attrs": [
    marker("paragraph", []),
    { type: "text", value: "a" },
    {
      type: "block",
      value: { type: S("image"), parents: [S("paragraph")], attrs: {}, isEmbed: true },
    },
  ],
  "heading level 9": [
    {
      type: "block",
      value: { type: S("heading"), parents: [], attrs: { level: 9 }, isEmbed: false },
    },
    { type: "text", value: "h" },
  ],
  "table alignment diagonal": [
    marker("table", []),
    marker("table-row", ["table"]),
    {
      type: "block",
      value: {
        type: S("table-header"),
        parents: [S("table"), S("table-row")],
        attrs: { align: S("diagonal") },
        isEmbed: false,
      },
    },
    { type: "text", value: "c" },
  ],
};

test("a marker this build can't read is a notice in every reader, and never a URL", () => {
  for (const [name, spans] of Object.entries(UNREADABLE)) {
    const { doc, id } = pageWithSpans(spans);
    const read = readAll(doc, id, name, { lossy: true });
    assert.equal(read.decoded.newer, true, name);
    assert.match(read.markdown, /Unsupported node/, name);
    assert.doesNotMatch(read.markdown, /javascript/, name);
    // Encode writes the marker back as stored.
    const unknown = [];
    read.decoded.doc.iterate((node) => {
      if (node.type === PagesUnknownBlock || node.type === PagesUnknownEmbed) unknown.push(node);
    });
    assert.ok(unknown.length, name);
    // A value that isn't a map can't be stored through updateSpans, but a
    // reader handed one draws a notice too.
    assert.equal(decode([...spans, { type: "block", value: "oops" }]).newer, true, name);
  }
});

test("an owner recovers a block with unreadable markers with an agent tool", () => {
  for (const [name, spans] of Object.entries(UNREADABLE)) {
    const { doc, id } = pageWithSpans(spans);
    // Repair leaves it alone and doesn't throw, so the batch reaches the
    // rewrite.
    A.change(A.clone(doc), (draft) => assert.equal(repairBlockMarkers(draft, id), false, name));
    const rewritten = A.change(A.clone(doc), (draft) =>
      applyPageOperation(draft, {
        operation: "edit_page",
        arguments: {
          operations: [{ op: "replace_block_markdown", block_id: id, markdown: "Fixed." }],
        },
      }),
    );
    assert.equal(blockMarkdown(rewritten.blocks[id], PAGE_ID), "Fixed.", name);
    assert.equal(readAll(rewritten, id, name).decoded.lossy, false, name);
    const deleted = A.change(A.clone(doc), (draft) =>
      applyPageOperation(draft, {
        operation: "edit_page",
        arguments: {
          operations: [
            { op: "insert_markdown", markdown: "Second" },
            { op: "delete_block", block_id: id },
          ],
        },
      }),
    );
    assert.equal(Object.hasOwn(deleted.blocks, id), false, name);
  }
});

test("two concurrent repairs of a stray cell can leave adjusted nesting the next repair clears", () => {
  const { doc, id } = pageWithSpans([
    marker("paragraph", []),
    { type: "text", value: "one" },
    marker("table-cell", ["blockquote"]),
    { type: "text", value: "two" },
  ]);
  const before = readAll(doc, id, "stray cell", { lossy: true });
  const repair = (actor) =>
    A.change(A.clone(doc, { actor }), (draft) => assert.ok(repairBlockMarkers(draft, id)));
  for (const [first, second] of [
    [ACTORS[0], ACTORS[1]],
    [ACTORS[1], ACTORS[0]],
  ]) {
    // Both repairs insert the same list elements, so the merged parents
    // repeat them: nesting is adjusted again.
    const merged = A.merge(repair(first), repair(second));
    const read = readAll(merged, id, "merged repairs", { lossy: true });
    assert.equal(read.decoded.adjusted, true);
    assert.equal(read.markdown, before.markdown);
    assert.deepEqual(
      read.ids.map((entry) => entry.id),
      before.ids.map((entry) => entry.id),
    );
    // The next repair writes, and leaves it clean.
    const next = A.change(merged, (draft) => assert.ok(repairBlockMarkers(draft, id)));
    const clean = readAll(next, id, "next repair");
    assert.equal(clean.decoded.adjusted, false);
    assert.equal(clean.markdown, before.markdown);
  }
});

test("repair leaves a block with content from a newer build exactly as it is", () => {
  const spans = ADJUSTED_NESTING_CASES["repeated table"]();
  spans.splice(1, 0, marker("callout", []), { type: "text", value: "future" });
  const { doc, id } = pageWithSpans(spans);
  const before = readAll(doc, id, "newer", { lossy: true });
  assert.equal(before.decoded.newer, true);
  A.change(A.clone(doc), (draft) => assert.equal(repairBlockMarkers(draft, id), false));
});

const editPage = (doc, operations, operation = "edit_page") =>
  A.change(A.clone(doc), (draft) =>
    applyPageOperation(draft, { operation, arguments: { operations } }),
  );
// delete_block removes a block whatever it holds: the recovery when read_page
// reports no node_id for a node a Markdown rewrite can't keep.
const deleteBlock = (doc, id) =>
  editPage(doc, [
    { op: "insert_markdown", markdown: "Second" },
    { op: "delete_block", block_id: id },
  ]);
/** replace_block_markdown with "Fixed.", or its refusal, which names the
 * recovery. */
function rewriteOrRefuse(doc, id, label) {
  let rewritten;
  try {
    rewritten = editPage(doc, [{ op: "replace_block_markdown", block_id: id, markdown: "Fixed." }]);
  } catch (error) {
    assert.match(error.message, /delete_block/, label);
    return null;
  }
  assert.equal(blockMarkdown(rewritten.blocks[id], PAGE_ID), "Fixed.", label);
  return rewritten;
}

test("every reader draws a marker value this build can't read as a notice, and delete_block removes it", () => {
  for (const [name, value] of Object.entries(UNREADABLE_MARKERS)) {
    freeing((keep) => {
      // Text right after a node drawn as a notice is that node's content,
      // which this build can't draw: a paragraph of its own opens the word.
      const stored = value();
      const spans = [
        marker("paragraph", []),
        { type: "text", value: "a" },
        { type: "block", value: stored },
        ...(stored.isEmbed ? [] : [marker("paragraph", [])]),
        { type: "text", value: "word" },
      ];
      const { doc, id, since } = pageWithSpans(spans);
      keep(doc);
      const read = readAll(doc, id, name, { lossy: true });
      assert.equal(read.decoded.newer, true, name);
      // A container this build doesn't know draws nothing; a node, a notice.
      if (name !== "parent a map") assert.match(read.markdown, /Unsupported node/, name);
      assert.doesNotMatch(read.markdown, /javascript/, name);
      assert.doesNotMatch(readOthers(doc, id, since), /javascript/, name);
      // Encode writes a node it draws whole as a notice back as stored. A
      // name that isn't one, attrs that aren't a map and an image this build
      // can't read make the block lossy: the editor doesn't write it.
      if (!read.decoded.lossy)
        assert.equal(
          storedJSON(encode(read.decoded.doc)),
          storedJSON(A.spans(doc, textPath(id))),
          name,
        );
      else assert.match(name, /a map|missing|not a map|image/, name);
      A.change(A.clone(doc), (draft) => assert.equal(repairBlockMarkers(draft, id), false, name));
      const rewritten = rewriteOrRefuse(doc, id, name);
      if (rewritten) keep(rewritten);
      const deleted = keep(deleteBlock(doc, id));
      assert.equal(Object.hasOwn(deleted.blocks, id), false, name);
    });
  }
});

test("every reader draws a mark value this build can't read as plain text, and writes it back", () => {
  for (const [name, marks] of Object.entries(UNREADABLE_MARKS)) {
    freeing((keep) => {
      const { doc, id, since } = pageWithSpans([
        marker("paragraph", []),
        { type: "text", value: "click", marks },
      ]);
      keep(doc);
      const read = readAll(doc, id, name);
      assert.equal(read.decoded.newer, false, name);
      assert.equal(read.markdown, "click", name);
      const others = readOthers(doc, id, since);
      assert.doesNotMatch(others, /javascript:alert|url\(/, name);
      // The editor keeps the mark as stored and writes it back.
      assert.equal(
        storedJSON(encode(read.decoded.doc)),
        storedJSON(A.spans(doc, textPath(id))),
        name,
      );
      A.change(A.clone(doc), (draft) => assert.equal(repairBlockMarkers(draft, id), false, name));
      assert.ok(rewriteOrRefuse(doc, id, name) && true, name);
    });
  }
});

test("set_node refuses a heading this build can't read, which replace_block_markdown rewrites", () => {
  const { doc, id } = pageWithSpans([
    {
      type: "block",
      value: { type: S("heading"), parents: [], attrs: { level: S("2") }, isEmbed: false },
    },
    { type: "text", value: "Title" },
  ]);
  const setNode = (input) =>
    A.change(A.clone(doc), (draft) =>
      applyPageOperation(draft, {
        operation: "patch_page",
        arguments: {
          operations: [{ op: "set_node", block_id: id, match_text: "Title", ...input }],
        },
      }),
    );
  // The heading can't be drawn, and the title after it is its own text, so
  // set_node refuses it whatever it would write. replace_block_markdown
  // rewrites the block whole.
  for (const input of [{ type: "heading" }, { attrs: { level: 2 } }, { type: "paragraph" }])
    assert.throws(
      () => setNode(input),
      (error) => error.code === "newer_content",
    );
  const rewritten = rewriteOrRefuse(doc, id, "unreadable heading");
  assert.equal(readAll(rewritten, id, "rewritten").decoded.newer, false);
  A.free(rewritten);
  A.free(doc);
});

test("two writers that indent the same list item at once leave a block every reader reads", () => {
  // Marker parents merge element by element: the merge stores parents
  // neither writer wrote.
  const spans = ADJUSTED_NESTING_CASES["concurrent indent"]();
  assert.ok(
    spans.some(
      (span) =>
        span.type === "block" && span.value.parents.filter((p) => String(p) === "table").length > 1,
    ),
  );
  const { doc, id } = pageWithSpans(spans);
  const read = readAll(doc, id, "concurrent indent", { lossy: true });
  assert.equal(read.decoded.lossy, true);
  assert.match(read.markdown, /a/);
});

// Random marker values: names from the registry and junk (maps among them),
// in any order and any parents, with attrs and mark values this build writes
// and ones it doesn't, as any client can store them through sync. No reader
// throws on anything Automerge stores, and the readers agree on the block's
// nodes.
const NAMES = [...NODE_TYPES.map((type) => type.block), "pages-future", "", "table", "table-row"];
const nameOf = fc.oneof(fc.constantFrom(...NAMES), fc.string({ maxLength: 4 }));
// A stored name that isn't one: a map, some with toString or valueOf
// shadowed, so String() on it throws.
const mapName = fc.constantFrom(
  SHADOWED,
  () => ({ toString: "x" }),
  () => ({ valueOf: 3 }),
  () => ({}),
);
const storedName = fc.oneof(
  { weight: 12, arbitrary: nameOf.map((name) => new A.ImmutableString(name)) },
  { weight: 1, arbitrary: mapName.map((make) => make()) },
);
const parentsArb = fc.oneof(
  { weight: 6, arbitrary: fc.array(storedName, { maxLength: 5 }) },
  { weight: 1, arbitrary: fc.constantFrom(null, "table", 3, { 0: "table" }) },
);
const IS = (value) => (typeof value === "string" ? new A.ImmutableString(value) : value);
const ASSET = `/api/pages/${PAGE_ID}/assets/${"b".repeat(64)}`;
const attrsArb = fc.oneof(
  { weight: 4, arbitrary: fc.constant({}) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(0, 9, "2", null, 2).map((level) => ({ level: IS(level) })),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom("diagonal", "left", 0, null).map((align) => ({ align: IS(align) })),
  },
  {
    weight: 2,
    arbitrary: fc
      .record(
        {
          src: fc.constantFrom("javascript:alert(1)", 3, null, ASSET, "https://example.org/i.png"),
          alt: fc.constantFrom("x", 1),
        },
        { requiredKeys: [] },
      )
      .map(({ src, alt }) => ({
        ...(src !== undefined && { src: IS(src) }),
        ...(alt !== undefined && { alt: IS(alt) }),
      })),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(true, "true", 1, null).map((checked) => ({ checked: IS(checked) })),
  },
  { weight: 1, arbitrary: fc.constantFrom("attrs", 3, null, [1]) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom("level", "params", "align", "src", "checked")
      .map((key) => ({ [key]: SHADOWED() })),
  },
);
const marksArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant({}) },
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      { strong: true },
      { em: true, code: true },
      { link: JSON.stringify({ href: "https://example.org", title: null }) },
      { highlight: "yellow" },
      { future: "x" },
      { strong: "yes" },
      { link: JSON.stringify({ href: "https://example.org", future: 1 }) },
      ...Object.values(UNREADABLE_MARKS),
    ),
  },
);
const spanArb = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .record({ value: fc.constantFrom("x", "two words", ""), marks: marksArb })
      .map(({ value, marks }) => ({ type: "text", value, marks })),
  },
  {
    weight: 5,
    arbitrary: fc
      .record({
        type: storedName,
        parents: parentsArb,
        attrs: attrsArb,
        embed: fc.boolean(),
        typed: fc.nat({ max: 9 }),
      })
      .map(({ type, parents, attrs, embed, typed }) => ({
        type: "block",
        value: {
          // Now and then a marker has no type at all.
          ...(typed > 0 && { type }),
          parents,
          attrs,
          isEmbed: embed,
        },
      })),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom("oops", null, 3).map((value) => ({ type: "block", value })),
  },
);

// Top-level nodes as a writer stores them, so most blocks read whole: text
// with any mark values, and a node drawn as a notice (a name this build
// doesn't know, a value it can't read) with nothing after it in its scope.
const topLevelArb = fc
  .array(
    fc.oneof(
      fc
        .record({
          type: fc.constantFrom("paragraph", "heading"),
          marks: marksArb,
        })
        .map(({ type, marks }) => [
          {
            type: "block",
            value: {
              type: S(type),
              parents: [],
              attrs: type === "heading" ? { level: 2 } : {},
              isEmbed: false,
            },
          },
          { type: "text", value: "x", marks },
        ]),
      fc
        .constantFrom(
          { type: S("pages-future"), parents: [], attrs: { tone: S("warm") }, isEmbed: false },
          ...Object.values(UNREADABLE_MARKERS)
            .map((make) => make())
            .filter((value) => !value.isEmbed),
        )
        .map((value) => [{ type: "block", value }]),
      fc.constant([marker("horizontal-rule", [])]),
    ),
    { minLength: 1, maxLength: 5 },
  )
  .map((nodes) => nodes.flat());

// Automerge's own refusal of a value it can't store as a block.
const automergeRefused = (error) => /Cannot updateSpans|not a valid block/.test(error.message);

test("no reader throws on any marker values Automerge stores, and the readers agree", () => {
  // How many blocks reached each check, so the test fails if the generator
  // stops reaching one.
  const reached = { roundTrip: 0, notice: 0, foreignMark: 0 };
  fc.assert(
    fc.property(
      fc.oneof(
        {
          weight: 3,
          arbitrary: fc
            .array(spanArb, { maxLength: 10 })
            .map((generated) => ({ generated, writerForm: false })),
        },
        {
          weight: 1,
          arbitrary: topLevelArb.map((generated) => ({ generated, writerForm: true })),
        },
      ),
      ({ generated, writerForm }) =>
        freeing((keep) => {
          const spans = generated.filter((span) => span.type !== "text" || span.value);
          const label = JSON.stringify(generated);
          // Every reader of spans returns on anything, stored or not.
          decode(spans);
          nativeReadSpans(spans, PAGE_ID);
          blockAddresses(spans);
          let doc = A.change(A.from(createPageData({ pageId: PAGE_ID, title: "Spans" })), (draft) =>
            initializePage(draft),
          );
          const id = orderedBlockIds(doc)[0];
          const since = A.getHeads(doc);
          try {
            doc = A.change(doc, (draft) =>
              updateSpansExactly(draft, textPath(id), spans, updateSpansConfig),
            );
          } catch (error) {
            keep(doc);
            if (!automergeRefused(error)) throw error;
            return;
          }
          doc = keep(A.change(doc, (draft) => stampSpans(draft, spans)));
          const before = readAll(doc, id, label, { lossy: true });
          readOthers(doc, id, since);
          // delete_block removes any block, whatever it holds.
          assert.equal(Object.hasOwn(keep(deleteBlock(doc, id)).blocks, id), false, label);
          // Encode writes back what decode read, where it draws it whole: the
          // spans a writer stores, with notices and marks this build can't
          // read among them. On anything else, what it writes reads the same.
          const stored = A.spans(doc, textPath(id));
          if (!before.decoded.lossy)
            assert.ok(decode(encode(before.decoded.doc)).doc.eq(before.decoded.doc), label);
          if (writerForm && !before.decoded.lossy) {
            assert.equal(storedJSON(encode(before.decoded.doc)), storedJSON(stored), label);
            reached.roundTrip++;
            if (before.decoded.newer) reached.notice++;
            if (stored.some((span) => span.type === "text" && span.marks?.link === 7))
              reached.foreignMark++;
          }
          // A host write repairs every block it names first; repair returns
          // false on a newer-and-lossy block, and never throws.
          const repaired = keep(A.change(A.clone(doc), (draft) => repairBlockMarkers(draft, id)));
          if (before.decoded.newer) return;
          // With every name and value known, repair stores what every reader
          // drew: the same tree and Markdown, nothing adjusted, and a second
          // repair writes nothing.
          const after = readAll(repaired, id, label, { lossy: true });
          assert.equal(after.decoded.adjusted, false, label);
          assert.ok(after.decoded.doc.eq(before.decoded.doc), label);
          assert.equal(after.markdown, before.markdown, label);
          A.change(A.clone(repaired), (draft) =>
            assert.equal(repairBlockMarkers(draft, id), false, label),
          );
        }),
    ),
    { ...parameters, numRuns: Number(process.env.PAGES_FUZZ_RUNS ?? 200) },
  );
  if (process.env.PAGES_FUZZ_SEED === undefined && process.env.PAGES_FUZZ_RUNS === undefined)
    for (const [check, count] of Object.entries(reached))
      assert.ok(count > 0, `${check}: ${JSON.stringify(reached)}`);
});

// In a block decode draws only in part because it holds content from a
// newer build, host tools edit text in the nodes this build reads, and
// refuse text in a node it can't read (newer_content). Repair leaves such a
// block alone, so an allowed edit matches against the stored markers,
// unmarked text and stored nesting included, and writes none of them.
test("host tools edit readable text in a block with newer content, and refuse the unreadable node's", () => {
  const image = {
    type: "block",
    value: {
      type: S("image"),
      parents: [S("paragraph")],
      attrs: { src: S(`/api/pages/${PAGE_ID}/assets/${"b".repeat(64)}`), alt: S("x") },
      isEmbed: true,
    },
  };
  const replace = (match_text) => ({ op: "replace_match", match_text, replacement: "Bye" });
  const format = (match_text) => ({ op: "format_match", match_text, add: { strong: true } });
  const heading = (match_text) => ({
    op: "set_node",
    match_text,
    type: "heading",
    attrs: { level: 2 },
  });
  const blocks = {
    // Text after a node this build doesn't know is that node's content.
    "unknown node": {
      spans: [
        marker("paragraph", []),
        { type: "text", value: "Hello" },
        image,
        marker("pages-future", []),
        { type: "text", value: "after" },
      ],
      allowed: [replace("Hello"), format("Hello"), heading("Hello"), "set_image"],
      refused: [replace("after"), format("after"), heading("after")],
    },
    // A parent that isn't a name: the paragraph reads, but set_node would
    // write the parent back.
    "parent a map": {
      spans: [
        marker("paragraph", []),
        { type: "text", value: "Hello" },
        image,
        { type: "block", value: { ...marker("paragraph", []).value, parents: [SHADOWED()] } },
        { type: "text", value: "word" },
      ],
      allowed: [replace("word"), format("word"), heading("Hello"), "set_image"],
      refused: [heading("word")],
    },
    // Unmarked text at the start and a marker whose nesting decode adjusts
    // stay as stored around an allowed edit.
    "unmarked and adjusted": {
      spans: [
        { type: "text", value: "lead" },
        marker("paragraph", ["horizontal-rule"]),
        { type: "text", value: "moved" },
        marker("pages-future", []),
        { type: "text", value: "after" },
      ],
      allowed: [replace("lead"), format("moved"), replace("moved")],
      refused: [replace("after"), format("after")],
    },
  };
  const markers = (doc, id) =>
    storedJSON(A.spans(doc, textPath(id)).filter((span) => span.type === "block"));
  for (const [name, { spans, allowed, refused }] of Object.entries(blocks)) {
    freeing((keep) => {
      const { doc, id } = pageWithSpans(spans);
      keep(doc);
      const decoded = decode(A.spans(doc, textPath(id)));
      assert.ok(decoded.newer && decoded.lossy, name);
      A.change(A.clone(doc), (draft) => assert.equal(repairBlockMarkers(draft, id), false, name));
      const stored = storedJSON(A.spans(doc, textPath(id)));
      for (const input of refused) {
        const label = `${name}: ${input.op} ${input.match_text}`;
        assert.throws(
          () => editPage(doc, [{ block_id: id, ...input }], "patch_page"),
          (error) => error.code === "newer_content" && error.status === 409,
          label,
        );
        assert.throws(
          () => guardPassageEdits(doc, A.getHeads(doc), [{ block_id: id, ...input }]),
          (error) => error.code === "newer_content",
          `passage ${label}`,
        );
      }
      for (const input of allowed) {
        const op =
          input === "set_image"
            ? { op: "set_image", image_id: imageIds(doc, id)[0].image_id, alt: "y" }
            : input;
        const label = `${name}: ${op.op} ${op.match_text ?? ""}`;
        const next = keep(
          editPage(
            doc,
            [{ block_id: id, ...op }],
            op.op === "set_image" ? "edit_page" : "patch_page",
          ),
        );
        const after = A.spans(next, textPath(id));
        if (op.op === "replace_match" || op.op === "format_match") {
          // Text and marks only: every marker, the unmarked lead and the
          // unreadable node's text are as stored.
          assert.equal(markers(next, id), markers(doc, id), label);
          assert.equal(after[0].type, spans[0].type, label);
          if (doc.blocks[id].richText.endsWith("after"))
            assert.ok(next.blocks[id].richText.endsWith("\ufffcafter"), label);
        }
        if (op.op === "replace_match") assert.match(next.blocks[id].richText, /Bye/, label);
        assert.notEqual(storedJSON(after), stored, label);
        if (op.op !== "set_image")
          assert.doesNotThrow(
            () => guardPassageEdits(doc, A.getHeads(doc), [{ block_id: id, ...op }]),
            `passage ${label}`,
          );
      }
      // Moving the block and writing a new one leave its spans as stored.
      for (const operations of [
        [{ op: "move_block", block_id: id, after_block_id: null }],
        [{ op: "insert_markdown", after_block_id: id, markdown: "new" }],
      ]) {
        const next = keep(editPage(doc, operations));
        assert.equal(storedJSON(A.spans(next, textPath(id))), stored, name);
      }
      assert.equal(Object.hasOwn(keep(deleteBlock(doc, id)).blocks, id), false, name);
    });
  }
});

// set_node writes a column's alignment to every cell in it. A cell whose
// stored alignment this build can't read is refused before anything is
// written, even when the matched cell reads.
test("set_node refuses a column alignment that would overwrite a cell this build can't read", () => {
  const cell = (type, attrs = {}) => ({
    type: "block",
    value: { type: S(type), parents: [S("table"), S("table-row")], attrs, isEmbed: false },
  });
  const spans = [
    marker("table", []),
    marker("table-row", ["table"]),
    cell("table-header"),
    { type: "text", value: "Head" },
    marker("table-row", ["table"]),
    cell("table-cell", { align: S("diagonal") }),
    { type: "text", value: "body" },
  ];
  freeing((keep) => {
    const { doc, id } = pageWithSpans(spans);
    keep(doc);
    const stored = storedJSON(A.spans(doc, textPath(id)));
    const op = { op: "set_node", block_id: id, match_text: "Head", attrs: { align: "left" } };
    assert.throws(
      () => editPage(doc, [op], "patch_page"),
      (error) => error.code === "newer_content" && error.status === 409,
    );
    assert.throws(
      () => guardPassageEdits(doc, A.getHeads(doc), [op]),
      (error) => error.code === "newer_content",
    );
    assert.equal(storedJSON(A.spans(doc, textPath(id))), stored);
  });
});

// A readable mark a host tool writes replaces a stored value of the same name
// this build can't read, as the editor's does; removing it brings nothing
// back.
test("format_match over a stored mark value this build can't read replaces it", () => {
  const link = JSON.stringify({ href: "https://example.org", title: null });
  for (const [stored, input, written] of [
    [{ strong: "yes", future: "x" }, { add: { strong: true } }, { strong: true, future: "x" }],
    [{ strong: "yes" }, { remove: ["strong"] }, {}],
    [{ highlight: "red" }, { add: { highlight: "yellow" } }, { highlight: "yellow" }],
    [{ link: 7 }, { add: { link: { href: "https://example.org" } } }, { link }],
  ]) {
    const label = JSON.stringify([stored, input]);
    freeing((keep) => {
      const { doc, id } = pageWithSpans([
        marker("paragraph", []),
        { type: "text", value: "word", marks: stored },
      ]);
      keep(doc);
      const next = keep(
        editPage(
          doc,
          [{ op: "format_match", block_id: id, match_text: "word", ...input }],
          "patch_page",
        ),
      );
      assert.deepEqual(A.spans(next, textPath(id))[1].marks ?? {}, written, label);
      readAll(next, id, label);
    });
  }
});

// The card, preview and title warning read through surfaceRead, which
// refuses some shapes on purpose (budgets, a leaf nested where text follows)
// and its callers fall back. A marker or mark value this build can't read is
// not one of them: it reads as the agent read draws it, a notice between the
// text around it, or plain text.
test("surfaceRead draws a marker or mark value this build can't read as the agent read does", () => {
  const surface = (doc, id) => readMarkdown(surfaceRead(doc.blocks[id]).nodes);
  const unreadableDataframe = () => ({
    type: S("dataframe"),
    parents: [],
    attrs: { src: S("nope") },
    isEmbed: false,
  });
  for (const [name, value] of [
    ...Object.entries(UNREADABLE_MARKERS),
    ["dataframe it can't read", unreadableDataframe],
  ]) {
    freeing((keep) => {
      const stored = value();
      const { doc, id } = pageWithSpans([
        marker("paragraph", []),
        { type: "text", value: "a" },
        { type: "block", value: stored },
        ...(stored.isEmbed ? [] : [marker("paragraph", [])]),
        { type: "text", value: "word" },
      ]);
      keep(doc);
      const read = surface(doc, id);
      // A name that isn't one is a node this build doesn't know, which the
      // surface read names with its one generic wrapper.
      const expected = blockMarkdown(doc.blocks[id], PAGE_ID).replace(
        "[Unsupported node\\]",
        "[Unsupported node: pages-preview-unknown\\]",
      );
      assert.equal(read, expected, name);
      assert.match(read, /^a.*Unsupported node.*word$/s, name);
    });
  }
  for (const [name, marks] of Object.entries(UNREADABLE_MARKS)) {
    freeing((keep) => {
      const { doc, id } = pageWithSpans([
        marker("paragraph", []),
        { type: "text", value: "click", marks },
      ]);
      keep(doc);
      assert.equal(surface(doc, id), "click", name);
    });
  }
});

// A dataframe or image whose attrs this build can't read is a notice on the
// preview and the card, between the text around it, and its src never
// reaches either.
test("the preview and card draw a dataframe or image this build can't read as a notice", () => {
  const asset = `/api/pages/${PAGE_ID}/assets/${"b".repeat(64)}`;
  const cases = {
    "dataframe with no media type": {
      type: S("dataframe"),
      parents: [],
      attrs: { src: S(asset), title: S("T") },
      isEmbed: false,
    },
    "dataframe with a src that isn't an asset": {
      type: S("dataframe"),
      parents: [],
      attrs: { src: S("nope"), title: S("T"), media_type: S("application/vnd.apache.parquet") },
      isEmbed: false,
    },
    "image with no src": UNREADABLE_MARKERS["image with no src"](),
    "image src javascript": UNREADABLE_MARKERS["image src javascript"](),
  };
  for (const [name, stored] of Object.entries(cases)) {
    freeing((keep) => {
      const { doc, id } = pageWithSpans([
        marker("paragraph", []),
        { type: "text", value: "a" },
        { type: "block", value: stored },
        ...(stored.isEmbed ? [] : [marker("paragraph", [])]),
        { type: "text", value: "word" },
      ]);
      keep(doc);
      const notice = `[Unsupported node: ${String(stored.type)}]`;
      const expected = stored.isEmbed
        ? [["p", {}, "a", notice, "word"]]
        : [
            ["p", {}, "a"],
            ["p", {}, notice],
            ["p", {}, "word"],
          ];
      assert.deepEqual(blockPreview(doc.blocks[id]), expected, name);
      assert.deepEqual(
        cardContent(doc).blocks.map((block) => block.content),
        [expected],
        name,
      );
      const shown = JSON.stringify([blockPreview(doc.blocks[id]), cardContent(doc)]);
      assert.doesNotMatch(shown, /nope|javascript|\/assets\/|"T"/, name);
    });
  }
});
