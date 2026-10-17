import { init } from "@automerge/prosemirror";
import { Plugin } from "prosemirror-state";
import { adapter, projected, textPath } from "./model.mjs";

// Keep the binding's transaction translation and remote-history exclusion. Check
// its remote result against the authoritative spans before exposing it to input.
// 0.2.0 leaves a split paragraph behind after some remote joins (test below).
export function checkedInit(replica, id, onRepair = () => {}) {
  const result = init(replica, textPath(id), { schemaAdapter: adapter });
  const originalView = result.plugin.spec.view;
  const plugin = new Plugin({
    ...result.plugin.spec,
    view(view) {
      return originalView({
        get state() {
          return view.state;
        },
        dispatch(tr) {
          const target = projected(replica.doc(), id);
          const start = tr.doc.content.findDiffStart(target.content);
          if (start !== null) {
            let { a: endA, b: endB } = tr.doc.content.findDiffEnd(target.content);
            const overlap = start - Math.min(endA, endB);
            if (overlap > 0) {
              endA += overlap;
              endB += overlap;
            }
            tr.replace(start, endA, target.slice(start, endB));
            if (!tr.doc.eq(target))
              throw new Error("Remote projection repair did not match canonical Automerge spans");
            onRepair(id);
          }
          // Called while the upstream binding's echo suppression is active. This
          // remains one inbound transaction with addToHistory=false, not a new edit.
          view.dispatch(tr);
        },
      });
    },
  });
  return { ...result, plugin };
}
