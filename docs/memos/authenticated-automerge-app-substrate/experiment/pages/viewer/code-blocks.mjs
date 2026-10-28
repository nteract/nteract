import { NodeSelection, Plugin, TextSelection } from "prosemirror-state";
import { closeHistory } from "prosemirror-history";

export const codeLanguages = [
  ["", "Plain text"],
  ["mermaid", "Mermaid"],
  ["bash", "Bash"],
  ["css", "CSS"],
  ["html", "HTML"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["markdown", "Markdown"],
  ["python", "Python"],
  ["r", "R"],
  ["rust", "Rust"],
  ["sql", "SQL"],
  ["typescript", "TypeScript"],
  ["yaml", "YAML"],
];

const language = (node) => String(node.attrs.params ?? "");
const isMermaid = (node) => language(node).trim().toLowerCase() === "mermaid";

// Wait for Enter/Space, so both ``` and ```mermaid remain natural to type.
export function turnFenceIntoCode(state, dispatch) {
  const { $from, $to, empty } = state.selection;
  if (!empty || $from.parent.type !== state.schema.nodes.paragraph || !$from.sameParent($to))
    return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  const match = /^```([A-Za-z][A-Za-z0-9_+.-]{0,39})?$/.exec($from.parent.textContent);
  if (!match) return false;
  const type = state.schema.nodes.code_block;
  if (!$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), type)) return false;
  if (dispatch) {
    const position = $from.before();
    const tr = closeHistory(state.tr)
      .delete($from.start(), $from.end())
      .setNodeMarkup(position, type, { params: match[1] ?? "" });
    tr.setSelection(TextSelection.create(tr.doc, position + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

export function leaveCodeBlock(state, dispatch, trimBlankLines = false) {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== state.schema.nodes.code_block) return false;
  if (
    trimBlankLines &&
    ($from.parentOffset !== $from.parent.content.size || !$from.parent.textContent.endsWith("\n\n"))
  )
    return false;
  const paragraph = state.schema.nodes.paragraph;
  const index = $from.indexAfter(-1);
  if (!$from.node(-1).canReplaceWith(index, index, paragraph)) return false;
  if (dispatch) {
    const tr = closeHistory(state.tr);
    if (trimBlankLines) tr.delete($from.pos - 2, $from.pos);
    const position = tr.mapping.map($from.after());
    tr.insert(position, paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, position + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

// This is the notebook renderer, including its DOMPurify SVG/resource policy.
// Pages builds this as a same-origin lazy /mermaid.js asset; no source is uploaded.
// Keep the canonical import here so source fingerprinting follows the shared renderer.
const loadMermaid = () => import("../../../../../../src/components/markdown/mermaid-renderer.ts");
let diagramId = 0;

export class CodeBlockView {
  constructor(node, view, getPos, { loadRenderer = loadMermaid } = {}) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.loadRenderer = loadRenderer;
    this.mode = isMermaid(node) && node.textContent ? "preview" : "source";
    this.alive = true;
    this.generation = 0;
    this.id = `pages-code-${++diagramId}`;
    this.dom = document.createElement("section");
    this.dom.className = "code-block";
    this.toolbar = document.createElement("div");
    this.toolbar.className = "code-block-toolbar";
    this.toolbar.contentEditable = "false";
    this.select = document.createElement("select");
    this.select.setAttribute("aria-label", "Code language");
    for (const [value, label] of codeLanguages) this.select.add(new Option(label, value));
    this.select.addEventListener("change", () => {
      if (!view.editable) return;
      const pos = getPos();
      if (typeof pos !== "number") return;
      this.mode = this.select.value === "mermaid" && this.node.textContent ? "preview" : "source";
      const tr = view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        params: this.select.value,
      });
      // Preview has no editable caret. A node selection prevents later input
      // from silently changing the hidden source.
      if (this.mode === "preview") tr.setSelection(NodeSelection.create(tr.doc, pos));
      view.dispatch(tr);
    });
    this.modes = document.createElement("div");
    this.modes.className = "code-block-modes";
    this.modes.setAttribute("role", "group");
    this.modes.setAttribute("aria-label", "Mermaid view");
    this.buttons = {};
    for (const mode of ["source", "preview"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = mode === "source" ? "Source" : "Preview";
      button.addEventListener("click", () => {
        this.mode = mode;
        const position = getPos();
        if (mode === "preview" && typeof position === "number")
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)));
        this.refresh();
        if (mode === "source") {
          const pos = position;
          if (typeof pos === "number") {
            view.dispatch(
              view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)),
            );
            view.focus();
          }
        }
      });
      this.modes.append(button);
      this.buttons[mode] = button;
    }
    this.toolbar.append(this.select, this.modes);
    this.pre = document.createElement("pre");
    this.pre.className = "code-block-source";
    this.contentDOM = document.createElement("code");
    this.pre.append(this.contentDOM);
    this.preview = document.createElement("div");
    this.preview.className = "code-block-preview";
    this.preview.setAttribute("aria-label", "Mermaid diagram");
    this.preview.contentEditable = "false";
    this.status = document.createElement("p");
    this.status.className = "code-block-status";
    this.status.setAttribute("role", "status");
    this.canvas = document.createElement("div");
    this.canvas.className = "code-block-diagram";
    this.preview.append(this.status, this.canvas);
    this.dom.append(this.toolbar, this.pre, this.preview);
    this.refresh();
  }

  refresh() {
    const params = language(this.node);
    if (![...this.select.options].some((option) => option.value === params)) {
      const option = new Option(params || "Plain text", params);
      this.select.add(option);
    }
    this.select.value = params;
    this.select.disabled = !this.view.editable;
    const mermaid = isMermaid(this.node);
    if (!mermaid) this.mode = "source";
    this.modes.hidden = !mermaid;
    this.pre.hidden = this.mode === "preview";
    this.preview.hidden = this.mode !== "preview";
    this.dom.dataset.mode = this.mode;
    for (const [mode, button] of Object.entries(this.buttons))
      button.setAttribute("aria-pressed", String(mode === this.mode));
    if (this.mode === "preview") this.renderPreview();
    else this.clearPreview();
  }

  clearPreview() {
    this.generation++;
    clearTimeout(this.timer);
    this.mounted?.destroy();
    this.mounted = null;
    this.renderedSource = null;
    this.canvas.replaceChildren();
  }

  renderPreview() {
    const source = this.node.textContent;
    if (source === this.renderedSource) return;
    this.clearPreview();
    this.renderedSource = source;
    const generation = this.generation;
    const current = () => this.alive && generation === this.generation && this.mode === "preview";
    this.status.hidden = false;
    this.status.textContent = source.trim()
      ? "Rendering diagram…"
      : "Add Mermaid code in Source to see a diagram.";
    if (!source.trim()) return;
    const fail = (error) => {
      if (!current()) return;
      this.status.hidden = false;
      this.status.textContent = `Diagram unavailable: ${error instanceof Error ? error.message : "Check the source."}`;
    };
    // Remote keystrokes update the CRDT immediately; only the local preview is debounced.
    this.timer = setTimeout(() => {
      this.loadRenderer()
        .then(({ mountMermaid }) => {
          if (!current()) return;
          this.mounted = mountMermaid(this.canvas, source, this.id, {
            onRender: () => {
              if (current()) this.status.hidden = true;
            },
            onError: fail,
          });
        })
        .catch(fail);
    }, 100);
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    const wasMermaid = isMermaid(this.node);
    this.node = node;
    if (!wasMermaid && isMermaid(node) && node.textContent) this.mode = "preview";
    this.refresh();
    return true;
  }

  setSelection(anchor, head, root) {
    // Keyboard navigation/programmatic selections can enter this non-atomic
    // text node from nearby prose. Reveal source before placing the DOM caret.
    if (this.mode === "preview") {
      this.mode = "source";
      this.refresh();
    }
    const position = this.getPos();
    if (typeof position !== "number") return;
    const from = this.view.domAtPos(position + 1 + anchor);
    const to = this.view.domAtPos(position + 1 + head);
    const selection = root.getSelection?.() ?? this.dom.ownerDocument.getSelection();
    selection?.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
  }

  stopEvent(event) {
    return this.toolbar.contains(event.target) || this.preview.contains(event.target);
  }

  ignoreMutation(mutation) {
    return mutation.type !== "selection" && !this.contentDOM.contains(mutation.target);
  }

  destroy() {
    this.alive = false;
    this.clearPreview();
  }
}

export function codeBlockEditing(options) {
  return new Plugin({
    view(view) {
      let editable = view.editable;
      return {
        update(nextView) {
          if (editable === nextView.editable) return;
          editable = nextView.editable;
          // Permission changes need not replace the document or its node views.
          for (const select of nextView.dom.querySelectorAll(".code-block-toolbar select"))
            select.disabled = !editable;
        },
      };
    },
    props: {
      nodeViews: {
        code_block: (node, view, getPos) => new CodeBlockView(node, view, getPos, options),
      },
      handleKeyDown(view, event) {
        if (!view.editable || view.composing || event.altKey || event.shiftKey) return false;
        if (event.key !== "Enter") return false;
        if (event.metaKey || event.ctrlKey) return leaveCodeBlock(view.state, view.dispatch);
        return (
          turnFenceIntoCode(view.state, view.dispatch) ||
          leaveCodeBlock(view.state, view.dispatch, true)
        );
      },
      handleTextInput(view, _from, _to, text) {
        if (!view.editable || view.composing || ![" ", "\n"].includes(text)) return false;
        return (
          turnFenceIntoCode(view.state, view.dispatch) ||
          (text === "\n" && leaveCodeBlock(view.state, view.dispatch, true))
        );
      },
    },
  });
}
