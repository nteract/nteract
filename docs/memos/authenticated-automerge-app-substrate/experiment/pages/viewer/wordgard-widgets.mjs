import { Decoration, Widget, KeyBinding } from "wordgard/editor";
import { GardState, GardSelection, Transaction } from "wordgard/state";
import { Elt } from "wordgard/doc";
import { OpaqueBlock, CodeBlock, CodeBlockLanguage, decode } from "./wordgard-model.mjs";
import { nativeTableSpans } from "../model/richtext.mjs";
import { tablePreviewFragment } from "./table-fragment.mjs";
import { mermaidTitle } from "./mermaid-title.mjs";
import "./table-fragment.css";

// The renderer is a separate content-hashed file (scripts/browser-mermaid.mjs).
// A deploy retires this tab's copy, so a failed import usually means the
// server moved on; main.jsx points onRendererUnavailable at the build check,
// which raises the reload banner when that's the cause.
const loadMermaid = () => import("../../../../../../src/components/markdown/mermaid-renderer.ts");
let rendererUnavailable = () => {};
/** `listener` runs each time the Mermaid renderer fails to load. */
export function onRendererUnavailable(listener) {
  rendererUnavailable = listener;
}
const mounted = new WeakMap();
let diagramId = 0;
const table = Widget.define({
  eq: (a, b) => a.source === b.source && a.kind === b.kind && a.editable === b.editable,
  render(value, editor) {
    const dom = document.createElement("section");
    dom.className = "wordgard-widget preserved-table";
    // A click on rendered content must not focus an insertion point in the
    // surrounding editor. Keep native text selection and child controls usable.
    dom.tabIndex = -1;
    const source = document.createElement("pre");
    source.className = "preserved-table-source";
    source.textContent = value.source;
    const fragment = value.kind === "markdown" ? tablePreviewFragment(value.source) : null;
    if (!fragment) {
      dom.classList.add("opaque");
      dom.append(source);
      return dom;
    }
    dom.append(fragment);
    if (value.editable && nativeTableSpans(value.source)) {
      const edit = dom.appendChild(document.createElement("button"));
      edit.type = "button";
      edit.className = "wordgard-table-convert";
      edit.textContent = "Edit table";
      edit.onclick = () => {
        if (!editor.editable) return;
        const current = editor.nodeFromDOM(dom);
        if (!current || current.node.type !== OpaqueBlock) return;
        const spans = nativeTableSpans(current.node.param.source);
        if (!spans) return;
        const next = decode(spans).doc;
        editor.dispatch({
          changes: {
            from: current.pos,
            to: current.pos + current.node.length,
            insert: next.content,
          },
          selection: (cx) => GardSelection.near(cx, current.pos + 3, 1),
          userEvent: "input.table",
        });
        editor.focus();
      };
    }
    return dom;
  },
  propagateEvent: false,
});
const isMermaid = (node) =>
  node?.type === CodeBlock.type && node.mark(CodeBlockLanguage)?.trim().toLowerCase() === "mermaid";
const codeSource = (node) =>
  node.content.map((child) => (child.isText ? String(child.param) : "\n")).join("");

// Preview is an editor decoration, never a replacement of the shared source.
// Position mapping keeps local edit mode attached to the same native block.
const diagramMode = Transaction.Effect.define({
  map(value, mapping) {
    const pos = mapping.mapPos(value.pos, 1, "after");
    return pos == null ? undefined : { ...value, pos };
  },
});
const editingDiagrams = GardState.Field.define({
  create: () => new Set(),
  update(previous, transaction) {
    const next = new Set();
    for (const position of previous) {
      const pos = transaction.changes.mapPos(position, 1, "after");
      if (pos != null && transaction.newDoc.nodeAt(pos)?.type === CodeBlock.type) {
        next.add(pos);
      } else {
        // Remote projection replaces the opening tag when the language changes.
        // Follow retained content rather than losing local edit mode with that tag.
        const inside = transaction.changes.mapPos(position + 1, 1, "after");
        const block = inside == null ? null : transaction.newDoc.resolve(inside).textblockParent;
        if (block?.node.type === CodeBlock.type) next.add(block.before);
      }
    }
    for (const effect of transaction.effects) {
      if (!effect.is(diagramMode)) continue;
      if (effect.value.editing && isMermaid(transaction.newDoc.nodeAt(effect.value.pos)))
        next.add(effect.value.pos);
      else next.delete(effect.value.pos);
    }
    // Keyboard movement, restored selections, and programmatic selection must
    // never leave an editable cursor inside an invisible code block.
    // Remember ordinary code too: a peer can change its language to Mermaid
    // while this editor is typing, and that must not hide its active source.
    // A remote update must not expose source merely because this never-focused
    // editor inherited a default selection inside its first code block.
    if (
      !transaction.annotation(Transaction.remote) &&
      (transaction.selection || transaction.docChanged)
    ) {
      for (const endpoint of [transaction.newSelection.anchor, transaction.newSelection.head]) {
        const block = transaction.newDoc.resolve(endpoint).textblockParent;
        if (block?.node.type === CodeBlock.type) next.add(block.before);
      }
    }
    return next.size === previous.size && [...next].every((pos) => previous.has(pos))
      ? previous
      : next;
  },
});
const showCode = (state, node, pos) =>
  !codeSource(node).trim() || (!state.readOnly && state.field(editingDiagrams, false)?.has(pos));

