import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import {
  INVALID_PAGE_CONTENT,
  PROBE_BUDGET,
  admitPageChanges,
  requirePageContent,
} from "./page-admission.mjs";
import { spansRead } from "./richtext-spans.mjs";
import { BLOCK_MAX_LENGTH, TITLE_MAX_LENGTH } from "./page-shape.mjs";
import { RICH_FORMAT, textPath } from "./richtext.mjs";

const pageId = "44444444-4444-4444-8444-444444444444";
const assetId = "e".repeat(64);
const MARKDOWN = [
  "# Plans",
  "",
  "Some **bold** and [linked](https://example.org) text.",
  "",
  "- one",
  "- two",
  "",
  "- [ ] task",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "```mermaid",
  "graph TD; A-->B",
  "```",
].join("\n");

const page = (markdown = MARKDOWN) =>
  A.change(A.from(createPageData({ pageId, title: "Plans" })), (d) => initializePage(d, markdown));
const blockOf = (doc) => orderedBlockIds(doc)[0];
/** Native indexes of a block's markers. */
const markerIndexes = (doc, path) => {
  const out = [];
  let at = 0;
  for (const span of A.spans(doc, path)) {
    if (span.type === "block") out.push(at);
    at += span.type === "text" ? span.value.length : 1;
  }
  return out;
};

/** `fn` applied to a copy of `doc`, loaded into another copy as the host
 * loads a browser's changes; returns admission's answer. */
function admit(doc, fn) {
  const next = A.change(A.clone(doc), fn);
  const preview = A.loadIncremental(A.clone(doc), A.saveSince(next, A.getHeads(doc)));
  try {
    return admitPageChanges(doc, preview);
  } finally {
    A.free(next);
    A.free(preview);
  }
}
const refusedFor = (rule, result) => {
  assert.equal(result.ok, false, `expected a ${rule} refusal`);
  assert.equal(result.reason.code, INVALID_PAGE_CONTENT);
  assert.equal(result.reason.rule, rule);
};
const operation = (operations) => (d) =>
  applyPageOperation(d, { operation: "edit_page", arguments: { operations } });

test("each class of invalid write is refused with invalid_page_content and its rule", () => {
  const doc = page();
  const id = blockOf(doc);
  const path = textPath(id);
  refusedFor(
    "mark",
    admit(doc, (d) => A.mark(d, path, { start: 2, end: 5, expand: "none" }, "blink", true)),
  );
  refusedFor(
    "mark",
    admit(doc, (d) =>
      A.mark(
        d,
        path,
        { start: 2, end: 5, expand: "none" },
        "link",
        JSON.stringify({ href: "javascript:alert(1)", title: null }),
      ),
    ),
  );
  refusedFor(
    "mark",
    admit(doc, (d) => A.mark(d, path, { start: 2, end: 5, expand: "none" }, "highlight", "plaid")),
  );
  refusedFor(
    "marker",
    admit(doc, (d) => A.splitBlock(d, path, 3, { type: "marquee", parents: [], attrs: {} })),
  );
  refusedFor(
    "marker",
    admit(doc, (d) =>
      A.splitBlock(d, path, 3, { type: "heading", parents: [], attrs: { level: 9 } }),
    ),
  );
  refusedFor(
    "marker",
    admit(doc, (d) =>
      A.splitBlock(d, path, 3, {
        type: "image",
        parents: ["paragraph"],
        attrs: { src: "javascript:alert(1)" },
      }),
    ),
  );
  refusedFor(
    "block_key",
    admit(doc, (d) => {
      d.blocks[id].extra = "x";
    }),
  );
  refusedFor(
    "block_entry",
    admit(doc, (d) => {
      d.blocks[id].kind = "slides";
    }),
  );
  refusedFor(
    "block_entry",
    admit(doc, (d) => {
      const other = crypto.randomUUID();
      d.blocks[other] = { id: other, kind: "markdown", richText: "" };
    }),
  );
  refusedFor(
    "block_size",
    admit(doc, (d) => A.splice(d, path, 3, 0, "x".repeat(BLOCK_MAX_LENGTH))),
  );
  refusedFor(
    "title",
    admit(doc, (d) => {
      d.title = 7;
    }),
  );
  refusedFor(
    "title",
    admit(doc, (d) => A.updateText(d, ["title"], "t".repeat(TITLE_MAX_LENGTH + 1))),
  );
  refusedFor(
    "root_key",
    admit(doc, (d) => {
      d.comments = {};
    }),
  );
  refusedFor(
    "root_key",
    admit(doc, (d) => {
      delete d.blocks;
    }),
  );
  refusedFor(
    "page_id",
    admit(doc, (d) => {
      d.page_id = "55555555-5555-4555-8555-555555555555";
    }),
  );
  refusedFor(
    "schema",
    admit(doc, (d) => {
      d.schema.features.push("Not An Id!");
    }),
  );
  refusedFor(
    "schema",
    admit(doc, (d) => {
      d.schema.features.splice(0, 1);
    }),
  );
  // A marker the patch path reads as valid on its own, placed where the
  // block's tree can't hold it.
  refusedFor(
    "structure",
    admit(doc, (d) =>
      A.splitBlock(d, path, markerIndexes(d, path).at(-1) + 2, {
        type: "image",
        parents: ["code-block"],
        attrs: { src: "/image.png" },
        isEmbed: true,
      }),
    ),
  );
});

