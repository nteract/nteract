// Tests only. Fixtures that start from a block's Markdown `markdown` field.
import { COMMENTS_FEATURE } from "./comments-doc.mjs";
import { setRichMarkdown } from "./richtext-page.mjs";
import { stampFeatures } from "./schema-features.mjs";
import * as A from "@automerge/automerge/slim";
import { encode } from "./wordgard-doc.mjs";

/** Spans out of the editor's form, for refusal fixtures: one paragraph whose
 * newline is stored as text, where the editor writes a hard break. */
export const proseNewlineSpans = (text = "One\nTwo") => [
  {
    type: "block",
    value: { type: new A.ImmutableString("paragraph"), parents: [], attrs: {}, isEmbed: false },
  },
  { type: "text", value: text, marks: {} },
];

/** `tree`'s spans with its opening marker left out: unmarked text, as a
 * merge can leave it (decode in wordgard-doc.mjs). */
export const unmarkedSpans = (tree) => encode(tree).slice(1);

/** Inside an `A.change`: give block `id` rich text parsed from the Markdown
 * in its `markdown` seed field, math and HTML kept as text, and drop the seed.
 * A fixture block is `{ position, markdown }`; the block it leaves is a stored
 * one, `{ position, richText }`. */
export function richFromSource(doc, id) {
  const block = doc.blocks[id];
  const markdown = block.markdown ?? "";
  delete block.markdown;
  block.richText = "";
  setRichMarkdown(doc, id, markdown, { literal: true });
}

/** Inside an `A.change`: every block that still holds a Markdown seed in rich
 * text, and the `comments-doc` stamp, the forms every stored Page is in. */
export function currentForm(doc) {
  for (const [id, block] of Object.entries(doc.blocks ?? {}))
    if (typeof block.richText !== "string") richFromSource(doc, id);
  stampFeatures(doc, [COMMENTS_FEATURE]);
}

/** Merges that leave a container whose own marker is gone while a node a
 * peer added inside it survives (decode's `rebuilt`). Each case is the
 * Markdown both writers start from, and the markers the second writer adds,
 * as Enter at the end of the container's last text writes them, before
 * typing "new" there. The first writer deletes everything before "After". */
export const MISSING_ANCESTOR_CASES = {
  quote: { markdown: "> One\n\nAfter", markers: [["paragraph", ["blockquote"]]] },
  "list middle level": {
    markdown: "- a\n  - b\n\nAfter",
    markers: [
      ["unordered-list-item", ["unordered-list-item"]],
      ["paragraph", ["unordered-list-item", "unordered-list-item"]],
    ],
  },
  "task item": {
    markdown: "- [x] a\n  - b\n\nAfter",
    markers: [
      ["unordered-list-item", ["task-list-item"]],
      ["paragraph", ["task-list-item", "unordered-list-item"]],
    ],
  },
  table: {
    markdown: "| h |\n| --- |\n| c |\n\nAfter",
    markers: [
      ["table-row", ["table"]],
      ["table-cell", ["table", "table-row"]],
    ],
  },
  "table row": {
    markdown: "| h |\n| --- |\n| c |\n\nAfter",
    markers: [["table-cell", ["table", "table-row"]]],
  },
};

const stored = (spans) =>
  spans.reduce((out, span) => out + (span.type === "text" ? span.value : "￼"), "");

/** Inside an `A.change`: the first writer's edit for a MISSING_ANCESTOR_CASES
 * case on the text at `path`, which deletes everything before "After". */
export function deleteContainer(doc, path) {
  A.splice(doc, path, 0, stored(A.spans(doc, path)).indexOf("After") - 1);
}

/** Inside an `A.change`: the second writer's edit, which adds `markers` and
 * "new" right after the last text before "After". */
export function addInside(doc, path, markers) {
  const text = stored(A.spans(doc, path));
  const end = text.slice(0, text.indexOf("After") - 1).replace(/￼+$/, "").length;
  markers.forEach(([type, parents], index) =>
    A.splitBlock(doc, path, end + index, {
      type: new A.ImmutableString(type),
      parents: parents.map((parent) => new A.ImmutableString(parent)),
      attrs: {},
      isEmbed: false,
    }),
  );
  A.splice(doc, path, end + markers.length, 0, "new");
}
