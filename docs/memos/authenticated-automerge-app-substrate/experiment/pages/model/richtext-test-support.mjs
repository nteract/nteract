// Tests only. Fixtures that start from a block's Markdown `markdown` field.
import { COMMENTS_FEATURE } from "./comments-doc.mjs";
import { RICH_FORMAT, isRich } from "./richtext-format.mjs";
import { setRichMarkdown } from "./richtext-page.mjs";
import { stampFeatures } from "./schema-features.mjs";

/** Inside an `A.change`: give block `id` rich text parsed from its
 * `markdown` field, math and HTML kept as text. */
export function richFromSource(doc, id) {
  const block = doc.blocks[id];
  block.format = RICH_FORMAT;
  block.richText = "";
  setRichMarkdown(doc, id, block.markdown, { literal: true });
}

/** Inside an `A.change`: every block in rich text from its `markdown` field,
 * and the `comments-doc` stamp, the forms every stored Page is in. */
export function currentForm(doc) {
  for (const [id, block] of Object.entries(doc.blocks ?? {}))
    if (!isRich(block)) {
      block.markdown ??= "";
      richFromSource(doc, id);
    }
  stampFeatures(doc, [COMMENTS_FEATURE]);
}