test("typing, formatting, splits, joins and every node type a host writer stores are admitted", () => {
  const doc = page();
  const id = blockOf(doc);
  const path = textPath(id);
  const ok = (label, result) => assert.equal(result.ok, true, `${label}: ${result.reason?.rule}`);
  ok(
    "typing",
    admit(doc, (d) => A.splice(d, path, 3, 0, "typed")),
  );
  ok(
    "deleting",
    admit(doc, (d) => A.splice(d, path, 3, 2)),
  );
  for (const [name, value] of [
    ["strong", true],
    ["em", true],
    ["strike", true],
    ["code", true],
    ["highlight", "green"],
    ["link", JSON.stringify({ href: "https://example.org/x", title: null })],
  ])
    ok(
      name,
      admit(doc, (d) => A.mark(d, path, { start: 2, end: 5, expand: "none" }, name, value)),
    );
  ok(
    "unmark",
    admit(doc, (d) => A.unmark(d, path, { start: 0, end: 30, expand: "both" }, "strong")),
  );
  ok(
    "split",
    admit(doc, (d) => A.splitBlock(d, path, 4, { type: "paragraph", parents: [], attrs: {} })),
  );
  const join = admit(doc, (d) => A.joinBlock(d, path, markerIndexes(d, path)[1]));
  ok("join", join);
  assert.equal(join.stats.fullReads, 1, "a join reads its block");
  ok(
    "title",
    admit(doc, (d) => A.updateText(d, ["title"], "Renamed")),
  );
  ok(
    "host operations",
    admit(
      doc,
      operation([
        { op: "insert_markdown", markdown: MARKDOWN },
        { op: "insert_image", asset_id: assetId, alt: "A chart" },
        {
          op: "insert_node",
          node: { type: "dataframe", attrs: { asset_id: assetId, title: "Usage" } },
        },
        { op: "insert_markdown", markdown: "---" },
        { op: "replace_block_markdown", block_id: id, markdown: "Rewritten **text**" },
      ]),
    ),
  );
  const two = A.change(A.clone(doc), operation([{ op: "insert_markdown", markdown: "Second" }]));
  const second = orderedBlockIds(two)[1];
  ok("move", admit(two, operation([{ op: "move_block", block_id: second, after_block_id: null }])));
  ok("delete", admit(two, operation([{ op: "delete_block", block_id: second }])));
  A.free(two);
});

test("typing and formatting read no whole block; a marker change reads only its block", () => {
  const doc = page();
  const id = blockOf(doc);
  const path = textPath(id);
  for (const fn of [
    (d) => A.splice(d, path, 3, 0, "typed"),
    (d) => A.splice(d, path, 3, 1),
    (d) => A.mark(d, path, { start: 2, end: 5, expand: "after" }, "strong", true),
    (d) => A.updateText(d, ["title"], "Renamed"),
  ]) {
    const result = admit(doc, fn);
    assert.equal(result.ok, true);
    assert.equal(result.stats.fullReads, 0);
  }
  const split = admit(doc, (d) =>
    A.splitBlock(d, path, 4, { type: "paragraph", parents: [], attrs: {} }),
  );
  assert.equal(split.ok, true);
  assert.equal(split.stats.fullReads, 1);
});

