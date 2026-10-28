import * as A from "@automerge/automerge/slim";
import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { pmRangeToAmRange, amSpliceIdxToPmIdx } from "@automerge/prosemirror/dist/traversal.js";
import { adapter, textPath } from "../model/richtext.mjs";
import { activityIdentity, progressPassages } from "./activity.mjs";

// These traversal APIs are pinned to the same binding version as rich-binding.
export function publishRichSelection(replica, id, view) {
  if (!view.hasFocus() || !replica.doc?.blocks[id]) return;
  const doc = replica.doc,
    path = textPath(id);
  const range = pmRangeToAmRange(adapter, A.spans(doc, path), view.state.selection);
  if (range)
    replica.publishPresence({
      block_id: id,
      start: A.getCursor(doc, path, range.start, "after"),
      end: A.getCursor(doc, path, range.end, "before"),
      backward: view.state.selection.anchor > view.state.selection.head,
      heads: A.getHeads(doc),
    });
}
export function richPresence(replica, id) {
  return new Plugin({
    props: {
      decorations(state) {
        const doc = replica.doc;
        if (!doc?.blocks[id]) return DecorationSet.empty;
        const path = textPath(id),
          spans = A.spans(doc, path),
          decorations = [];
        for (const [session, { value, at, displayName }] of replica.peers) {
          if (value.block_id !== id || Date.now() - at > 30000 || !A.hasHeads(doc, value.heads))
            continue;
          try {
            const from = amSpliceIdxToPmIdx(
              adapter,
              spans,
              A.getCursorPosition(doc, path, value.start),
            );
            const to = amSpliceIdxToPmIdx(
              adapter,
              spans,
              A.getCursorPosition(doc, path, value.end),
            );
            if (
              from === null ||
              to === null ||
              from > state.doc.content.size ||
              to > state.doc.content.size
            )
              continue;
            if (from < to)
              decorations.push(Decoration.inline(from, to, { class: "peer-selection" }));
            decorations.push(
              Decoration.widget(
                value.backward ? from : to,
                () => {
                  const caret = document.createElement("span");
                  caret.className = "peer-caret";
                  caret.contentEditable = "false";
                  const label = document.createElement("span");
                  label.textContent = displayName || "Device " + session.slice(0, 4);
                  caret.append(label);
                  return caret;
                },
                { key: `${session}:${displayName || ""}`, side: 1 },
              ),
            );
          } catch {
            /* Deleted/unavailable cursors stay hidden until the next presence message. */
          }
        }
        for (const passage of progressPassages(replica)) {
          if (passage.block_id !== id) continue;
          const from = amSpliceIdxToPmIdx(adapter, spans, passage.start_utf16);
          const to = amSpliceIdxToPmIdx(adapter, spans, passage.end_utf16);
          if (from === null || to === null || from >= to || to > state.doc.content.size) continue;
          decorations.push(
            Decoration.inline(from, to, {
              class: "agent-progress-passage",
              title: `${activityIdentity(passage.progress).label}: ${passage.progress.message}`,
              "data-progress-id": passage.progress.progress_id,
              "data-progress-target": String(passage.index),
            }),
          );
        }
        return DecorationSet.create(state.doc, decorations);
      },
    },
    view(view) {
      const layout = () => {
        for (const caret of view.dom.querySelectorAll(".peer-caret")) {
          const label = caret.firstElementChild;
          if (!label) continue;
          const right = window.innerWidth - caret.getBoundingClientRect().left - 16;
          label.style.left = label.offsetWidth > right ? "auto" : "-2px";
          label.style.right = label.offsetWidth > right ? "0" : "auto";
        }
      };
      const paint = () => {
        if (!view.composing) view.dispatch(view.state.tr.setMeta("addToHistory", false));
      };
      const stop = replica.watchPresence(paint),
        timer = setInterval(paint, 1000);
      return {
        update: layout,
        destroy() {
          stop();
          clearInterval(timer);
        },
      };
    },
  });
}

// Keep the same Automerge indices used for presence and comment cursors.
export function richCommentSelection(replica, id, state) {
  const doc = replica.doc;
  if (!doc?.blocks[id] || state.selection.empty) return null;
  const range = pmRangeToAmRange(adapter, A.spans(doc, textPath(id)), state.selection);
  if (!range) return null;
  const source = doc.blocks[id].richText;
  const text = source.slice(range.start, range.end);
  if (!text || !text.replaceAll("\ufffc", "").trim()) return null;
  let occurrence = 0,
    index = -1;
  while ((index = source.indexOf(text, index + 1)) >= 0 && index <= range.start) occurrence++;
  return { text, occurrence };
}
