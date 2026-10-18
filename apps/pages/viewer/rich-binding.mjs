import * as A from "@automerge/automerge/slim";
import { init } from "@automerge/prosemirror";
import { Plugin } from "prosemirror-state";
import { adapter, richDoc, textPath } from "../src/richtext.mjs";

// The real replica owns persistence and network sync. This facade only exposes
// the DocHandle-shaped patch stream expected by the editor binding.
export function bindRichEditor(replica, id) {
  let before = replica.doc,
    heads = A.getHeads(before);
  const listeners = new Set();
  const handle = {
    doc: () => replica.doc,
    change: (fn) => replica.change(fn),
    on: (_event, fn) => listeners.add(fn),
    off: (_event, fn) => listeners.delete(fn),
  };
  const stop = replica.observe({
    before() {
      before = replica.doc;
      heads = A.getHeads(before);
    },
    after() {
      const doc = replica.doc;
      if (!doc?.blocks[id]?.richText && doc?.blocks[id]?.richText !== "") return;
      const nextHeads = A.getHeads(doc);
      if (heads.slice().sort().join() === nextHeads.slice().sort().join()) return;
      const event = {
        doc,
        handle,
        patches: A.diff(doc, heads, nextHeads),
        patchInfo: { before, after: doc, source: "change" },
      };
      heads = nextHeads;
      before = doc;
      for (const listener of listeners) listener(event);
    },
  });
  let result;
  try {
    result = init(handle, textPath(id), { schemaAdapter: adapter });
  } catch (error) {
    stop();
    throw error;
  }
  const originalView = result.plugin.spec.view;
  const plugin = new Plugin({
    ...result.plugin.spec,
    view(view) {
      return originalView({
        get state() {
          return view.state;
        },
        dispatch(tr) {
          // Upstream 0.2.0 can leave a remote paragraph join stale. Repair the
          // projection while its echo-suppression guard is still active.
          const target = richDoc(replica.doc.blocks[id]);
          const start = tr.doc.content.findDiffStart(target.content);
          if (start !== null) {
            let { a: endA, b: endB } = tr.doc.content.findDiffEnd(target.content);
            const overlap = start - Math.min(endA, endB);
            if (overlap > 0) {
              endA += overlap;
              endB += overlap;
            }
            tr.replace(start, endA, target.slice(start, endB));
            if (!tr.doc.eq(target)) throw Error("Remote rich projection diverged");
          }
          view.dispatch(tr.setMeta("addToHistory", false));
        },
      });
    },
  });
  return { ...result, plugin, destroy: stop };
}
