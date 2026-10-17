import { checkedInit } from "./binding.mjs";
// Research dependency on helpers outside the public barrel, pinned to 0.2.0.
import { pmRangeToAmRange, amSpliceIdxToPmIdx } from "@automerge/prosemirror/dist/traversal.js";
import { EditorState, Plugin } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { markdownPasteSlice } from "./paste.mjs";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark, setBlockType } from "prosemirror-commands";
import { wrapInList, splitListItem, sinkListItem, liftListItem } from "prosemirror-schema-list";
import { history, undo, redo } from "prosemirror-history";
import { A, adapter, pair, synchronize, headsEqual, exportBlock, textPath } from "./model.mjs";

const replicas = pair(),
  views = [new Map(), new Map()],
  activeViews = [],
  anchors = [null, null],
  presence = [null, null],
  delivered = [null, null];
let syncing = false,
  scheduled = false,
  repairs = 0;
const connected = document.querySelector("#connected");
function sync() {
  if (syncing || views.some((group) => [...group.values()].some((view) => view.composing))) return;
  syncing = true;
  try {
    synchronize(...replicas);
    delivered[0] = presence[1];
    delivered[1] = presence[0];
  } finally {
    syncing = false;
    paintPresence();
    inspect();
  }
}
function changed() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (connected.checked && !syncing) sync();
    inspect();
  });
}
function remotePosition(i, id) {
  const entry = delivered[i],
    doc = replicas[i].doc();
  if (
    !entry ||
    entry.blockId !== id ||
    Date.now() - entry.at > 30000 ||
    !A.hasHeads(doc, entry.heads)
  )
    return null;
  const path = textPath(id),
    spans = A.spans(doc, path);
  try {
    const from = amSpliceIdxToPmIdx(adapter, spans, A.getCursorPosition(doc, path, entry.start));
    const to = amSpliceIdxToPmIdx(adapter, spans, A.getCursorPosition(doc, path, entry.end));
    if (from === null || to === null) return null;
    return { from, to, head: entry.backward ? from : to, name: replicas[1 - i].name };
  } catch {
    return null;
  }
}
function paintPresence() {
  views.forEach((group, i) =>
    group.forEach((view, id) => {
      if (view.composing) return;
      view.dispatch(view.state.tr.setMeta("presence", true).setMeta("addToHistory", false));
      const caret = view.dom.parentElement.querySelector(".peer-caret"),
        position = remotePosition(i, id);
      caret.hidden = !position;
      if (position) {
        const at = view.coordsAtPos(position.head),
          box = view.dom.parentElement.getBoundingClientRect();
        caret.style.left = `${at.left - box.left}px`;
        caret.style.top = `${at.top - box.top}px`;
        caret.style.height = `${at.bottom - at.top}px`;
        caret.querySelector("span").textContent = position.name;
      }
    }),
  );
}
function publishSelection(i, id, view) {
  const doc = replicas[i].doc(),
    path = textPath(id),
    range = pmRangeToAmRange(adapter, A.spans(doc, path), view.state.selection);
  if (!range) return;
  presence[i] = {
    blockId: id,
    start: A.getCursor(doc, path, range.start, "after"),
    end: A.getCursor(doc, path, range.end, "before"),
    backward: view.state.selection.anchor > view.state.selection.head,
    heads: A.getHeads(doc),
    at: Date.now(),
  };
  if (connected.checked) {
    delivered[1 - i] = presence[i];
    queueMicrotask(paintPresence);
  }
}
function inspect() {
  document.querySelector("#status").textContent = headsEqual(...replicas)
    ? "Same causal heads · converged"
    : "Changes waiting to be shared";
  replicas.forEach((replica, i) => {
    const doc = replica.doc();
    let anchor = null;
    if (anchors[i]) {
      const saved = anchors[i],
        path = textPath(saved.blockId),
        from = A.getCursorPosition(doc, path, saved.start),
        to = A.getCursorPosition(doc, path, saved.end),
        quote = doc.blocks[saved.blockId].richText.slice(from, to);
      anchor = {
        blockId: saved.blockId,
        from,
        to,
        quote,
        status:
          from === to
            ? "collapsed / target deleted"
            : quote === saved.quote
              ? "original quote"
              : "changed quote; review anchor",
        originalQuote: saved.quote,
      };
    }
    document.querySelector(`#inspect-${i ? "b" : "a"}`).textContent = JSON.stringify(
      {
        canonical: "Automerge rich text per stable Page block",
        remoteProjectionRepairs: repairs,
        heads: A.getHeads(doc),
        anchor,
        presence: presence[i],
        blockOrder: doc.blockOrder,
        blocks: Object.fromEntries(
          doc.blockOrder.map((id) => [
            id,
            {
              kind: doc.blocks[id].kind,
              metadata: doc.blocks[id].metadata,
              markdownExport: exportBlock(doc, id),
              originalMarkdown: doc.blocks[id].originalMarkdown,
              spans: A.spans(doc, textPath(id)),
            },
          ]),
        ),
      },
      null,
      2,
    );
  });
}
replicas.forEach((replica, i) => {
  for (const id of replica.doc().blockOrder) {
    const block = replica.doc().blocks[id],
      { schema, pmDoc, plugin } = checkedInit(replica, id, () => {
        repairs++;
      });
    const locked = block.kind === "instruction" || pmDoc.firstChild?.type.name === "raw";
    const presencePlugin = new Plugin({
      props: {
        decorations(state) {
          const p = remotePosition(i, id);
          return p && p.from < p.to
            ? DecorationSet.create(state.doc, [
                Decoration.inline(p.from, p.to, { class: "peer-selection" }),
              ])
            : DecorationSet.empty;
        },
      },
    });
    const keys = {
      "Mod-b": toggleMark(schema.marks.strong),
      "Mod-i": toggleMark(schema.marks.em),
      "Mod-`": toggleMark(schema.marks.code),
      "Mod-z": undo,
      "Mod-Shift-z": redo,
      "Mod-y": redo,
      Enter: splitListItem(schema.nodes.list_item),
      Tab: sinkListItem(schema.nodes.list_item),
      "Shift-Tab": liftListItem(schema.nodes.list_item),
    };
    const mount = document.createElement("div");
    mount.className = "page-block";
    mount.dataset.blockId = id;
    document.querySelector(`#editor-${i ? "b" : "a"}`).append(mount);
    const view = new EditorView(mount, {
      state: EditorState.create({
        schema,
        doc: pmDoc,
        plugins: [plugin, history(), presencePlugin, keymap(keys), keymap(baseKeymap)],
      }),
      editable: () => !locked,
      attributes: {
        "aria-label": `${replica.name}: ${id}`,
        role: "textbox",
        "aria-multiline": "true",
        "aria-readonly": String(locked),
        spellcheck: "true",
      },
      dispatchTransaction(tr) {
        this.updateState(this.state.apply(tr));
        if (!syncing && !tr.getMeta("presence") && (tr.selectionSet || tr.docChanged) && !locked) {
          activeViews[i] = this;
          publishSelection(i, id, this);
        }
      },
      handlePaste(view, event) {
        const html = event.clipboardData?.getData("text/html");
        if (html) {
          const dom = new DOMParser().parseFromString(html, "text/html");
          if (dom.querySelector("table,math,svg,iframe,script,style,video,audio,object,embed")) {
            const raw = schema.node("raw", { source: html, kind: "html", importId: "" });
            view.dispatch(view.state.tr.replaceSelectionWith(raw).scrollIntoView());
            document.querySelector("#notice").textContent =
              "Unsupported rich paste was preserved as an opaque HTML block.";
            return true;
          }
          return false;
        }
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return false;
        view.dispatch(view.state.tr.replaceSelection(markdownPasteSlice(text)).scrollIntoView());
        return true;
      },
      handleDOMEvents: {
        focus() {
          activeViews[i] = view;
          publishSelection(i, id, view);
          return false;
        },
        compositionend() {
          setTimeout(changed, 0);
          return false;
        },
      },
    });
    views[i].set(id, view);
    const caret = document.createElement("div");
    caret.className = "peer-caret";
    caret.hidden = true;
    caret.append(document.createElement("span"));
    mount.append(caret);
    if (!activeViews[i] && !locked) activeViews[i] = view;
  }
  replica.changed = changed;
  const schema = adapter.schema,
    toolbar = document.querySelector(`#toolbar-${i ? "b" : "a"}`);
  const actions = [
    ["Bold", toggleMark(schema.marks.strong)],
    ["Italic", toggleMark(schema.marks.em)],
    ["Code", toggleMark(schema.marks.code)],
    ["Heading", setBlockType(schema.nodes.heading, { level: 2 })],
    ["Paragraph", setBlockType(schema.nodes.paragraph)],
    ["List", wrapInList(schema.nodes.bullet_list)],
    ["Undo", undo],
    ["Redo", redo],
  ];
  for (const [label, command] of actions) {
    const button = document.createElement("button");
    button.textContent = label;
    button.onmousedown = (e) => e.preventDefault();
    button.onclick = () => {
      const view = activeViews[i];
      if (view.editable) {
        command(view.state, view.dispatch, view);
        view.focus();
      }
    };
    toolbar.append(button);
  }
  const anchorButton = document.createElement("button");
  anchorButton.textContent = "Anchor selection";
  anchorButton.onmousedown = (e) => e.preventDefault();
  anchorButton.onclick = () => {
    const view = activeViews[i],
      id = [...views[i]].find(([, v]) => v === view)[0],
      doc = replica.doc(),
      path = textPath(id),
      range = pmRangeToAmRange(adapter, A.spans(doc, path), view.state.selection);
    if (range) {
      anchors[i] = {
        blockId: id,
        start: A.getCursor(doc, path, range.start, "after"),
        end: A.getCursor(doc, path, range.end, "before"),
        quote: doc.blocks[id].richText.slice(range.start, range.end),
      };
      inspect();
      document.querySelector("details").open = true;
    }
  };
  toolbar.append(anchorButton);
});
document.querySelector("#sync").onclick = sync;
connected.onchange = () => {
  if (connected.checked) sync();
  else {
    delivered.fill(null);
    paintPresence();
  }
};
setInterval(paintPresence, 1000);
window.addEventListener("resize", paintPresence);
inspect();
window.workbench = { replicas, views, anchors, presence, delivered, sync, inspect };
