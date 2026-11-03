import { Decoration, Widget, KeyBinding } from "wordgard/editor";
import { GardState, GardSelection, Transaction } from "wordgard/state";
import { Elt } from "wordgard/doc";
import { CodeBlock, CodeBlockLanguage } from "./wordgard-model.mjs";
import { mermaidTitle } from "./mermaid-title.mjs";
import { diagramIcon } from "./diagram-icons.mjs";
import { openDiagramViewer } from "./diagram-viewer.mjs";
import { SIFT_LANGUAGE, parseSiftSource } from "../shared/dataset-assets.mjs";

// The renderer is a separate content-hashed file (scripts/browser-mermaid.mjs).
// A deploy retires this tab's copy, so a failed import usually means the
// server moved on; main.jsx points onRendererUnavailable at the build check,
// which raises the reload banner when that's the cause.
const loadMermaid = () => import("../../../../../../src/components/markdown/mermaid-renderer.ts");
// The Sift table is a lazily loaded viewer chunk with the same retirement
// behavior.
const loadSift = () => import("./sift-table.jsx");
let rendererUnavailable = () => {};
/** `listener` runs each time the Mermaid or Sift renderer fails to load. */
export function onRendererUnavailable(listener) {
  rendererUnavailable = listener;
}
const mounted = new WeakMap();
let diagramId = 0;
// Code blocks in these languages render in place of their source: Mermaid as
// a diagram, `sift` as a table of a Page dataset. Both keep the source as the
// shared content and reveal it for editing the same way.
const RENDERED_LANGUAGES = new Set(["mermaid", SIFT_LANGUAGE]);
const renderedLanguage = (node) => {
  if (node?.type !== CodeBlock.type) return null;
  const language = node.mark(CodeBlockLanguage)?.trim().toLowerCase();
  return RENDERED_LANGUAGES.has(language) ? language : null;
};
const isRendered = (node) => renderedLanguage(node) !== null;
const LABELS = {
  mermaid: {
    edit: "Edit diagram",
    preview: "Preview diagram",
    copy: "Copy diagram code",
    copied: "Diagram code copied",
    actions: "Diagram actions",
  },
  [SIFT_LANGUAGE]: {
    edit: "Edit table source",
    preview: "Show table",
    copy: "Copy table source",
    copied: "Table source copied",
    actions: "Table actions",
  },
};
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
      if (effect.value.editing && isRendered(transaction.newDoc.nodeAt(effect.value.pos)))
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
    return block && isRendered(block.node) && !showCode(state, block.node, block.before)
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
  if (!block || !isRendered(block.node)) return;
  editor.dispatch({
    effects: diagramMode.of({ pos: block.pos, editing: true }),
    selection: GardSelection.cursor(block.pos + 1),
    annotations: Transaction.addToHistory.of(false),
  });
  editor.focus();
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

function diagramActions(editor, dom, toggle, extra, labels = LABELS.mermaid) {
  const actions = document.createElement("div");
  actions.className = "wordgard-diagram-actions";
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", labels.actions);
  // `extra` (Maximize) leads, so Edit/Preview and Copy keep the same corner
  // positions in the rendered and source views.
  if (extra) actions.append(extra);
  if (toggle) actions.append(toggle);
  const copy = actions.appendChild(diagramButton(labels.copy, "copy"));
  const feedback = actions.appendChild(document.createElement("span"));
  feedback.className = "sr-only";
  feedback.setAttribute("role", "status");
  let copying = false;
  let feedbackVersion = 0;
  copy.onclick = async () => {
    if (copying) return;
    const block = editor.nodeFromDOM(dom.closest("pre") ?? dom);
    if (!block || !isRendered(block.node)) return;
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
      feedback.textContent = labels.copied;
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
    copy.title = labels.copy;
    feedback.className = "sr-only";
    feedback.textContent = "";
  };
  copy.onblur = reset;
  copy.onmouseleave = reset;
  return actions;
}

/** The SVG Pele rendered into `canvas`, if it has rendered one. */
export const renderedSvg = (canvas) => canvas.querySelector(":scope > svg");

/**
 * Maximize opens the rendered diagram in the expanded viewer. It stays hidden
 * until there is a rendered SVG to show.
 */
export function maximizeButton() {
  const button = diagramButton("Maximize diagram", "maximize", "wordgard-diagram-maximize");
  button.setAttribute("aria-haspopup", "dialog");
  button.hidden = true;
  return button;
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
    const maximize = maximizeButton();
    header.append(diagramActions(editor, dom, edit, maximize));
    const status = dom.appendChild(document.createElement("p"));
    status.textContent = "Rendering diagram…";
    status.setAttribute("role", "status");
    const canvas = dom.appendChild(document.createElement("div"));
    canvas.className = "wordgard-diagram-canvas";
    const state = {
      alive: false,
      source,
      canvas,
      status,
      maximize,
      instance: null,
      timer: null,
      viewer: null,
    };
    maximize.onclick = () => {
      const svg = renderedSvg(canvas);
      if (!svg) return;
      state.viewer = openDiagramViewer({
        svg,
        label: mermaidTitle(source) ?? "Diagram",
        opener: maximize,
      });
    };
    mounted.set(dom, state);
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
                  state.maximize.hidden = !renderedSvg(state.canvas);
                },
                onError: (error) => {
                  state.status.hidden = false;
                  state.maximize.hidden = true;
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
    // The Page moved on (navigation, or a peer replaced this diagram): an
    // expanded copy of it must not outlive the editor that showed it.
    state.viewer?.close();
    state.viewer = null;
  },
  propagateEvent: false,
});

