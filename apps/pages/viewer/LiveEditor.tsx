import { useEffect, useRef } from "react";
import * as A from "@automerge/automerge/slim";
import { EditorState, Transaction, ChangeSet } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import type { PageReplica } from "./replica.ts";

/** Source editor pending the WYSIWYG spike; every transaction edits the CRDT. */
export function LiveEditor({
  replica,
  id,
  onError,
}: {
  replica: PageReplica;
  id: string | null;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || !replica.doc) return;
    const path = id ? ["blocks", id, "markdown"] : ["title"];
    const source = () => (id ? replica.doc?.blocks[id]?.markdown : replica.doc?.title);
    let remote = false,
      disposed = false;
    let priorHeads = A.getHeads(replica.doc);
    let cursors: { anchor: A.Cursor; head: A.Cursor } | null = null;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: source() ?? "",
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": id ? "Markdown source" : "Page title" }),
          EditorView.updateListener.of((update) => {
            if (remote || !update.docChanged) return;
            try {
              const edits: { from: number; to: number; insert: string }[] = [];
              update.changes.iterChanges((from, to, _fromB, _toB, insert) =>
                edits.push({ from, to, insert: insert.toString() }),
              );
              replica.change((doc) => {
                for (const edit of edits.reverse())
                  A.splice(doc, path, edit.from, edit.to - edit.from, edit.insert);
              });
            } catch (error) {
              onError(error instanceof Error ? error.message : String(error));
              queueMicrotask(() => {
                if (!disposed) sync();
              });
            }
          }),
          EditorView.theme({
            "&": { fontSize: "15px", minHeight: id ? "160px" : "48px" },
            ".cm-content": { fontFamily: "var(--font-mono, monospace)", padding: "12px" },
            ".cm-focused": { outline: "none" },
          }),
        ],
      }),
    });
    function sync() {
      const value = source();
      if (value === undefined || !replica.doc) return;
      const current = view.state.doc.toString();
      if (value === current) {
        priorHeads = A.getHeads(replica.doc);
        return;
      }
      remote = true;
      try {
        let changes = ChangeSet.empty(current.length),
          length = current.length;
        for (const patch of A.diff(replica.doc, priorHeads, A.getHeads(replica.doc))) {
          if (
            patch.path.length !== path.length + 1 ||
            !path.every((key, i) => patch.path[i] === key)
          )
            continue;
          const from = patch.path.at(-1);
          if (typeof from !== "number") continue;
          if (patch.action === "splice") {
            const next = ChangeSet.of({ from, insert: patch.value }, length);
            changes = changes.compose(next);
            length = next.newLength;
          } else if (patch.action === "del") {
            const next = ChangeSet.of({ from, to: from + (patch.length ?? 1) }, length);
            changes = changes.compose(next);
            length = next.newLength;
          }
        }
        // Structural replacement from a semantic tool may replace the text
        // object. Preserve common prefix/suffix instead of resetting the view.
        if (changes.apply(view.state.doc).toString() !== value) {
          let start = 0,
            end = 0;
          while (start < current.length && start < value.length && current[start] === value[start])
            start++;
          while (
            end < current.length - start &&
            end < value.length - start &&
            current[current.length - 1 - end] === value[value.length - 1 - end]
          )
            end++;
          changes = ChangeSet.of(
            {
              from: start,
              to: current.length - end,
              insert: value.slice(start, value.length - end),
            },
            current.length,
          );
        }
        let selection;
        try {
          if (cursors)
            selection = {
              anchor: A.getCursorPosition(replica.doc, path, cursors.anchor),
              head: A.getCursorPosition(replica.doc, path, cursors.head),
            };
        } catch {
          /* Deleted text falls back to CodeMirror's mapped selection. */
        }
        view.dispatch({
          changes,
          selection,
          annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
        });
        priorHeads = A.getHeads(replica.doc);
      } finally {
        remote = false;
      }
    }
    const stop = replica.observe({
      before() {
        if (!replica.doc) return;
        priorHeads = A.getHeads(replica.doc);
        try {
          const selection = view.state.selection.main;
          cursors = {
            anchor: A.getCursor(replica.doc, path, selection.anchor),
            head: A.getCursor(replica.doc, path, selection.head),
          };
        } catch {
          cursors = null;
        }
      },
      after: sync,
    });
    view.focus();
    return () => {
      disposed = true;
      stop();
      view.destroy();
    };
  }, [replica, id]);
  return <div className="live-editor" ref={host} />;
}
