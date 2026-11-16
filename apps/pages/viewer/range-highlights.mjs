import { Decoration } from "wordgard/editor";
import { PagesView } from "./wordgard-model.mjs";

// Text needs a wrapper to carry a range highlight. Views already have a stable
// element: wrapping or unwrapping it reparents and reloads its iframe.
export function rangeHighlights(doc, from, to, attributes) {
  const entries = [];
  let start = from;
  const text = (end) => {
    if (start < end) entries.push([Decoration.Range.wrapper("span", { attributes }), start, end]);
  };
  doc.iterate(from, to, (node, pos) => {
    if (node.type !== PagesView) return;
    text(pos);
    const end = Math.min(to, pos + node.length);
    for (const [name, value] of Object.entries(attributes))
      entries.push([
        Decoration.Range.attribute(name, value, { query: PagesView }),
        Math.max(from, pos),
        end,
      ]);
    start = end;
    return false;
  });
  text(to);
  return entries;
}
