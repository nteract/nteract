import { Node } from "wordgard/doc";
import { GardSelection, GardState, Transaction } from "wordgard/state";
import { Decoration } from "wordgard/editor";
import { Code } from "./wordgard-model.mjs";

// `!=` and `->` are drawn as `≠` and `→`, but only drawn: the document keeps
// the two typed characters, so Markdown export, copy and agent reads see `!=`
// and `->`. A range decoration wraps each pair in a span carrying the symbol
// in `data-symbol`; wordgard.css makes the two characters transparent and
// paints the symbol over them with a pseudo-element. The DOM text stays the
// typed pair, so a native selection copies `!=` / `->` too.
//
// The pair is still two characters, so there is a caret position between
// them. The appender below never leaves the caret there: it moves on to the
// far side in the direction the caret came from, so arrow keys step over the
// symbol as one unit and a click in the middle snaps to the nearer side.

export const SYMBOLS = { "!=": "\u2260", "->": "\u2192" };
const PAIR = /!=|->/g;

const decos = new Map(
  Object.entries(SYMBOLS).map(([pair, symbol]) => [
    pair,
    Decoration.Range.wrapper("span", {
      attributes: { class: "wg-symbol", "data-symbol": symbol },
      spanning: true,
    }),
  ]),
);

// Every drawn pair as [from, to, pair], in document order. A pair is drawn
// only when both characters are plain text outside code: not in a code block,
// not under the inline code mark.
export function symbolRanges(doc) {
  const ranges = [];
  // Text nodes can split a pair (a mark boundary between `!` and `=`), so
  // scan each textblock's text rather than single text nodes.
  doc.iterate((node, pos) => {
    if (node.type.hasRole(Node.Role.Code)) return false;
    if (!node.isTextblock) return true;
    let text = "";
    const starts = [];
    let at = pos + 1;
    for (const child of node.content) {
      const plain = child.isText && !Code.isInSet(child.marks);
      const piece = child.isText ? child.param : "\ufffc".repeat(child.length);
      for (let i = 0; i < piece.length; i++) {
        starts.push(plain ? at + i : -1);
      }
      text += plain ? piece : "\ufffc".repeat(piece.length);
      at += child.length;
    }
    for (const match of text.matchAll(PAIR)) {
      const from = starts[match.index];
      if (from < 0 || starts[match.index + 1] !== from + 1) continue;
      ranges.push([from, from + 2, match[0]]);
    }
    return false;
  });
  return ranges;
}

const symbols = GardState.Field.define({
  create: (state) => symbolRanges(state.doc),
  update: (ranges, tr) => (tr.docChanged ? symbolRanges(tr.newDoc) : ranges),
});

function inside(ranges, pos) {
  return ranges.find(([from, to]) => from < pos && pos < to);
}

// Where a selection end at `pos` should go when it moved there from `before`.
function skip(ranges, pos, before) {
  const range = inside(ranges, pos);
  if (!range) return pos;
  const [from, to] = range;
  if (before <= from) return to;
  if (before >= to) return from;
  return pos - from <= to - pos ? from : to;
}

const caretSkip = Transaction.appender.of((trs, state) => {
  if (!trs.some((tr) => tr.selection)) return null;
  const ranges = state.field(symbols, false);
  if (!ranges?.length) return null;
  const { anchor, head } = state.selection;
  if (!inside(ranges, head) && !inside(ranges, anchor)) return null;
  // The caret's previous place, mapped into the current document.
  let before = trs[0].startState.selection.head;
  for (const tr of trs) before = tr.changes.mapPos(before, 1);
  const newHead = skip(ranges, head, before);
  const newAnchor = anchor === head ? newHead : skip(ranges, anchor, newHead);
  if (newHead === head && newAnchor === anchor) return null;
  return { selection: GardSelection.Text.create({ anchor: newAnchor, head: newHead }) };
});

export const displaySymbols = [
  symbols,
  caretSkip,
  Decoration.Range.source.of((state) =>
    Decoration.Range.set(
      state.field(symbols).map(([from, to, pair]) => [decos.get(pair), from, to]),
    ),
  ),
];
