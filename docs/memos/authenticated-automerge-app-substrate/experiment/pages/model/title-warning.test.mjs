import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyPageOperation, projectPage } from "./page.mjs";
import { enableRich, setRichMarkdown, textPath } from "./richtext.mjs";
import { openingTitleWarning } from "./title-warning.mjs";

function page(title, blocks) {
  return A.change(A.from({ title, blocks: {}, comments: {} }), (doc) => {
    for (const [index, entry] of blocks.entries()) {
      const { id = `block-${index}`, markdown, rich = true, kind = "markdown", position } = entry;
      doc.blocks[id] = {
        id,
        kind,
        position: new A.RawString(position ?? `a${index}`),
        markdown,
      };
      if (rich) enableRich(doc, id);
    }
  });
}
function warning(title, markdown, options = {}) {
  return openingTitleWarning(page(title, [{ markdown, ...options }]));
}

test("an opening native heading produces bounded plain feedback without changing the document", () => {
  const doc = page("Shared document foundation", [
      {
        id: "actual-block",
        markdown: "## **Shared** [document](https://example.com) foundation\n\nBody.",
      },
    ]),
    before = A.save(doc),
    heads = A.getHeads(doc),
    projected = projectPage(doc),
    result = openingTitleWarning(doc);
  assert.deepEqual(result, {
    code: "opening_heading_repeats_title",
    block_id: "actual-block",
    heading: "Shared document foundation",
    match_kind: "normalized_exact",
    suggested_action:
      "The Page already displays its title above the body. Consider removing or rewording this opening heading if the repetition is unintended; the content was preserved.",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(A.save(doc), before);
  assert.deepEqual(A.getHeads(doc), heads);
  assert.deepEqual(projectPage(doc), projected);
});

test("matching uses native text rather than stale import provenance", () => {
  let doc = page("Current title", [{ markdown: "# Original title" }]);
  doc = A.change(doc, (draft) => setRichMarkdown(draft, "block-0", "# Current title"));
  assert.equal(doc.blocks["block-0"].markdown, "# Original title");
  assert.equal(openingTitleWarning(doc).heading, "Current title");
  doc = A.change(doc, (draft) => setRichMarkdown(draft, "block-0", "Opening prose."));
  assert.equal(openingTitleWarning(doc), null);
});

test("normalization accepts typography and Unicode composition but retains meaningful distinctions", () => {
  for (const [title, heading] of [
    ["nteract — Shared Docs!", "NTERACT: shared docs"],
    ["nteract’s shared document", "nteract's SHARED document."],
    ["Café release plan", "Cafe\u0301 release plan"],
    ["Full width title", "Ｆｕｌｌ　ｗｉｄｔｈ　ｔｉｔｌｅ"],
    ["Plan", "Plan"],
  ])
    assert.equal(warning(title, `# ${heading}`)?.match_kind, "normalized_exact", heading);
  for (const [title, heading] of [
    ["C++ release plan", "C# release plan"],
    ["C# release plan", "C release plan"],
    ["Café release plan", "Cafe release plan"],
    ["Version 1.2 plan", "Version 12 plan"],
    ["Plan -1", "Plan 1"],
    ["Meet at 12:30", "Meet at 12 30"],
    ["!!!", "!!!"],
  ])
    assert.equal(warning(title, `# ${heading}`), null, heading);
});

test("the reported long title plus one internal word warns in either direction", () => {
  const title = "Open-Weight AI Is Closing the Gap",
    heading = "Open-Weight AI Is Closing the Practical Gap";
  assert.equal(warning(title, `# ${heading}`).match_kind, "near_match");
  assert.equal(warning(heading, `## ${title}`).match_kind, "near_match");
});

test("near matching avoids short titles, ordinary substrings, changed claims and reordered words", () => {
  for (const [title, heading] of [
    ["Release plan", "Release practical plan"],
    ["Plan", "Planning"],
    ["Open-Weight AI Is Closing the Gap", "Open-Weight AI Is Closing the Gap: checklist"],
    ["Open-Weight AI Is Closing the Gap", "Why Open-Weight AI Is Closing the Gap"],
    ["Open-Weight AI Is Closing the Gap", "Open-Weight AI Is Not Closing the Gap"],
    ["Open-Weight AI Is Closing the Gap", "Open-Weight AI Is Closing the 2026 Gap"],
    ["Open-Weight AI Is Closing the Gap", "Open-Weight AI Is Closing the Very Practical Gap"],
    ["Open-Weight AI Is Closing the Gap", "Open-Weight AI Is Widening the Gap"],
    ["Open-Weight AI Is Closing the Gap", "AI Open-Weight Is Closing the Gap"],
    ["Very Very Very Very Long Long", "Very Very Very Very Practical Long Long"],
  ])
    assert.equal(warning(title, `# ${heading}`), null, heading);
});

test("only the first nonempty top-level text node can be a duplicate title", () => {
  for (const opening of [
    "Opening paragraph.",
    "# Different heading",
    "> # Shared title",
    "- Shared title",
    "- # Shared title",
    "```markdown\n# Shared title\n```",
    "```\n```",
    "![Shared title](https://example.com/image.png)",
    "| Shared title |\n| --- |\n| Cell |",
    "<aside>Shared title</aside>",
  ]) {
    assert.equal(warning("Shared title", `${opening}\n\n# Shared title`), null, opening);
    assert.equal(
      openingTitleWarning(
        page("Shared title", [{ markdown: opening }, { markdown: "# Shared title" }]),
      ),
      null,
      `separate blocks: ${opening}`,
    );
  }
});

test("empty text nodes are skipped across native blocks using fractional order and stable IDs", () => {
  const doc = page("Shared title", [
    { id: "last-in-view", markdown: "# Different heading", position: "a2" },
    { id: "second-in-view", markdown: "# Shared title", position: "a1" },
    { id: "first-in-view", markdown: "\n\n", position: "a0" },
  ]);
  assert.equal(openingTitleWarning(doc).block_id, "second-in-view");
  const tied = page("Shared title", [
    { id: "b", markdown: "# Shared title", position: "a0" },
    { id: "a", markdown: "Opening paragraph.", position: "a0" },
  ]);
  assert.equal(openingTitleWarning(tied), null);
});

test("Markdown-only blocks use the native parser without guessing inside unknown content", () => {
  assert.equal(
    warning("Shared title", "# Shared title", { rich: false }).match_kind,
    "normalized_exact",
  );
  assert.equal(
    warning("Shared title", "Shared title\n===", { rich: false }).match_kind,
    "normalized_exact",
  );
  assert.equal(
    warning("Shared title", "# Shared title", { rich: false, kind: "instruction" }),
    null,
  );
  assert.equal(warning("Shared title", "<aside>\n# Shared title\n</aside>", { rich: false }), null);
  assert.equal(warning("Shared title", "***\n\n# Shared title", { rich: false }), null);
  assert.equal(
    openingTitleWarning({ title: "Shared title", blocks: { bad: { kind: "unknown" } } }),
    null,
  );
  assert.equal(
    openingTitleWarning({
      title: "Shared title",
      blocks: { bad: { format: "future-format", markdown: "# Shared title" } },
    }),
    null,
  );
  assert.equal(
    openingTitleWarning({
      title: "Shared title",
      blocks: { bad: { format: "automerge-rich-text-v1" } },
    }),
    null,
  );
  assert.equal(openingTitleWarning(null), null);
});

test("current post-batch title and block order determine the warning", () => {
  let doc = page("Original title", [
    { id: "intro", markdown: "Opening prose." },
    { id: "heading", markdown: "# Current title" },
  ]);
  assert.equal(openingTitleWarning(doc), null);
  doc = A.change(doc, (draft) =>
    applyPageOperation(draft, {
      operation: "edit_page",
      arguments: {
        operations: [
          { op: "set_title", title: "Current title" },
          { op: "move_block", block_id: "heading", after_block_id: null },
        ],
      },
    }),
  );
  assert.equal(openingTitleWarning(doc).block_id, "heading");
  doc = A.change(doc, (draft) =>
    applyPageOperation(draft, {
      operation: "edit_page",
      arguments: { operations: [{ op: "delete_block", block_id: "heading" }] },
    }),
  );
  assert.equal(openingTitleWarning(doc), null);
});

test("heading echoes are bounded at a Unicode boundary and marked when truncated", () => {
  const heading = '"'.repeat(1022) + "X🌊";
  const result = warning("X🌊", `# ${heading}`);
  assert.equal(result.match_kind, "normalized_exact");
  assert.equal(result.heading.length, 1023);
  assert.equal(result.heading, heading.slice(0, 1023));
  assert.equal(result.heading_truncated, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length < 8192);
  assert.equal(warning("X", `# ${"X".repeat(8193)}`), null);
});

test("an empty native heading is skipped but an image in a heading is substantive", () => {
  let doc = page("Shared title", [{ markdown: "# Empty\n\n# Shared title" }]);
  doc = A.change(doc, (draft) => {
    const start = draft.blocks["block-0"].richText.indexOf("Empty");
    A.splice(draft, textPath("block-0"), start, "Empty".length, "");
  });
  assert.equal(openingTitleWarning(doc).heading, "Shared title");
  assert.equal(
    warning("Shared title", "# ![image](https://example.com/image.png)\n\n# Shared title"),
    null,
  );
  assert.equal(
    warning("Shared title", "# Shared title ![image](https://example.com/image.png)"),
    null,
  );
});
