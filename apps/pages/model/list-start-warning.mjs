import { tokenizer } from "./markdown-tokenizer.mjs";
import { normalizeSource } from "./markdown-scan.mjs";

/** At most this many renumbered lists are named in one warning. */
const MAX_LISTS = 32;
/** A list is named by the start of its first item's text, cut to this length. */
const MAX_PREVIEW = 80;
// A line that could open an ordered list starting at a number other than 1.
// Only Markdown that has one is tokenized again.
const maybeRenumbered = /^[ \t>]*(?:\d{2,9}|[02-9])[.)][ \t]/m;

/**
 * Pages stores ordered lists without a start number, so an imported list that
 * started at 3 reads back starting at 1. The content is kept; only the
 * numbers change. This advisory names each such list so the writer can
 * relabel text that depends on the numbers. Returns null when every ordered
 * list starts at 1. It never refuses or changes the write.
 */
export function listStartWarning(markdown) {
  if (typeof markdown !== "string" || !maybeRenumbered.test(markdown)) return null;
  let tokens;
  try {
    tokens = tokenizer.parse(normalizeSource(markdown), {});
  } catch {
    // An advisory never rejects a write the import itself accepted.
    return null;
  }
  const lists = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "ordered_list_open") continue;
    const start = Number(token.attrGet("start") ?? 1);
    if (start === 1) continue;
    const first = tokens.slice(index + 1).find((next) => next.type === "inline");
    const text = (first?.content ?? "").split("\n")[0];
    lists.push({
      start,
      first_item: text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}…` : text,
    });
  }
  if (!lists.length) return null;
  return {
    code: "list_numbers_reset",
    lists: lists.slice(0, MAX_LISTS),
    ...(lists.length > MAX_LISTS && { lists_truncated: true }),
    suggested_action:
      "Pages numbers every ordered list from 1, so these lists now read 1, 2, 3. The items are unchanged. If your text refers to the old numbers, relabel the items or the references.",
  };
}
