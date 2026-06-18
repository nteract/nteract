/**
 * CodeMirror extension that highlights source ranges with comment threads.
 *
 * Unlike the transient text-attribution sweep, these highlights are durable:
 * they persist for the life of the thread and let the reader click the
 * highlighted text to open the thread in the comments rail (Google Docs style).
 *
 * Data flows in from `comment-highlights`, which resolves projection anchors to
 * live offsets and pushes them via `setCommentHighlightsEffect`. Positions are
 * remapped through document changes so a highlight tracks its text while the
 * author keeps editing.
 */

import { type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from "@codemirror/view";

export interface CommentHighlight {
  from: number;
  to: number;
  threadId: string;
  /** Resolved threads render quieter than open ones. */
  resolved: boolean;
  /** Author color (hex). Falls back to the default tint when omitted. */
  color?: string;
}

export type CommentHighlightActivateHandler = (threadId: string) => void;

export const setCommentHighlightsEffect = StateEffect.define<CommentHighlight[]>();

const highlightsField = StateField.define<CommentHighlight[]>({
  create: () => [],
  update(highlights, tr) {
    let next = highlights;
    if (tr.docChanged) {
      next = next
        .map((highlight) => ({
          ...highlight,
          from: tr.changes.mapPos(highlight.from, 1),
          to: tr.changes.mapPos(highlight.to, -1),
        }))
        .filter((highlight) => highlight.from < highlight.to);
    }
    for (const effect of tr.effects) {
      if (effect.is(setCommentHighlightsEffect)) {
        next = effect.value.filter((highlight) => highlight.from < highlight.to);
      }
    }
    return next;
  },
});

function buildDecorations(highlights: CommentHighlight[]): DecorationSet {
  if (highlights.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const sorted = [...highlights].sort((a, b) => a.from - b.from || a.to - b.to);
  for (const highlight of sorted) {
    const attributes: Record<string, string> = {
      "data-comment-thread-id": highlight.threadId,
    };
    if (highlight.color) {
      attributes.style = `--cm-comment-color: ${highlight.color};`;
    }
    builder.add(
      highlight.from,
      highlight.to,
      Decoration.mark({
        class: highlight.resolved
          ? "cm-comment-highlight cm-comment-highlight-resolved"
          : "cm-comment-highlight",
        attributes,
      }),
    );
  }
  return builder.finish();
}

const decorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    const changed =
      tr.docChanged || tr.effects.some((effect) => effect.is(setCommentHighlightsEffect));
    if (!changed) return decorations;
    return buildDecorations(tr.state.field(highlightsField));
  },
  provide: (field) => EditorView.decorations.from(field),
});

const commentHighlightTheme = EditorView.baseTheme({
  ".cm-comment-highlight": {
    // `--cm-comment-color` is set per author; amber is the fallback default.
    "--cm-comment-color": "hsl(45 93% 47%)",
    backgroundColor: "color-mix(in srgb, var(--cm-comment-color) 22%, transparent)",
    borderBottom: "2px solid color-mix(in srgb, var(--cm-comment-color) 70%, transparent)",
    borderRadius: "2px",
    cursor: "pointer",
    transition: "background-color 120ms ease",
  },
  ".cm-comment-highlight:hover": {
    backgroundColor: "color-mix(in srgb, var(--cm-comment-color) 38%, transparent)",
  },
  ".cm-comment-highlight-resolved": {
    // Resolved threads drop the author color for a quiet, neutral gray.
    backgroundColor: "hsl(var(--muted-foreground) / 0.12)",
    borderBottomColor: "hsl(var(--muted-foreground) / 0.4)",
  },
});

function activateThreadAt(
  view: EditorView,
  pos: number,
  onActivateThread: CommentHighlightActivateHandler,
): boolean {
  const highlights = view.state.field(highlightsField, false);
  if (!highlights) return false;
  // Prefer the innermost highlight covering the click position.
  const match = highlights
    .filter((highlight) => pos >= highlight.from && pos <= highlight.to)
    .sort((a, b) => a.to - a.from - (b.to - b.from))[0];
  if (!match) return false;
  onActivateThread(match.threadId);
  return true;
}

export interface CommentHighlightExtensionOptions {
  /** Called when the reader clicks highlighted, commented text. */
  onActivate: CommentHighlightActivateHandler;
  /**
   * Called once when the editor is created, so the caller can push the current
   * highlights into an editor that mounted after the projection was last seen.
   */
  onReady?: (view: EditorView) => void;
}

export function commentHighlightExtension(
  options: CommentHighlightExtensionOptions,
): Extension {
  const extensions: Extension[] = [
    highlightsField,
    decorationsField,
    commentHighlightTheme,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const target = event.target as HTMLElement | null;
        if (!target?.closest(".cm-comment-highlight")) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        return activateThreadAt(view, pos, options.onActivate);
      },
    }),
  ];

  const { onReady } = options;
  if (onReady) {
    extensions.push(
      ViewPlugin.define((view) => {
        onReady(view);
        return {};
      }),
    );
  }

  return extensions;
}
