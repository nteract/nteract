import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { splitListItem, sinkListItem, liftListItem } from "prosemirror-schema-list";
import { history } from "prosemirror-history";
import { Bold, Italic, Code, List, ListOrdered, Undo2, Redo2 } from "lucide-react";
import { createToolbarCommands, observeToolbar, textStyles } from "./editor-toolbar.mjs";
import { richComments, revealCommentPassage } from "./rich-comments.mjs";
import { bindRichEditor } from "./rich-binding.mjs";
import { richAttribution } from "./rich-attribution.mjs";
import { richPresence, publishRichSelection, richCommentSelection } from "./rich-presence.mjs";
import { schema } from "../model/richtext.mjs";
import "prosemirror-view/style/prosemirror.css";
const commands = createToolbarCommands(schema);
const buttonGroups = [
  {
    label: "History",
    buttons: [
      { id: "undo", label: "Undo", icon: Undo2, shortcut: "Z" },
      { id: "redo", label: "Redo", icon: Redo2, shortcut: "Shift+Z" },
    ],
  },
  {
    label: "Formatting",
    buttons: [
      { id: "bold", label: "Bold", icon: Bold, shortcut: "B" },
      { id: "italic", label: "Italic", icon: Italic, shortcut: "I" },
      { id: "code", label: "Code", icon: Code, shortcut: "`" },
    ],
  },
  {
    label: "Lists",
    buttons: [
      { id: "bullet_list", label: "Bulleted list", icon: List, shortcut: "Shift+8" },
      { id: "ordered_list", label: "Numbered list", icon: ListOrdered, shortcut: "Shift+7" },
    ],
  },
];
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
function shortcutLabel(shortcut) {
  return (isMac ? "⌘" : "Ctrl+") + shortcut.replace("Shift+", isMac ? "⇧" : "Shift+");
}

