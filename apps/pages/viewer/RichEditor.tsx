import { useEffect, useRef, useState } from "react";
import { EditorState, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark, setBlockType } from "prosemirror-commands";
import { wrapInList, splitListItem, sinkListItem, liftListItem } from "prosemirror-schema-list";
import { history, undo, redo } from "prosemirror-history";
import type { PageReplica } from "./replica.ts";
import { bindRichEditor } from "./rich-binding.mjs";
import { richPresence, publishRichSelection } from "./rich-presence.mjs";
import { schema } from "../src/richtext.mjs";
import "prosemirror-view/style/prosemirror.css";

export function RichEditor({
  replica,
  id,
  editable,
  onError,
}: {
  replica: PageReplica;
  id: string;
  editable: boolean;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    editor = useRef<EditorView | null>(null);
  const writable = useRef(editable),
    report = useRef(onError);
  writable.current = editable;
  report.current = onError;
  const [generation, reset] = useState(0);
  useEffect(() => {
    if (!host.current || !replica.doc?.blocks[id]) return;
    const binding = bindRichEditor(replica, id);
    let alive = true,
      release: (() => void) | null = null;
    const view: EditorView = new EditorView(host.current, {
      state: EditorState.create({
        schema,
        doc: binding.pmDoc,
        plugins: [
          binding.plugin,
          history(),
          richPresence(replica, id),
          keymap({
            "Mod-b": toggleMark(schema.marks.strong),
            "Mod-i": toggleMark(schema.marks.em),
            "Mod-`": toggleMark(schema.marks.code),
            "Mod-z": undo,
            "Mod-Shift-z": redo,
            "Mod-y": redo,
            Enter: splitListItem(schema.nodes.list_item),
            Tab: sinkListItem(schema.nodes.list_item),
            "Shift-Tab": liftListItem(schema.nodes.list_item),
          }),
          keymap(baseKeymap),
        ],
      }),
      editable: () => writable.current,
      attributes: { role: "textbox", "aria-multiline": "true", "aria-label": "Page block" },
      dispatchTransaction(tr) {
        try {
          view.updateState(view.state.apply(tr));
          if (tr.docChanged || tr.selectionSet) publishRichSelection(replica, id, view);
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
          queueMicrotask(() => {
            if (alive) publishRichSelection(replica, id, view);
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
        return !!(event.target as Element).closest("a");
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
    editor.current?.setProps({ editable: () => editable });
  }, [editable]);
  const commands: [string, Command][] = [
    ["Bold", toggleMark(schema.marks.strong)],
    ["Italic", toggleMark(schema.marks.em)],
    ["Code", toggleMark(schema.marks.code)],
    ["Heading", setBlockType(schema.nodes.heading, { level: 2 })],
    ["Paragraph", setBlockType(schema.nodes.paragraph)],
    ["List", wrapInList(schema.nodes.bullet_list)],
    ["Undo", undo],
    ["Redo", redo],
  ];
  return (
    <div className="rich-editor">
      <div className="rich-toolbar" role="toolbar" aria-label="Text formatting">
        {commands.map(([label, command]) => (
          <button
            key={label}
            disabled={!editable}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const view = editor.current;
              if (view) {
                command(view.state, view.dispatch, view);
                view.focus();
              }
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div ref={host} />
    </div>
  );
}
