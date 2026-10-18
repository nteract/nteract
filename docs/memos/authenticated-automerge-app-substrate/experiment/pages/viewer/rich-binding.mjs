import * as A from "@automerge/automerge/slim";
import { init } from "@automerge/prosemirror";
import { Plugin } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import { adapter, richDoc, textPath } from "../model/richtext.mjs";
import { attributionKey } from "./rich-attribution.mjs";

// Repo owns the document and patch stream. This facade adds only the editor's
// received-batch label and the pinned binding's paragraph-join repair.
export function bindRichEditor(replica, id) {
  let incomingActors = [];
  const stops = new Map();
  const handle = {
    doc: () => replica.doc,
    change: (fn) => replica.change(fn),
    on(event, fn) {
      if (event !== "change") return;
      stops.set(
        fn,
        replica.observeChange((change) => {
          // React unmounts after the shared change reaches its subscribers.
          // The pinned binding cannot project a text path that was just deleted.
          if (!change.patchInfo.after.blocks?.[id]) return;
          incomingActors = change.remote
            ? [
                ...new Set(
                  A.getChangesMetaSince(
                    change.patchInfo.after,
                    A.getHeads(change.patchInfo.before),
                  ).map((c) => c.actor),
                ),
              ]
            : [];
          try {
            fn({ ...change, handle });
          } finally {
            incomingActors = [];
          }
        }),
      );
    },
    off(_event, fn) {
      stops.get(fn)?.();
      stops.delete(fn);
    },
  };
  const result = init(handle, textPath(id), { schemaAdapter: adapter });
  const originalView = result.plugin.spec.view;
  const plugin = new Plugin({
    ...result.plugin.spec,
    view(view) {
      return originalView({
        get state() {
          return view.state;
        },
        dispatch(tr) {
          const block = replica.doc?.blocks?.[id];
          if (!block) return;
          const target = richDoc(block);
          const start = tr.doc.content.findDiffStart(target.content);
          if (start !== null) {
            let { a: endA, b: endB } = tr.doc.content.findDiffEnd(target.content);
            const overlap = start - Math.min(endA, endB);
            if (overlap > 0) {
              endA += overlap;
              endB += overlap;
            }
            tr.replace(start, endA, target.slice(start, endB));
            if (!tr.doc.eq(target)) throw Error("Remote projection diverged");
          }
          // A received edit separates typing gestures. Otherwise rapid local input
          // across an agent edit can undo text written before that collaboration.
          if (incomingActors.length) closeHistory(tr);
          view.dispatch(tr.setMeta("addToHistory", false).setMeta(attributionKey, incomingActors));
        },
      });
    },
  });
  return {
    ...result,
    plugin,
    destroy() {
      for (const stop of stops.values()) stop();
      stops.clear();
    },
  };
}