// Remote insertion can leave an unfocused editor's default selection inside
// the newly rendered diagram. Wordgard's native cursor cannot measure hidden
// text; keep such selections at the diagram boundary instead. Local navigation
// has already revealed source through editingDiagrams and keeps its position.
const visibleDiagramSelection = Transaction.extender.of((transaction) => {
  if (
    !transaction.annotation(Transaction.remote) &&
    (transaction.selection || transaction.docChanged) &&
    !transaction.startState.readOnly
  )
    return null;
  const state = transaction.state;
  const selection = state.selection;
  const visibleEndpoint = (position, side) => {
    const block = state.doc.resolve(position).textblockParent;
    return block && isMermaid(block.node) && !showCode(state, block.node, block.before)
      ? side < 0
        ? block.before
        : block.after
      : position;
  };
  const anchor = visibleEndpoint(selection.anchor, selection.anchor <= selection.head ? -1 : 1);
  const head = visibleEndpoint(
    selection.head,
    selection.empty || selection.head < selection.anchor ? -1 : 1,
  );
  if (anchor === selection.anchor && head === selection.head) return null;
  return {
    selection: GardSelection.range(anchor, head, selection.headSide),
    sequential: true,
  };
});

function openDiagram(editor, dom) {
  if (!editor.editable) return;
  const block = editor.nodeFromDOM(dom);
  if (!block || !isMermaid(block.node)) return;
  editor.dispatch({
    effects: diagramMode.of({ pos: block.pos, editing: true }),
    selection: GardSelection.cursor(block.pos + 1),
    annotations: Transaction.addToHistory.of(false),
  });
  editor.focus();
}

