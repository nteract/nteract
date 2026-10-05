import { type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
} from "@codemirror/view";

export interface CommentHighlight {
  from: number;
  to: number;
  threadId: string;
  resolved: boolean;
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
          ? "cm-comment-highlight comment-highlight cm-comment-highlight-resolved comment-highlight-resolved"
          : "cm-comment-highlight comment-highlight",
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

function highlightAt(
  view: EditorView,
  pos: number,
  options: { endExclusive?: boolean } = {},
): CommentHighlight | undefined {
  const highlights = view.state.field(highlightsField, false);
  if (!highlights) return undefined;
  const contains = options.endExclusive
    ? (highlight: CommentHighlight) => pos >= highlight.from && pos < highlight.to
    : (highlight: CommentHighlight) => pos >= highlight.from && pos <= highlight.to;
  return highlights
    .filter(contains)
    .sort((a, b) => a.to - a.from - (b.to - b.from))[0];
}

function activateThreadAt(
  view: EditorView,
  pos: number,
  onActivateThread: CommentHighlightActivateHandler,
): boolean {
  const match = highlightAt(view, pos, { endExclusive: true });
  if (!match) return false;
  onActivateThread(match.threadId);
  return true;
}

export interface CommentHighlightExtensionOptions {
  onActivate: CommentHighlightActivateHandler;
  onReady?: (view: EditorView) => void;
}

export function commentHighlightExtension(options: CommentHighlightExtensionOptions): Extension {
  const extensions: Extension[] = [
    highlightsField,
    decorationsField,
    EditorView.domEventHandlers({
      click(event, view) {
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