test("content stored before admission stays, and edits around it are admitted", () => {
  // Legacy-odd content no current writer stores: an unknown mark, a marker
  // under an unknown parent, an extra block field, an extra root key and an
  // over-long title.
  let doc = page("Legacy paragraph with words");
  const id = blockOf(doc);
  const path = textPath(id);
  doc = A.change(doc, (d) => {
    A.mark(d, path, { start: 0, end: 6, expand: "both" }, "blink", true);
    A.splitBlock(d, path, 7, { type: "paragraph", parents: ["slide"], attrs: {} });
    d.blocks[id].legacy = true;
    d.legacyRoot = { kept: true };
    A.updateText(d, ["title"], "T".repeat(TITLE_MAX_LENGTH + 10));
  });
  const ok = (label, result) => assert.equal(result.ok, true, `${label}: ${result.reason?.rule}`);
  // Typing inside the unknown mark inherits it; that isn't a new mark.
  ok(
    "typing in a legacy mark",
    admit(doc, (d) => A.splice(d, path, 2, 0, "x")),
  );
  ok(
    "typing after the legacy marker",
    admit(doc, (d) => A.splice(d, path, 9, 0, "y")),
  );
  ok(
    "formatting",
    admit(doc, (d) => A.mark(d, path, { start: 10, end: 14, expand: "after" }, "em", true)),
  );
  ok(
    "a split in a block that already fails its tree check",
    admit(doc, (d) => A.splitBlock(d, path, 12, { type: "paragraph", parents: [], attrs: {} })),
  );
  ok(
    "shortening the over-long title",
    admit(doc, (d) => A.splice(d, ["title"], 0, 5)),
  );
  // The batch's own invalid writes are still refused.
  refusedFor(
    "mark",
    admit(doc, (d) => A.mark(d, path, { start: 10, end: 14, expand: "none" }, "marquee", true)),
  );
  refusedFor(
    "title",
    admit(doc, (d) => A.splice(d, ["title"], 0, 0, "longer ")),
  );
  refusedFor(
    "block_key",
    admit(doc, (d) => {
      d.blocks[id].legacy = false;
    }),
  );
});

test("a block over the size bound keeps edits that don't lengthen it", () => {
  let doc = A.from({
    page_id: pageId,
    title: "Big",
    blocks: {},
  });
  const id = crypto.randomUUID();
  doc = A.change(doc, (d) => {
    d.blocks[id] = {
      id,
      position: new A.RawString("a0"),
      kind: "markdown",
      format: RICH_FORMAT,
      markdown: "",
      richText: "",
      metadata: {},
    };
  });
  doc = A.change(doc, (d) => A.splice(d, textPath(id), 0, 0, "x".repeat(BLOCK_MAX_LENGTH + 5)));
  assert.equal(admit(doc, (d) => A.splice(d, textPath(id), 0, 10)).ok, true);
  assert.equal(admit(doc, (d) => A.splice(d, textPath(id), 0, 1, "y")).ok, true);
  refusedFor(
    "block_size",
    admit(doc, (d) => A.splice(d, textPath(id), 0, 0, "y")),
  );
});

test("requirePageContent refuses a host write with a 400 before it is journaled", () => {
  const doc = page();
  const next = A.change(A.clone(doc), (d) =>
    A.splice(d, textPath(blockOf(d)), 0, 0, "x".repeat(BLOCK_MAX_LENGTH)),
  );
  assert.throws(() => requirePageContent(doc, next), {
    status: 400,
    code: INVALID_PAGE_CONTENT,
    rule: "block_size",
  });
  A.free(next);
});

/** The host's view of two peers' frames: admit each against the live
 * document in `order`, merging the admitted ones. Returns each answer and
 * the converged document. */
