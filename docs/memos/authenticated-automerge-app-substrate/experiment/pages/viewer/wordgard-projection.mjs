// Adapted from rgbkrk/wordgard-automerge c9c6ea8 (BSD-3-Clause).
import { diffArrays } from "diff";
import { Leaf, Plot, ChangeSet } from "wordgard/doc";
function units(doc) {
  const result = [];
  const visit = (node) => {
    if (node.isText)
      for (const char of String(node.param))
        result.push({
          key: `text:${char}`,
          token: Leaf.text(char, node.marks),
          length: char.length,
          marks: node.marks,
          text: true,
        });
    else if (node.isPlot) {
      result.push({ key: JSON.stringify(node.tag.toJSON()), token: node.tag, length: 1 });
      node.content.forEach(visit);
      result.push({ key: "close", token: Plot.End, length: 1 });
    } else result.push({ key: JSON.stringify(node.toJSON()), token: node, length: node.length });
  };
  doc.content.forEach(visit);
  return result;
}
export function projectChanges(before, after) {
  if (before.eq(after)) return ChangeSet.empty(before.length);
  const old = units(before),
    next = units(after),
    specs = [];
  let a = 0,
    b = 0,
    pos = 0,
    replacement = null;
  const flush = () => {
    if (replacement) specs.push(replacement);
    replacement = null;
  };
  for (const part of diffArrays(old, next, { comparator: (x, y) => x.key === y.key })) {
    if (part.added || part.removed) {
      replacement ??= { from: pos, to: pos, insert: [] };
      if (part.removed) {
        for (const unit of part.value) {
          pos += unit.length;
          a++;
        }
        replacement.to = pos;
      } else {
        replacement.insert.push(...part.value.map((unit) => unit.token));
        b += part.count;
      }
    } else {
      flush();
      for (let i = 0; i < part.count; i++) {
        const previous = old[a++],
          current = next[b++];
        if (previous.text) {
          for (const mark of previous.marks)
            if (!current.marks.some((m) => m.eq(mark)))
              specs.push({ from: pos, to: pos + previous.length, remove: mark });
          for (const mark of current.marks)
            if (!previous.marks.some((m) => m.eq(mark)))
              specs.push({ from: pos, to: pos + previous.length, add: mark });
        }
        pos += previous.length;
      }
    }
  }
  flush();
  const result = ChangeSet.create(before, specs);
  if (!result.apply(before).eq(after))
    throw Error("Wordgard projection did not reproduce the Pages document");
  return result;
}