/**
 * The rendered table's container. Its name is the source's title, when it has
 * one, which also shows in the header. Sift's own controls (sorting, filters,
 * column menus) change only this reader's view; nothing writes them back.
 */
export function siftFrame(source) {
  const parsed = parseSiftSource(source);
  const dom = document.createElement("section");
  dom.className = "wordgard-widget wordgard-diagram wordgard-sift";
  dom.tabIndex = -1;
  dom.setAttribute("aria-label", parsed.title ?? "Table");
  const header = dom.appendChild(document.createElement("div"));
  header.className = "wordgard-diagram-header";
  if (parsed.title) {
    const title = header.appendChild(document.createElement("span"));
    title.className = "wordgard-sift-title";
    title.textContent = parsed.title;
  }
  return { dom, header, parsed };
}

const siftTable = Widget.define({
  eq: (a, b) => a.source === b.source && a.editable === b.editable,
  render({ source, editable }, editor) {
    const { dom, header, parsed } = siftFrame(source);
    const labels = LABELS[SIFT_LANGUAGE];
    let edit;
    if (editable) {
      edit = diagramButton(labels.edit, "code", "wordgard-diagram-edit");
      edit.onclick = () => openDiagram(editor, dom);
    }
    header.append(diagramActions(editor, dom, edit, undefined, labels));
    const status = dom.appendChild(document.createElement("p"));
    status.setAttribute("role", "status");
    status.textContent = parsed.error ?? "Loading table…";
    const canvas = dom.appendChild(document.createElement("div"));
    canvas.className = "wordgard-sift-canvas";
    canvas.hidden = !!parsed.error;
    mounted.set(dom, { alive: false, parsed, canvas, status, instance: null, timer: null });
    return dom;
  },
  connect(_value, dom) {
    const state = mounted.get(dom);
    if (!state || state.parsed.error) return;
    state.alive = true;
    const fail = (message) => {
      if (!state.alive) return;
      state.status.hidden = false;
      state.status.textContent = message;
    };
    state.timer = setTimeout(
      () =>
        loadSift()
          .catch((error) => {
            try {
              rendererUnavailable();
            } catch {}
            throw error;
          })
          .then(({ mountSiftTable }) => {
            if (!state.alive) return;
            // Sift draws its own loading and error states inside the canvas,
            // including fetchDataset's access and missing-asset messages.
            state.status.hidden = true;
            state.instance = mountSiftTable(state.canvas, { src: state.parsed.src });
          })
          .catch(() => fail("Table unavailable.")),
      100,
    );
  },
  disconnect(_value, dom) {
    const state = mounted.get(dom);
    if (!state) return;
    state.alive = false;
    clearTimeout(state.timer);
    state.instance?.destroy();
    state.instance = null;
  },
  propagateEvent: false,
});

const previewDiagram = Widget.define({
  eq: (a, b) => a.language === b.language,
  render({ language }, editor) {
    const labels = LABELS[language];
    const button = diagramButton(labels.preview, "preview", "wordgard-diagram-preview");
    const host = document.createElement("span");
    host.className = "wordgard-code-actions";
    // Resolve the code block when used, after the point widget has mounted.
    const actions = diagramActions(editor, host, button, undefined, labels);
    host.append(actions);
    button.onclick = () => {
      if (!editor.editable) return;
      const block = editor.nodeFromDOM(button.closest("pre"));
      if (!block || !isRendered(block.node) || !codeSource(block.node).trim()) return;
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
  const preview = RENDERED_LANGUAGES.has(language) && !!codeSource(block.node).trim();
  editor.dispatch({
    changes: language
      ? { from: block.pos, add: CodeBlockLanguage.of(language) }
      : existing
        ? { from: block.pos, remove: existing }
        : undefined,
    ...(preview && {
      effects: diagramMode.of({ pos: block.pos, editing: false }),
      // Choosing Mermaid or Sift is an explicit request to render. Move outside the
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
    Decoration.Point.source.of((state) => {
      const entries = [];
      state.doc.iterate((node, pos) => {
        const language = renderedLanguage(node);
        if (!language) return;
        if (showCode(state, node, pos)) {
          if (!state.readOnly && codeSource(node).trim())
            entries.push([
              Decoration.Point.widget(previewDiagram.of({ language }), { side: 1 }),
              pos + node.length - 1,
            ]);
        } else {
          const rendered = { source: codeSource(node), editable: !state.readOnly };
          entries.push([
            Decoration.Point.shape(
              // Keep Wordgard's native content hole: atomic replacement shapes
              // cannot apply partial remote edits to a non-atomic CodeBlock.
              // Selection entering source reveals it in the same transaction.
              Elt.mk("div", { class: "wordgard-diagram-block" }, [
                language === SIFT_LANGUAGE ? siftTable.of(rendered) : diagram.of(rendered),
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
          (!isRendered(node) || showCode(state, node, pos))
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
