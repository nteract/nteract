import { Decoration, Widget, KeyBinding } from "wordgard/editor";
import { OpaqueBlock, CodeBlock, CodeBlockLanguage } from "./wordgard-model.mjs";
import { tablePreviewFragment } from "./table-preview.mjs";
import "./table-preview.css";

const loadMermaid = () => import("../../../../../../src/components/markdown/mermaid-renderer.ts");
const mounted = new WeakMap();
let diagramId = 0;
const table = Widget.define({
  eq: (a, b) => a.source === b.source && a.kind === b.kind,
  render(value) {
    const dom = document.createElement("section");
    dom.className = "wordgard-widget preserved-table";
    const source = document.createElement("pre");
    source.className = "preserved-table-source";
    source.textContent = value.source;
    const fragment = value.kind === "markdown" ? tablePreviewFragment(value.source) : null;
    if (!fragment) {
      dom.classList.add("opaque");
      dom.append(source);
      return dom;
    }
    const controls = dom.appendChild(document.createElement("div"));
    controls.className = "preserved-table-toolbar";
    const toggle = controls.appendChild(document.createElement("button"));
    toggle.type = "button";
    toggle.textContent = "Source";
    toggle.setAttribute("aria-label", "Show table Markdown source");
    toggle.setAttribute("aria-expanded", "false");
    const preview = dom.appendChild(document.createElement("div"));
    preview.append(fragment);
    source.hidden = true;
    dom.append(source);
    toggle.onclick = () => {
      source.hidden = !source.hidden;
      preview.hidden = !source.hidden;
      toggle.textContent = source.hidden ? "Source" : "Preview";
      toggle.setAttribute("aria-expanded", String(!source.hidden));
      toggle.setAttribute(
        "aria-label",
        source.hidden ? "Show table Markdown source" : "Show rendered table",
      );
    };
    return dom;
  },
  propagateEvent: false,
});
const diagram = Widget.define({
  eq: (a, b) => a === b,
  render(source) {
    const dom = document.createElement("section");
    dom.className = "wordgard-widget wordgard-diagram";
    dom.setAttribute("aria-label", "Mermaid diagram");
    const status = dom.appendChild(document.createElement("p"));
    status.textContent = "Rendering diagram…";
    status.setAttribute("role", "status");
    const canvas = dom.appendChild(document.createElement("div"));
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
                  state.status.textContent = `Diagram unavailable: ${error instanceof Error ? error.message : "Check the source."}`;
                },
              },
            );
          })
          .catch(() => {
            if (state.alive) state.status.textContent = "Diagram unavailable. Check the source.";
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

export function wordgardWidgets() {
  return [
    Decoration.Tag.shape(OpaqueBlock, (node) => table.of(node.param)),
    Decoration.Point.source.of((state) => {
      const entries = [];
      state.doc.iterate((node, pos) => {
        if (
          node.type !== CodeBlock.type ||
          node.mark(CodeBlockLanguage)?.trim().toLowerCase() !== "mermaid"
        )
          return;
        const source = node.content
          .map((child) => (child.isText ? String(child.param) : "\n"))
          .join("");
        if (source.trim())
          entries.push([
            Decoration.Point.widget(diagram.of(source), { side: 1 }),
            pos + node.length,
          ]);
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
      if (!editor.editable) return;
      const block = editor.nodeFromDOM(select.closest("pre"));
      if (!block || block.node.type !== CodeBlock.type) return;
      const existing = CodeBlockLanguage.isInSet(block.node.tag.marks);
      if (select.value)
        editor.dispatch({ changes: { from: block.pos, add: CodeBlockLanguage.of(select.value) } });
      else if (existing) editor.dispatch({ changes: { from: block.pos, remove: existing } });
      editor.focus();
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
        if (node.type === CodeBlock.type && node.content.length)
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
