import * as A from "@automerge/automerge/slim";
import { init } from "@automerge/prosemirror";
import { Plugin } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";
import { adapter, richDoc, textPath } from "../model/richtext.mjs";
import { attributionKey } from "./rich-attribution.mjs";

// Repo owns the document and patch stream. This facade adds only the editor's
// received-batch label and repairs for the pinned binding's rich-text projection.
export function bindRichEditor(replica, id) {
  let incomingActors = [];
  let recoverProjection,
    reachedDispatch = false,
    recovering = false;
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
          reachedDispatch = false;
          try {
            fn({ ...change, handle });
          } catch (error) {
            // @automerge/prosemirror 0.2 can construct an invalid intermediate
            // list/doc during a valid structural replacement. It has not armed
            // its echo guard until it enters dispatch. Recover only that case;
            // errors from dispatch/plugins or an invalid final document escape.
            if (
              reachedDispatch ||
              !recoverProjection ||
              !(error instanceof RangeError || error?.name === "TransformError") ||
              !error.message.startsWith("Invalid content for node ")
            )
              throw error;
            recoverProjection(change.patchInfo.after.blocks[id]);
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
    appendTransaction(...args) {
      // Recovery is a projection of an already accepted CRDT change. Applying
      // its editor steps must not write them back as a second local change.
      if (!recovering) return result.plugin.spec.appendTransaction.apply(this, args);
    },
    view(view) {
      const dispatchIncoming = (tr) => {
        // A received edit separates typing gestures. Otherwise rapid local input
        // across an agent edit can undo text written before that collaboration.
        if (incomingActors.length) closeHistory(tr);
        view.dispatch(tr.setMeta("addToHistory", false).setMeta(attributionKey, incomingActors));
      };
      recoverProjection = (block) => {
        const target = richDoc(block);
        target.check();
        const tr = repairProjection(view.state.tr, target);
        recovering = true;
        try {
          dispatchIncoming(tr);
        } finally {
          recovering = false;
        }
      };
      return originalView({
        get state() {
          return view.state;
        },
        dispatch(tr) {
          reachedDispatch = true;
          const block = replica.doc?.blocks?.[id];
          if (!block) return;
          dispatchIncoming(repairProjection(tr, richDoc(block)));
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

// Replace only the differing range so existing selections, comment decorations,
// and undo entries map through the change instead of resetting the editor.
function repairProjection(tr, target) {
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
  return tr;
}
