import { Decoration, Widget } from "wordgard/editor";
import { GardSelection } from "wordgard/state";
import { PagesImage } from "./wordgard-model.mjs";
import { imageLifecycle } from "./image-lifecycle.mjs";

const mounted = new WeakMap();
const image = Widget.define({
  eq: (a, b) => ["src", "dark_src", "alt", "title"].every((key) => a[key] === b[key]),
  render(attrs, editor) {
    const dom = document.createElement("span");
    dom.className = "pages-image";
    dom.addEventListener("click", (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const found = editor.nodeFromDOM(dom);
      if (!found || found.node.type !== PagesImage) return;
      editor.focus();
      editor.dispatch({
        selection: GardSelection.node(found.pos, found.node),
        userEvent: "select.pointer",
      });
    });
    mounted.set(dom, imageLifecycle(dom, attrs));
    return dom;
  },
  connect(_attrs, dom) {
    mounted.get(dom)?.connect();
  },
  disconnect(_attrs, dom) {
    mounted.get(dom)?.disconnect();
  },
  propagateEvent: () => true,
});

export const wordgardImages = () =>
  Decoration.Tag.shape(PagesImage, (tag) => image.of(tag.param), { atom: true });
