import { Decoration, Widget } from "wordgard/editor";
import { GardSelection } from "wordgard/state";
import { PagesImage } from "./wordgard-model.mjs";
import { imageLifecycle } from "./image-lifecycle.mjs";
import { diagramButton, maximizeButton } from "./diagram-icons.mjs";
import { openImageViewer } from "./diagram-viewer.mjs";

/** The event WordgardEditor sends a comment control when comment access
 * changes. */
export const COMMENT_ACCESS_EVENT = "pages-comment-access";

/** Events on the image's own controls (Comment and Expand) are the image's;
 * everything else reaches Wordgard, which selects the node. */
export const imageEventReachesEditor = (event) =>
  !event.target?.closest?.(".wordgard-diagram-actions");

const plainClick = (event) =>
  !event.defaultPrevented &&
  event.button === 0 &&
  !event.shiftKey &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey;

const mounted = new WeakMap();

/**
 * One image node: the img the lifecycle draws, and its corner controls.
 *
 * - Editing, a click selects the node and a double-click expands it.
 * - Reading (the editor isn't editable), a click expands it.
 * - Expand opens the loaded image in the expanded viewer.
 * - Comment, with `comments`, selects the node and opens the composer. It
 *   shows only while `comments.allowed()`.
 */
const image = Widget.define({
  eq: (a, b) =>
    ["src", "dark_src", "alt", "title"].every((key) => a.attrs[key] === b.attrs[key]) &&
    a.comments === b.comments &&
    a.expand === b.expand,
  render({ attrs, comments, expand }, editor) {
    const doc = editor.dom.ownerDocument;
    const dom = doc.createElement("span");
    dom.className = "pages-image";
    const slot = dom.appendChild(doc.createElement("span"));
    slot.className = "pages-image-slot";
    const actions = expand || comments ? doc.createElement("span") : null;
    const expandButton = expand ? maximizeButton("Expand image", doc) : null;
    const lifecycle = imageLifecycle(slot, attrs, {
      onChange: (phase) => {
        dom.dataset.imageState = phase;
        if (expandButton) expandButton.hidden = phase !== "ready";
      },
    });
    const state = { lifecycle, viewer: null };
    mounted.set(dom, state);

    const open = (opener) => {
      const img = lifecycle.image;
      if (!expand || !img) return false;
      state.viewer = openImageViewer({
        image: img,
        label: attrs.alt || attrs.title || "Image",
        opener,
      });
      return true;
    };
    const select = () => {
      const found = editor.nodeFromDOM(dom);
      if (!found || found.node.type !== PagesImage) return;
      editor.focus();
      editor.dispatch({
        selection: GardSelection.node(found.pos, found.node),
        userEvent: "select.pointer",
      });
    };
    dom.addEventListener("click", (event) => {
      if (!plainClick(event) || !imageEventReachesEditor(event)) return;
      // A reader's content isn't focusable; focus returns to Expand instead.
      if (!editor.editable && open(expandButton ?? editor.contentDOM)) {
        // The viewer has focus now. Wordgard's own click handling would take
        // it back to the Page behind the modal, where Escape can't reach it.
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      select();
    });
    dom.addEventListener("dblclick", (event) => {
      if (!plainClick(event) || !imageEventReachesEditor(event) || !editor.editable) return;
      if (!open(editor.contentDOM)) return;
      event.preventDefault();
      event.stopPropagation();
    });

    if (!actions) return dom;
    actions.className = "wordgard-diagram-actions pages-image-actions";
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "Image actions");
    if (comments) {
      const comment = actions.appendChild(diagramButton("Comment on image", "comment", "", doc));
      comment.dataset.imageComment = "";
      comment.hidden = !comments.allowed();
      comment.addEventListener("pointerdown", (event) => event.preventDefault());
      comment.addEventListener("click", () => {
        if (comments.allowed()) comments.open(dom);
      });
      comment.addEventListener(COMMENT_ACCESS_EVENT, () => {
        comment.hidden = !comments.allowed();
      });
    }
    if (expandButton) {
      actions.append(expandButton);
      expandButton.addEventListener("pointerdown", (event) => event.preventDefault());
      expandButton.addEventListener("click", () => open(expandButton));
    }
    dom.append(actions);
    return dom;
  },
  connect(_value, dom) {
    mounted.get(dom)?.lifecycle.connect();
  },
  disconnect(_value, dom) {
    const state = mounted.get(dom);
    if (!state) return;
    state.lifecycle.disconnect();
    // Wordgard reconnects a widget it rewraps in the same update, before the
    // reader could have done anything; a viewer still open after that belongs
    // to an image that left the Page.
    queueMicrotask(() => {
      if (!dom.isConnected) {
        state.viewer?.close();
        state.viewer = null;
      }
    });
  },
  propagateEvent: imageEventReachesEditor,
});

/**
 * Draw Page images. `expand` adds the Expand control and the click and
 * double-click that open the expanded viewer. `comments`
 * (`{ allowed, open(dom) }`) adds Comment on image.
 */
export const wordgardImages = ({ comments = null, expand = false } = {}) =>
  Decoration.Tag.shape(PagesImage, (tag) => image.of({ attrs: tag.param, comments, expand }), {
    atom: true,
  });
