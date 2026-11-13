import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Wordgard mounts real DOM: give it a jsdom window.
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
for (const name of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Text",
  "Range",
  "Selection",
  "DocumentFragment",
  "ShadowRoot",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "customElements",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "InputEvent",
  "FocusEvent",
  "MouseEvent",
])
  globalThis[name] ??= dom.window[name];
const empty = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 });
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = empty;
dom.window.document.elementFromPoint = () => null;

const { Wordgard, Decoration, Widget } = await import("wordgard/editor");
const { GardState, Transaction } = await import("wordgard/state");
const { Elt, Leaf } = await import("wordgard/doc");
const { RangeSet } = await import("wordgard/set");
const { schema, decode, CodeBlock } = await import("./wordgard-model.mjs");

// A rendered Mermaid diagram is a widget beside the code block's hidden
// content hole (wordgard-widgets.mjs). It mounts the renderer on connect and
// tears it down on disconnect, so a widget left drawn but disconnected stays
// at "Rendering diagram…".
const lifecycle = [];
const probe = Widget.define({
  eq: (a, b) => a === b,
  render: () => document.createElement("section"),
  connect: (_value, element) => lifecycle.push(["connect", element]),
  disconnect: (_value, element) => lifecycle.push(["disconnect", element]),
});
const movePeer = Transaction.Effect.define();
const peerSelection = GardState.Field.define({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(movePeer))
        return RangeSet.create((add) =>
          add(
            Decoration.Range.attribute("class", "peer-selection"),
            effect.value,
            effect.value + 2,
          ),
        );
    return value.map(tr.changes);
  },
});

test("a peer's selection moving inside a shaped code block keeps its widget connected", () => {
  const block = {
    type: "block",
    value: { type: "code-block", parents: [], attrs: { params: "mermaid" }, isEmbed: false },
  };
  const state = GardState.create({
    doc: decode([block, { type: "text", value: "graph TD\nA --> B" }]).doc,
    config: [
      ...schema.elements.map((e) => GardState.schemaElement.of(e)),
      peerSelection,
      Decoration.Range.source.of((s) => s.field(peerSelection)),
      Decoration.Point.source.of((s) => {
        const shapes = [];
        s.doc.iterate((node, pos) => {
          if (node.type !== CodeBlock.type) return;
          const hole = Elt.mk("pre", { hidden: "" }, [0]);
          shapes.push([
            Decoration.Point.shape(Elt.mk("div", { class: "shape" }, [probe.of("diagram"), hole])),
            pos,
          ]);
          return false;
        });
        return Decoration.Point.set(shapes);
      }),
    ],
  });
  const editor = new Wordgard({ state, parent: document.body });
  try {
    editor.flush();
    for (const at of [2, 5, 8]) {
      editor.dispatch({ effects: movePeer.of(at) });
      editor.flush();
    }
    editor.dispatch({ changes: { from: 3, insert: [Leaf.text("x")] } });
    editor.flush();
    const drawn = editor.dom.querySelector(".shape > section");
    const events = lifecycle.filter(([, element]) => element === drawn).map(([event]) => event);
    assert.deepEqual(events, ["connect"]);
  } finally {
    editor.dom.remove();
  }
});
