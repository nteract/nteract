// Tests only. Fixtures that start from a block's Markdown `markdown` field.
import { COMMENTS_FEATURE } from "./comments-doc.mjs";
import { setRichMarkdown } from "./richtext-page.mjs";
import { stampFeatures } from "./schema-features.mjs";
import * as A from "@automerge/automerge/slim";
import { encode } from "./wordgard-doc.mjs";

/** Noncanonical opening paragraph for refusal and text-limit fixtures. */
export const explicitOpeningSpans = (tree) => [
  {
    type: "block",
    value: { type: new A.ImmutableString("paragraph"), parents: [], attrs: {}, isEmbed: false },
  },
  ...encode(tree),
];

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