function arrive(base, frames, order) {
  let live = A.clone(base);
  const answers = {};
  for (const name of order) {
    const preview = A.merge(A.clone(live), frames[name]);
    answers[name] = admitPageChanges(live, preview);
    if (answers[name].ok) {
      A.free(live);
      live = preview;
    } else A.free(preview);
  }
  return { answers, live };
}

test("concurrent honest edits are admitted in either arrival order and converge", async () => {
  const { encode, schema } = await import("./wordgard-doc.mjs");
  const { Leaf } = await import("wordgard/doc");
  const { Blockquote, HorizontalRule, Paragraph } = await import("wordgard/types");
  const { PagesDataframe } = await import("./wordgard-doc.mjs");
  const { updateSpansConfig } = await import("./marks.mjs");
  const src = `/api/pages/${pageId}/assets/${assetId}`;
  const leaves = [
    HorizontalRule,
    Blockquote.create([PagesDataframe.of({ src, media_type: "application/vnd.apache.parquet" })]),
  ];
  for (const leaf of leaves) {
    let doc = A.from(createPageData({ pageId, title: "Concurrent" }));
    const id = orderedBlockIds(doc)[0];
    const tree = schema.doc([
      Paragraph.create([Leaf.text("Intro")]),
      leaf,
      Paragraph.create([Leaf.text("doomed words")]),
    ]);
    doc = A.change(doc, (d) => {
      d.blocks[id].format = RICH_FORMAT;
      d.blocks[id].richText = "";
      A.updateSpans(d, textPath(id), encode(tree), updateSpansConfig);
    });
    const path = textPath(id);
    const markers = markerIndexes(doc, path);
    const last = markers.at(-1);
    const text = String(doc.blocks[id].richText);
    // Peer A deletes the last paragraph, marker and text.
    const deleted = A.change(A.clone(doc, { actor: "0a".repeat(16) }), (d) =>
      A.splice(d, path, last, text.length - last),
    );
    // Peer B types into it.
    const typed = A.change(A.clone(doc, { actor: "0b".repeat(16) }), (d) =>
      A.splice(d, path, last + 1, 0, "kept "),
    );
    const frames = { deleted, typed };
    const one = arrive(doc, frames, ["typed", "deleted"]);
    const two = arrive(doc, frames, ["deleted", "typed"]);
    for (const [label, run] of [
      ["typed first", one],
      ["deleted first", two],
    ])
      for (const [name, answer] of Object.entries(run.answers))
        assert.equal(answer.ok, true, `${label}, ${name}: ${JSON.stringify(answer.reason)}`);
    assert.deepEqual(A.spans(one.live, path), A.spans(two.live, path));
    // Readers read the converged block: the typed text as a paragraph
    // beside the leaf.
    assert.ok(spansRead(A.spans(one.live, path), pageId));
  }
});

/** A block of explicit spans, for shapes no writer builds directly. */
function spansPage(spans) {
  let doc = A.from(createPageData({ pageId, title: "Spans" }));
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (d) => {
    d.blocks[id].format = RICH_FORMAT;
    d.blocks[id].richText = "";
    A.updateSpans(d, textPath(id), spans);
  });
  return { doc, id, path: textPath(id) };
}
// Marker strings as the editor's encoder stores them.
const marker = (type, parents = [], attrs = {}) => ({
  type: "block",
  value: {
    type: new A.ImmutableString(type),
    parents: parents.map((parent) => new A.ImmutableString(parent)),
    attrs: Object.fromEntries(
      Object.entries(attrs).map(([key, value]) => [key, new A.ImmutableString(value)]),
    ),
    isEmbed: false,
  },
});
const run = (value, marks) => ({ type: "text", value, ...(marks && { marks }) });

test("text typed straight after a rule or dataframe reads as a paragraph and is admitted", () => {
  // Readers read text after a leaf as a paragraph beside it: the shape a
  // merge leaves when one peer types into a node another deletes. A frame
  // gets the same answer whether it or a merge made the shape.
  const src = `/api/pages/${pageId}/assets/${assetId}`;
  for (const leaf of [
    marker("horizontal-rule"),
    marker("dataframe", [], { src, media_type: "application/vnd.apache.parquet" }),
  ]) {
    const { doc, path } = spansPage([
      marker("paragraph"),
      run("Intro"),
      leaf,
      marker("paragraph"),
      run("next"),
    ]);
    const [, at] = markerIndexes(doc, path);
    const result = admit(doc, (d) => A.splice(d, path, at + 1, 0, "stray"));
    assert.equal(result.ok, true, JSON.stringify(result.reason));
    assert.equal(result.stats.fullReads, 0, "one marker read, no block read");
  }
});

