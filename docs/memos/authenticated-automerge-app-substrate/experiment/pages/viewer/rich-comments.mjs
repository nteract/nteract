import * as A from "@automerge/automerge/slim";
import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { amSpliceIdxToPmIdx } from "@automerge/prosemirror/dist/traversal.js";
import { selectionContext } from "../model/comments.mjs";
import { orderedBlockIds } from "../model/order.mjs";
import { adapter, isRich, textPath } from "../model/richtext.mjs";

// Resolve the saved Automerge anchors against today's text. Never search for the
// quoted preview: repeated or deleted passages must not attach to another copy.
export function commentRanges(doc, id, threads) {
  const order = orderedBlockIds(doc),
    index = order.indexOf(id);
  if (index < 0 || !isRich(doc.blocks[id])) return [];
  const spans = A.spans(doc, textPath(id));
  return threads.flatMap((thread) => {
    const context = selectionContext(doc, thread.target);
    if (context?.status !== "attached") return [];
    if (index < order.indexOf(context.start.blockId) || index > order.indexOf(context.end.blockId))
      return [];
    const start = context.start.blockId === id ? context.start.offsetUtf16 : 0;
    const end =
      context.end.blockId === id ? context.end.offsetUtf16 : doc.blocks[id].richText.length;
    const from = amSpliceIdxToPmIdx(adapter, spans, start);
    const to = amSpliceIdxToPmIdx(adapter, spans, end);
    return from !== null && to !== null && from < to
      ? [{ id: thread.id, from, to, state: thread.state }]
      : [];
  });
}

export function commentsForSelection(doc, id, selection, threads) {
  const order = orderedBlockIds(doc),
    index = order.indexOf(id);
  if (!selection || index < 0) return [];
  const source = doc.blocks[id].richText ?? doc.blocks[id].markdown;
  let start = -1;
  for (let i = 0; i < selection.occurrence; i++) {
    start = source.indexOf(selection.text, start + 1);
    if (start < 0) return [];
  }
  const end = start + selection.text.length;
  return threads.filter((thread) => {
    if (thread.state !== "open") return false;
    const context = selectionContext(doc, thread.target);
    if (context?.status !== "attached") return false;
    return (
      index >= order.indexOf(context.start.blockId) &&
      index <= order.indexOf(context.end.blockId) &&
      (context.start.blockId !== id || context.start.offsetUtf16 < end) &&
      (context.end.blockId !== id || context.end.offsetUtf16 > start)
    );
  });
}

// A passage can have overlapping threads. Keep the active one when it still
// covers the click; otherwise prefer the most specific surviving passage.
export function commentAtPosition(doc, id, position, threads, active) {
  const matching = commentRanges(doc, id, threads)
    .filter((range) => range.state === "open" && range.from <= position && position < range.to)
    .sort((a, b) => a.to - a.from - (b.to - b.from));
  return matching.find((range) => range.id === active)?.id ?? matching[0]?.id ?? null;
}

export function richComments(replica, id, getThreads, getActive, onReveal) {
  return new Plugin({
    props: {
      // ProseMirror invokes handleClick only for a click, not a dragged text
      // selection. Let its normal caret behavior continue after opening context.
      handleClick(_view, position, event) {
        if (
          event.button !== 0 ||
          event.detail > 1 ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey ||
          event.target.closest?.("a")
        )
          return false;
        const thread = commentAtPosition(replica.doc, id, position, getThreads(), getActive());
        if (thread) onReveal?.(thread);
        return false;
      },
      decorations(state) {
        return DecorationSet.create(
          state.doc,
          commentRanges(replica.doc, id, getThreads())
            .filter((range) => range.state === "open" || range.id === getActive())
            .filter((range) => range.to <= state.doc.content.size)
            .map((range) =>
              Decoration.inline(range.from, range.to, {
                class:
                  "comment-passage" + (range.id === getActive() ? " comment-passage-active" : ""),
              }),
            ),
        );
      },
    },
  });
}

// A decoration is enough to reveal the passage. Don't replace the editor's
// selection or focus it: that opens the mobile keyboard and loses a draft caret.
export function revealCommentPassage(view) {
  if (view.composing) return;
  view.dom.querySelector(".comment-passage-active")?.scrollIntoView({
    block: "center",
    inline: "nearest",
  });
}