// Wordgard owns this DOM. Use the same small stroke icons as the React toolbar
// without mounting a second React root inside an editor decoration.
function diagramIcon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(name, value);
  const paths = {
    code: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"],
    preview: [
      "M2.1 12a1 1 0 0 1 0-.7 10.8 10.8 0 0 1 19.8 0 1 1 0 0 1 0 .7 10.8 10.8 0 0 1-19.8 0",
      "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    ],
    copy: ["M9 9h11v11H9z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
    check: ["m20 6-11 11-5-5"],
  };
  for (const d of paths[kind]) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function diagramButton(label, icon, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button wordgard-diagram-action ${className}`;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(diagramIcon(icon));
  return button;
}

function diagramActions(editor, dom, toggle) {
  const actions = document.createElement("div");
  actions.className = "wordgard-diagram-actions";
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", "Diagram actions");
  if (toggle) actions.append(toggle);
  const copy = actions.appendChild(diagramButton("Copy diagram code", "copy"));
  const feedback = actions.appendChild(document.createElement("span"));
  feedback.className = "sr-only";
  feedback.setAttribute("role", "status");
  let copying = false;
  let feedbackVersion = 0;
  copy.onclick = async () => {
    if (copying) return;
    const block = editor.nodeFromDOM(dom.closest("pre") ?? dom);
    if (!block || !isMermaid(block.node)) return;
    copying = true;
    const version = ++feedbackVersion;
    copy.setAttribute("aria-busy", "true");
    feedback.className = "sr-only";
    feedback.textContent = "";
    try {
      await navigator.clipboard.writeText(codeSource(block.node));
      if (!copy.isConnected || version !== feedbackVersion) return;
      copy.replaceChildren(diagramIcon("check"));
      copy.title = "Copied";
      feedback.className = "sr-only";
      feedback.textContent = "Diagram code copied";
    } catch {
      if (!copy.isConnected || version !== feedbackVersion) return;
      feedback.className = "wordgard-diagram-copy-error";
      feedback.textContent = "Couldn’t copy. Try again.";
    } finally {
      copying = false;
      if (copy.isConnected) copy.removeAttribute("aria-busy");
    }
  };
  const reset = () => {
    feedbackVersion++;
    copy.replaceChildren(diagramIcon("copy"));
    copy.title = "Copy diagram code";
    feedback.className = "sr-only";
    feedback.textContent = "";
  };
  copy.onblur = reset;
  copy.onmouseleave = reset;
  return actions;
}

/**
 * The rendered diagram's container and header. The header holds only the
 * diagram actions: the renderer draws the diagram's own title inside the SVG,
 * and the source view's language menu is where a reader sees that the block is
 * Mermaid. The title, when the source has one, names the region for assistive
 * technology.
 */
export function diagramFrame(source) {
  const dom = document.createElement("section");
  dom.className = "wordgard-widget wordgard-diagram";
  dom.tabIndex = -1;
  dom.setAttribute("aria-label", mermaidTitle(source) ?? "Diagram");
  const header = dom.appendChild(document.createElement("div"));
  header.className = "wordgard-diagram-header";
  return { dom, header };
}

const diagram = Widget.define({
  eq: (a, b) => a.source === b.source && a.editable === b.editable,
  render({ source, editable }, editor) {
    const { dom, header } = diagramFrame(source);
    let edit;
    if (editable) {
      edit = diagramButton("Edit diagram", "code", "wordgard-diagram-edit");
      edit.onclick = () => openDiagram(editor, dom);
    }
    header.append(diagramActions(editor, dom, edit));
    const status = dom.appendChild(document.createElement("p"));
    status.textContent = "Rendering diagram…";
    status.setAttribute("role", "status");
    const canvas = dom.appendChild(document.createElement("div"));
    canvas.className = "wordgard-diagram-canvas";
    mounted.set(dom, { alive: false, source, canvas, status, instance: null, timer: null });
    return dom;
  },
  connect(_source, dom) {
    const state = mounted.get(dom);
    if (!state) return;
    state.alive = true;
    state.timer = setTimeout(
      () =>
        loadMermaid()
          .catch((error) => {
            try {
              rendererUnavailable();
            } catch {}
            throw error;
          })
          .then(({ mountMermaid }) => {
            if (!state.alive) return;
            state.instance = mountMermaid(
              state.canvas,
              state.source,
              `pages-wordgard-${++diagramId}`,
              {
                onRender: () => {
                  state.status.hidden = true;
                },
                onError: (error) => {
                  state.status.hidden = false;
                  state.status.textContent =
                    error instanceof Error
                      ? `Diagram unavailable: ${error.message}`
                      : "Diagram unavailable.";
                },
              },
            );
          })
          .catch(() => {
            if (state.alive) state.status.textContent = "Diagram unavailable.";
          }),
      100,
    );
  },
  disconnect(_source, dom) {
    const state = mounted.get(dom);
    if (!state) return;
    state.alive = false;
    clearTimeout(state.timer);
    state.instance?.destroy();
    state.instance = null;
  },
  propagateEvent: false,
});

const previewDiagram = Widget.create({
  render(_value, editor) {
    const button = diagramButton("Preview diagram", "preview", "wordgard-diagram-preview");
    const host = document.createElement("span");
    host.className = "wordgard-code-actions";
    // Resolve the code block when used, after the point widget has mounted.
    const actions = diagramActions(editor, host, button);
    host.append(actions);
    button.onclick = () => {
      if (!editor.editable) return;
      const block = editor.nodeFromDOM(button.closest("pre"));
      if (!block || !isMermaid(block.node) || !codeSource(block.node).trim()) return;
      editor.dispatch({
        effects: diagramMode.of({ pos: block.pos, editing: false }),
        selection: GardSelection.cursor(block.pos),
        annotations: Transaction.addToHistory.of(false),
      });
      // The code widget (including this button) disappears. Give keyboard
      // focus to its replacement instead of leaving a hidden source caret.
      editor.nodeDOM(block.pos)?.querySelector(".wordgard-diagram-edit")?.focus();
    };
    return host;
  },
  propagateEvent: false,
  inFlow: false,
});

export function selectCodeLanguage(editor, block, language) {
  if (!editor.editable || block?.node.type !== CodeBlock.type) return false;
  const existing = CodeBlockLanguage.isInSet(block.node.tag.marks);
  const preview = language === "mermaid" && !!codeSource(block.node).trim();
  editor.dispatch({
    changes: language
      ? { from: block.pos, add: CodeBlockLanguage.of(language) }
      : existing
        ? { from: block.pos, remove: existing }
        : undefined,
    ...(preview && {
      effects: diagramMode.of({ pos: block.pos, editing: false }),
      // Choosing Mermaid is an explicit request to render. Move outside the
      // source in the same transaction so local caret tracking cannot reopen it.
      selection: GardSelection.cursor(block.pos),
    }),
  });
  if (preview) editor.nodeDOM(block.pos)?.querySelector(".wordgard-diagram-edit")?.focus();
  else editor.focus();
  return true;
}

export function wordgardWidgets() {
  return [
    editingDiagrams,
    visibleDiagramSelection,
    Decoration.Tag.shape.derived(OpaqueBlock, (state) => {
      const editable = !state.readOnly;
      return (node) => table.of({ ...node.param, editable });
    }),
    Decoration.Point.source.of((state) => {
      const entries = [];
      state.doc.iterate((node, pos) => {
        if (!isMermaid(node)) return;
        if (showCode(state, node, pos)) {
          if (!state.readOnly && codeSource(node).trim())
            entries.push([
              Decoration.Point.widget(previewDiagram, { side: 1 }),
              pos + node.length - 1,
            ]);
        } else {
          entries.push([
            Decoration.Point.shape(
              // Keep Wordgard's native content hole: atomic replacement shapes
              // cannot apply partial remote edits to a non-atomic CodeBlock.
              // Selection entering source reveals it in the same transaction.
              Elt.mk("div", { class: "wordgard-diagram-block" }, [
                diagram.of({ source: codeSource(node), editable: !state.readOnly }),
                // The content hole must stay last: Wordgard 0.6.2 reparents
                // trailing widgets into it when range decorations change.
                Elt.mk("pre", { hidden: "", "aria-hidden": "true" }, [0]),
              ]),
            ),
            pos,
          ]);
        }
      });
      return Decoration.Point.set(entries);
    }),
  ];
}

// Wordgard 0.6.2's end-tag widget renders twice for an empty code block and
// intercepts native clipboard paste. A point widget appears only once source
// exists; a ```language fence still chooses the language before any text.
const languageMenu = Widget.define({
  eq: (a, b) => a.value === b.value && a.languages === b.languages,
  render({ value, languages }, editor) {
    const select = document.createElement("select");
    select.className = "wg-code-language";
    select.setAttribute("aria-label", "Code language");
    select.tabIndex = -1;
    const choices = [["", "Plain text"], ...languages.map((name) => [name.toLowerCase(), name])];
    if (value && !choices.some(([key]) => key === value)) choices.push([value, value]);
    for (const [key, label] of choices) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = label;
      option.selected = key === value;
      select.append(option);
    }
    select.onchange = () => {
      const block = editor.nodeFromDOM(select.closest("pre"));
      selectCodeLanguage(editor, block, select.value);
    };
    return select;
  },
  propagateEvent: false,
  inFlow: false,
});
export function wordgardCodeLanguages(languages) {
  return [
    Decoration.Point.source.of((state) => {
      const entries = [];
      state.doc.iterate((node, pos) => {
        if (
          node.type === CodeBlock.type &&
          node.content.length &&
          (!isMermaid(node) || showCode(state, node, pos))
        )
          entries.push([
            Decoration.Point.widget(
              languageMenu.of({ languages, value: node.mark(CodeBlockLanguage) ?? "" }),
              { side: 1 },
            ),
            pos + node.length - 1,
          ]);
      });
      return Decoration.Point.set(entries);
    }),
    KeyBinding.of({
      key: "Shift-Mod-l",
      run: (editor) => {
        const block = editor.state.sel.head.textblockParent;
        if (!block || block.node.type !== CodeBlock.type) return false;
        const select = editor.nodeDOM(block.before)?.querySelector("select.wg-code-language");
        if (select) {
          select.focus();
          // Some browsers do not expose showPicker; native keyboard selection
          // still works after focus. Empty blocks deliberately have no menu.
          if (typeof select.showPicker === "function") select.showPicker();
        }
        return true;
      },
    }),
  ];
}