test("text typed straight after a container marker that holds no text is refused", () => {
  const { doc, path } = spansPage([
    marker("table"),
    marker("table-row", ["table"]),
    marker("table-cell", ["table", "table-row"]),
    run("cell"),
    marker("paragraph"),
    run("after"),
  ]);
  const [, row] = markerIndexes(doc, path);
  const result = admit(doc, (d) => A.splice(d, path, row + 1, 0, "stray"));
  refusedFor("structure", result);
  assert.equal(result.stats.fullReads, 1, "the block was read to judge it");
});

test("text a merge left after a rule takes more typing, at its start too", () => {
  // What readers repair into a paragraph: text right after a rule.
  const { doc, path } = spansPage([
    marker("paragraph"),
    run("Intro"),
    marker("horizontal-rule"),
    run("left"),
  ]);
  const [, rule] = markerIndexes(doc, path);
  for (const at of [rule + 1, rule + 3, rule + 5]) {
    const result = admit(doc, (d) => A.splice(d, path, at, 0, "x"));
    assert.equal(result.ok, true, `at ${at}: ${JSON.stringify(result.reason)}`);
  }
});

test("an inherited mark must be one the neighbouring text already holds, by strict value", () => {
  const { doc, path } = spansPage([
    marker("paragraph"),
    run("legacy", { blink: true }),
    run(" plain words here"),
  ]);
  // Inserting and marking in one change reads as a splice carrying the mark.
  const far = admit(doc, (d) => {
    A.splice(d, path, 15, 0, "zz");
    A.mark(d, path, { start: 15, end: 17, expand: "none" }, "blink", true);
  });
  refusedFor("mark", far);
  const loose = admit(doc, (d) => {
    A.splice(d, path, 7, 0, "zz");
    A.mark(d, path, { start: 7, end: 9, expand: "none" }, "blink", "true");
  });
  refusedFor("mark", loose);
  // Typing at the end of the legacy run inherits it.
  assert.equal(admit(doc, (d) => A.splice(d, path, 4, 0, "x")).ok, true);
});

test("deleting an unknown root key or block field is cleanup, and admitted", () => {
  let doc = page("Body");
  const id = blockOf(doc);
  doc = A.change(doc, (d) => {
    d.legacyRoot = { kept: true };
    d.blocks[id].legacy = "x";
  });
  assert.equal(
    admit(doc, (d) => {
      delete d.legacyRoot;
    }).ok,
    true,
  );
  assert.equal(
    admit(doc, (d) => {
      delete d.blocks[id].legacy;
    }).ok,
    true,
  );
});

test("a marker deleted by a plain text delete is judged by reading its block", () => {
  // Deleting a table cell's marker leaves its text straight in the row,
  // which no reader places.
  const { doc, path } = spansPage([
    marker("paragraph"),
    run("Intro"),
    marker("table"),
    marker("table-row", ["table"]),
    marker("table-cell", ["table", "table-row"]),
    run("cell"),
    marker("paragraph"),
    run("after"),
  ]);
  const cell = markerIndexes(doc, path)[3];
  const result = admit(doc, (d) => A.splice(d, path, cell, 1));
  refusedFor("structure", result);
  assert.equal(result.stats.fullReads, 1);
  // Deleting text beside it reads nothing.
  const text = admit(doc, (d) => A.splice(d, path, cell + 1, 2));
  assert.equal(text.ok, true);
  assert.equal(text.stats.fullReads, 0);
});

