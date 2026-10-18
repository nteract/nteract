import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark, setBlockType } from "prosemirror-commands";
import { wrapInList, splitListItem, sinkListItem, liftListItem } from "prosemirror-schema-list";
import { history, undo, redo } from "prosemirror-history";
import { richComments, revealCommentPassage } from "./rich-comments.mjs";
import { bindRichEditor } from "./rich-binding.mjs";
import { richAttribution } from "./rich-attribution.mjs";
import { richPresence, publishRichSelection, richCommentSelection } from "./rich-presence.mjs";
import { schema } from "../model/richtext.mjs";
import "prosemirror-view/style/prosemirror.css";
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
    editor = useRef(null);
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
          richAttribution(replica),
          richPresence(replica, id),
          richComments(
            replica,
            id,
            () => comments.current,
            () => activeComment.current,
          ),
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
    editor.current?.setProps({ editable: () => editable });
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
  const commands = [
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
      {toolbarHost &&
        createPortal(
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
          </div>,
          toolbarHost,
        )}
      <div ref={host} />
    </div>
  );
}