export function RichEditor({
  replica,
  id,
  editable,
  onError,
  onSelection,
  toolbarHost,
  onActivate,
  threads,
  commentTarget,
}) {
  const host = useRef(null),
    editor = useRef(null),
    toolbar = useRef(null);
  const writable = useRef(editable),
    report = useRef(onError),
    selected = useRef(onSelection),
    activate = useRef(onActivate);
  const comments = useRef(threads),
    activeComment = useRef(commentTarget?.id);
  comments.current = threads;
  activeComment.current = commentTarget?.id;
  activate.current = onActivate;
  selected.current = onSelection;
  writable.current = editable;
  report.current = onError;
  const [generation, reset] = useState(0);
  const [formatting, setFormatting] = useState(null);
  const [tabStop, setTabStop] = useState("style");
  useEffect(() => {
    if (!host.current || !replica.doc?.blocks[id]) return;
    const binding = bindRichEditor(replica, id);
    let alive = true,
      release = null;
    const view = new EditorView(host.current, {
      state: EditorState.create({
        schema,
        doc: binding.pmDoc,
        plugins: [
          binding.plugin,
          history(),
          observeToolbar(setFormatting, commands),
          richAttribution(replica),
          richPresence(replica, id),
          richComments(
            replica,
            id,
            () => comments.current,
            () => activeComment.current,
          ),
          keymap({
            "Mod-b": commands.bold,
            "Mod-i": commands.italic,
            "Mod-`": commands.code,
            "Mod-z": commands.undo,
            "Mod-Shift-z": commands.redo,
            "Mod-y": commands.redo,
            "Mod-Shift-8": commands.bullet_list,
            "Mod-Shift-7": commands.ordered_list,
            "Mod-Alt-0": commands.styles.paragraph,
            "Mod-Alt-1": commands.styles.heading1,
            "Mod-Alt-2": commands.styles.heading2,
            "Mod-Alt-3": commands.styles.heading3,
            "Alt-F10": () => {
              const first = toolbar.current?.querySelector('[tabindex="0"]');
              first?.focus();
              return !!first;
            },
            Enter: splitListItem(schema.nodes.list_item),
            Tab: sinkListItem(schema.nodes.list_item),
            "Shift-Tab": liftListItem(schema.nodes.list_item),
          }),
          keymap(baseKeymap),
        ],
      }),
      editable: () => writable.current,
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Page block",
        "aria-readonly": String(!writable.current),
      },
      dispatchTransaction(tr) {
        try {
          view.updateState(view.state.apply(tr));
          if (tr.docChanged || tr.selectionSet) {
            publishRichSelection(replica, id, view);
            selected.current?.(richCommentSelection(replica, id, view.state));
          }
        } catch (error) {
          report.current(error instanceof Error ? error.message : String(error));
          // A rejected mutation must not leave the binding's internal echo guard
          // stuck or let later input build on an uncommitted editor document.
          queueMicrotask(() => {
            if (alive) reset((n) => n + 1);
          });
        }
      },
      handleDOMEvents: {
        focus: () => {
          activate.current();
          queueMicrotask(() => {
            if (alive) {
              publishRichSelection(replica, id, view);
              selected.current?.(richCommentSelection(replica, id, view.state));
            }
          });
          return false;
        },
        blur: () => {
          replica.publishPresence(null);
          return false;
        },
        compositionstart: () => {
          release ??= replica.holdRemote();
          return false;
        },
        compositionend: () => {
          setTimeout(() => {
            release?.();
            release = null;
          }, 0);
          return false;
        },
      },
      handleClick(_view, _pos, event) {
        // Links are editable content here; do not navigate away while placing a cursor.
        return !!event.target.closest("a");
      },
    });
    editor.current = view;
    return () => {
      alive = false;
      release?.();
      editor.current = null;
      view.destroy();
      binding.destroy();
    };
  }, [replica, id, generation]);
  useEffect(() => {
    editor.current?.setProps({
      editable: () => editable,
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Page block",
        "aria-readonly": String(!editable),
      },
    });
  }, [editable]);
  useEffect(() => {
    const view = editor.current;
    if (view && !view.composing) view.dispatch(view.state.tr.setMeta("addToHistory", false));
  }, [threads, commentTarget]);
  useEffect(() => {
    const thread = comments.current.find((item) => item.id === commentTarget?.id);
    if (
      editor.current &&
      thread?.target.kind === "selection" &&
      thread.target.anchor.blockId === id
    )
      revealCommentPassage(editor.current);
  }, [commentTarget]);
  function run(command, restoreFocus = true) {
    const view = editor.current;
    if (!view || !writable.current) return;
    try {
      command(view.state, view.dispatch, view);
      if (restoreFocus) view.focus();
    } catch (error) {
      report.current(error instanceof Error ? error.message : String(error));
    }
  }
  const enabled = (name) => !!editable && !!formatting?.controls[name]?.enabled;
  const styleEnabled = !!editable && !!formatting && Object.values(formatting.styles).some(Boolean);
  const controlOrder = [
    "undo",
    "redo",
    "style",
    "bold",
    "italic",
    "code",
    "bullet_list",
    "ordered_list",
  ];
  const enabledControls = controlOrder.filter((name) =>
    name === "style" ? styleEnabled : enabled(name),
  );
  const currentTabStop = enabledControls.includes(tabStop) ? tabStop : enabledControls[0];
  const styleValue = textStyles.some(({ value }) => value === formatting?.style)
    ? formatting.style
    : "mixed";
  function toolbarKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      editor.current?.focus();
      return;
    }
    // Up/down and Home/End remain native option navigation in the text-style select.
    if (
      event.target.tagName === "SELECT" &&
      ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
    )
      return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const controls = [
      ...event.currentTarget.querySelectorAll("[data-toolbar-control]:not(:disabled)"),
    ];
    if (!controls.length) return;
    const index = controls.indexOf(event.target);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + controls.length) % controls.length;
    event.preventDefault();
    controls[next].focus();
  }
  function buttons(group) {
    return (
      <div className="toolbar-group" role="group" aria-label={group.label} key={group.label}>
        {group.buttons.map(({ id: name, label, icon: Icon, shortcut }) => {
          const pressed = formatting?.controls[name]?.pressed;
          return (
            <button
              type="button"
              className={`toolbar-button${pressed ? " is-active" : ""}`}
              key={name}
              data-toolbar-control={name}
              aria-label={label}
              aria-pressed={pressed}
              aria-keyshortcuts={`${isMac ? "Meta" : "Control"}+${shortcut}`}
              title={`${label} (${shortcutLabel(shortcut)})`}
              disabled={!enabled(name)}
              tabIndex={currentTabStop === name ? 0 : -1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run(commands[name])}
            >
              <Icon
                className="toolbar-icon"
                size={18}
                strokeWidth={1.8}
                aria-hidden="true"
                focusable="false"
              />
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div className="rich-editor">
      {toolbarHost &&
        createPortal(
          <div
            className="rich-toolbar"
            ref={toolbar}
            role="toolbar"
            aria-label="Text formatting"
            aria-orientation="horizontal"
            onKeyDown={toolbarKeyDown}
            onFocusCapture={(event) => {
              const name = event.target.dataset.toolbarControl;
              if (name) setTabStop(name);
            }}
          >
            {buttons(buttonGroups[0])}
            <span className="toolbar-separator" role="separator" aria-orientation="vertical" />
            <select
              className="toolbar-select"
              aria-label="Text style"
              title="Text style (Ctrl/⌘+Alt+0–3)"
              data-toolbar-control="style"
              tabIndex={currentTabStop === "style" ? 0 : -1}
              disabled={!styleEnabled}
              value={styleValue}
              onChange={(event) => run(commands.styles[event.target.value], false)}
            >
              {styleValue === "mixed" && (
                <option value="mixed" disabled>
                  Mixed styles
                </option>
              )}
              {textStyles.map(({ value, label }) => (
                <option
                  key={value}
                  value={value}
                  disabled={formatting?.style !== value && !formatting?.styles[value]}
                >
                  {label}
                </option>
              ))}
            </select>
            <span className="toolbar-separator" role="separator" aria-orientation="vertical" />
            {buttons(buttonGroups[1])}
            <span className="toolbar-separator" role="separator" aria-orientation="vertical" />
            {buttons(buttonGroups[2])}
          </div>,
          toolbarHost,
        )}
      <div ref={host} />
    </div>
  );
}
