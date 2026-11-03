// What agents read back: the Markdown projection of native content, and the
// spans Pages' own writers store. Agents copy the projection's style, and the
// editor rewrites a block from its spans, so both must match what a person
// would write and what the editor writes.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import markdownCorpus from "./markdown-corpus.json" with { type: "json" };
import { createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import {
  exportMarkdown,
  parseMarkdown,
  setRichMarkdown,
  textPath,
  unsupportedMarkdown,
} from "./richtext.mjs";
import { decode, encode } from "../viewer/wordgard-model.mjs";

test("lists read back tight with - bullets, loose only when an item holds several blocks", () => {
  for (const [source, expected] of [
    ["- one\n- two", "- one\n- two"],
    ["* one\n* two", "- one\n- two"],
    ["- one\n\n- two", "- one\n- two"],
    ["1. a\n2. b\n3. c", "1. a\n2. b\n3. c"],
    ["- [ ] task\n- [x] done", "- [ ] task\n- [x] done"],
    ["- outer\n  - inner\n- next", "- outer\n  - inner\n- next"],
    ["> - a\n> - b", "> - a\n> - b"],
    ["Intro\n\n- a\n- b\n\nOutro", "Intro\n\n- a\n- b\n\nOutro"],
    // A second block in an item can only be written loose.
    ["- one\n\n  more\n- two", "- one\n\n  more\n\n- two"],
    ["- a\n\n  ```\n  code\n  ```\n- b", "- a\n\n  ```\n  code\n  ```\n\n- b"],
  ]) {
    const out = exportMarkdown(parseMarkdown(source));
    assert.equal(out, expected, source);
    // A read is stable and means the same content.
    assert.equal(exportMarkdown(parseMarkdown(out)), out, source);
    assert.ok(parseMarkdown(out).eq(parseMarkdown(source)), source);
  }
});

test("numbered lists past nine keep continuation lines inside their item", () => {
  const source = `${Array.from({ length: 10 }, (_, i) => `${i + 1}. item`).join("\n")}\n\n    tenth, continued`;
  const out = exportMarkdown(parseMarkdown(source));
  assert.ok(out.startsWith("1. item\n"));
  assert.ok(parseMarkdown(out).eq(parseMarkdown(source)));
});

const editorRewrite = (doc, id) => {
  const path = textPath(id),
    heads = A.getHeads(doc);
  const after = A.change(A.clone(doc), (draft) =>
    A.updateSpans(draft, path, encode(decode(A.spans(draft, path)).doc)),
  );
  return A.diff(after, heads, A.getHeads(after));
};

// Writer disagreements the shared encoder will remove, by corpus id. Each is
// invisible: the rewrite stores the same content in the editor's form.
// - quote-first-child: a quote whose first child isn't a paragraph. The
//   editor writes an explicit blockquote marker; the importer leaves it to the
//   children's parents.
// - mark-runs: the editor re-marks some runs (nested or crossing marks, link
//   titles) with the same values.
const KNOWN_DISAGREEMENTS = Object.freeze({
  "quoted-nested-only-bullets": "quote-first-child",
  "quoted-nested-only-ordered": "quote-first-child",
  "table-in-quote": "quote-first-child",
  "sibling-tables-in-quote": "quote-first-child",
  "native-rule-variants": "quote-first-child",
  "highlight-heading-quote": "quote-first-child",
  "mark-boundaries": "mark-runs",
  "link-title": "mark-runs",
  "highlight-code-link": "mark-runs",
  "highlight-across-strong": "mark-runs",
  "native-strikethrough-nested": "mark-runs",
});

test("an editor rewrite of any block Pages wrote from Markdown writes nothing", () => {
  const seen = new Set();
  for (const { id: caseId, markdown } of markdownCorpus.cases) {
    // Agent writes, for the Markdown they accept, and literal imports of
    // stored source, for all of it.
    const writes = unsupportedMarkdown(markdown) ? [true] : [false, true];
    for (const literal of writes) {
      let doc = A.from(createPageData({ pageId: "projection", title: "Projection" }));
      const id = orderedBlockIds(doc)[0];
      try {
        doc = A.change(doc, (draft) => setRichMarkdown(draft, id, markdown, { literal }));
      } catch (error) {
        // Source the writer refuses as lossy writes nothing to compare.
        assert.match(error.message, /content missing/, caseId);
        continue;
      }
      const patches = editorRewrite(doc, id);
      if (Object.hasOwn(KNOWN_DISAGREEMENTS, caseId)) {
        if (patches.length) seen.add(caseId);
        continue;
      }
      assert.deepEqual(patches, [], `${literal ? "literal" : "agent"} ${caseId}`);
    }
  }
  // A listed case that stops disagreeing should leave the list.
  assert.deepEqual(
    Object.keys(KNOWN_DISAGREEMENTS).filter((caseId) => !seen.has(caseId)),
    [],
  );
  // create_page goes through the same writer.
  let doc = A.from(createPageData({ pageId: "projection", title: "Projection" }));
  doc = A.change(doc, (draft) => initializePage(draft, "Intro\n\n- a\n- b"));
  assert.deepEqual(editorRewrite(doc, orderedBlockIds(doc)[0]), []);
});
