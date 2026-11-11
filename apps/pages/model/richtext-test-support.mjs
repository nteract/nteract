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