test("a frame's marker probes share one budget; past it, its block is read once", () => {
  const { doc, path } = spansPage([marker("paragraph"), run("x".repeat(4000))]);
  // 200 one-character deletes, far apart.
  const result = admit(doc, (d) => {
    for (let i = 3900; i > 0; i -= 19) A.splice(d, path, i, 1);
  });
  assert.equal(result.ok, true);
  assert.ok(result.stats.probes <= PROBE_BUDGET, `${result.stats.probes} probes`);
  assert.equal(result.stats.fullReads, 1);
});

test("a block with a conflict on a field this frame writes is checked on every value", () => {
  const doc = page("Body");
  const id = blockOf(doc);
  // Two concurrent changes in one frame write the same field; only the
  // winner shows in the patches.
  const one = A.change(A.clone(doc, { actor: "01".repeat(16) }), (d) => {
    d.blocks[id].kind = "markdown-but-not";
  });
  const two = A.change(A.clone(doc, { actor: "ff".repeat(16) }), (d) => {
    d.blocks[id].kind = "markdown";
  });
  const preview = A.merge(A.clone(one), two);
  refusedFor("block_entry", admitPageChanges(doc, preview));
});

test("a stale frame that breaks a merge rule is still judged on every other rule", () => {
  const base = page("Body");
  // Since the frame's base, the host stamped a feature and grew the title.
  const live = A.change(A.clone(base, { actor: "0c".repeat(16) }), (d) => {
    d.schema.features.push("hologram");
    A.updateText(d, ["title"], "t".repeat(TITLE_MAX_LENGTH - 3));
  });
  // The frame replaces the stamp, dropping the host's feature, and grows the
  // title past the bound once merged.
  const frame = A.change(A.clone(base, { actor: "0d".repeat(16) }), (d) => {
    d.schema = { features: [...d.schema.features] };
    A.splice(d, ["title"], 0, 0, "longer ");
  });
  const preview = A.merge(A.clone(live), frame);
  const result = admitPageChanges(live, preview);
  assert.equal(result.ok, false, "the frame is refused");
  A.free(preview);
});

test("concurrent frames can't grow a block or title past its bound together", () => {
  const base = page("Body");
  const id = blockOf(base);
  const path = textPath(id);
  const grow = (actor, fn) => A.change(A.clone(base, { actor }), fn);
  const half = Math.ceil(BLOCK_MAX_LENGTH * 0.6);
  const frames = {
    one: grow("1a".repeat(16), (d) => A.splice(d, path, 1, 0, "a".repeat(half))),
    two: grow("1b".repeat(16), (d) => A.splice(d, path, 1, 0, "b".repeat(half))),
  };
  const { answers } = arrive(base, frames, ["one", "two"]);
  assert.equal(answers.one.ok, true);
  refusedFor("block_size", answers.two);
  const titles = {
    one: grow("2a".repeat(16), (d) => A.splice(d, ["title"], 0, 0, "a".repeat(700))),
    two: grow("2b".repeat(16), (d) => A.splice(d, ["title"], 0, 0, "b".repeat(700))),
  };
  const titled = arrive(base, titles, ["one", "two"]);
  assert.equal(titled.answers.one.ok, true);
  refusedFor("title", titled.answers.two);
});

test("a stale frame deleting the block's last character gets an answer, not an error", () => {
  const { doc, path } = spansPage([
    marker("paragraph"),
    run("Intro"),
    marker("paragraph"),
    run("tail"),
  ]);
  const length = doc.blocks[path[1]].richText.length;
  // The host deleted the block's last paragraph.
  const live = A.change(A.clone(doc, { actor: "3a".repeat(16) }), (d) =>
    A.splice(d, path, length - 5, 5),
  );
  // A stale frame deletes the last character and grows the title past the
  // bound once merged with a long title the host also took.
  const longLive = A.change(live, (d) =>
    A.updateText(d, ["title"], "t".repeat(TITLE_MAX_LENGTH - 2)),
  );
  const frame = A.change(A.clone(doc, { actor: "3b".repeat(16) }), (d) => {
    A.splice(d, path, length - 1, 1);
    A.splice(d, ["title"], 0, 0, "abcdef");
  });
  const preview = A.merge(A.clone(longLive), frame);
  const result = admitPageChanges(longLive, preview);
  assert.equal(typeof result.ok, "boolean");
  A.free(preview);
});
