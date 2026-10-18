import { Slice, Fragment } from "prosemirror-model";
import { parseMarkdown, schema } from "./model.mjs";
export function markdownPasteSlice(text) {
  const parsed = parseMarkdown(text);
  if (
    !text.includes("\n") &&
    parsed.childCount === 1 &&
    parsed.firstChild.type.name === "paragraph"
  ) {
    const leading = text.match(/^[ \t]+/)?.[0] ?? "",
      trailing = text.match(/[ \t]+$/)?.[0] ?? "";
    let content = parsed.firstChild.content;
    if (leading) content = Fragment.from(schema.text(leading)).append(content);
    if (trailing && text.trim()) content = content.append(Fragment.from(schema.text(trailing)));
    return new Slice(content, 0, 0);
  }
  return Slice.maxOpen(parsed.content);
}
