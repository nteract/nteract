import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export const attributionKey = new PluginKey("pages-attribution");

// Transient illumination of a received change batch, not persistent character
// authorship. The binding supplies actors from Automerge change metadata.
export function richAttribution(replica, now = Date.now) {
  return new Plugin({
    key: attributionKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, previous) {
        let marks = previous.map(tr.mapping, tr.doc);
        marks = marks.remove(marks.find().filter((mark) => mark.spec.expires <= now()));
        const actors = tr.getMeta(attributionKey);
        if (!Array.isArray(actors) || !actors.length) return marks;
        const title = [...new Set(actors.map((actor) => replica.actorDisplayName(actor)))].join(
          ", ",
        );
        const added = [];
        tr.mapping.maps.forEach((map, index) => {
          map.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
            if (newFrom === newTo) return; // Deletions aren't new text.
            const later = tr.mapping.slice(index + 1);
            const from = later.map(newFrom, 1),
              to = later.map(newTo, -1);
            if (from >= to) return;
            tr.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isText) return;
              added.push(
                Decoration.inline(
                  Math.max(from, pos),
                  Math.min(to, pos + node.nodeSize),
                  {
                    class: "remote-edit",
                    title: `Edited by ${title}`,
                  },
                  { expires: now() + 2000, actors },
                ),
              );
            });
          });
        });
        return marks.add(tr.doc, added);
      },
    },
    props: { decorations: (state) => attributionKey.getState(state) },
    view(view) {
      const timer = setInterval(() => {
        if (!view.composing && attributionKey.getState(view.state).find().length)
          view.dispatch(view.state.tr.setMeta("addToHistory", false));
      }, 200);
      return { destroy: () => clearInterval(timer) };
    },
  });
}
