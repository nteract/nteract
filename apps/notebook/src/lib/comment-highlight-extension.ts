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
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  ViewPlugin,
} from "@codemirror/view";

/** Compact thread summary shown when hovering a highlighted range. */
export interface CommentHighlightPreview {
  authorName: string;
  authorColor?: string;
  isAgent?: boolean;
  onBehalfOf?: string | null;
  body: string;
  replyCount: number;
}

export interface CommentHighlight {
  from: number;
  to: number;
  threadId: string;
  /** Resolved threads render quieter than open ones. */
  resolved: boolean;
  /** Author color (hex). Falls back to the default tint when omitted. */
  color?: string;
  /** Summary for the hover preview. */
  preview?: CommentHighlightPreview;
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
  ".cm-tooltip:has(.cm-comment-preview)": {
    // Let the preview card own its chrome instead of the default tooltip box.
    border: "none",
    backgroundColor: "transparent",
  },
  ".cm-comment-preview": {
    width: "min(300px, 80vw)",
    padding: "10px 12px",
    border: "1px solid hsl(var(--border))",
    borderRadius: "10px",
    backgroundColor: "hsl(var(--popover))",
    color: "hsl(var(--popover-foreground))",
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.14)",
    font: "inherit",
  },
  ".cm-comment-preview-head": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginBottom: "5px",
  },
  ".cm-comment-preview-avatar": {
    flex: "none",
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    color: "#fff",
    fontSize: "9px",
    fontWeight: "600",
    display: "grid",
    placeItems: "center",
  },
  ".cm-comment-preview-name": { fontSize: "12px", fontWeight: "600" },
  ".cm-comment-preview-meta": { fontSize: "10px", color: "hsl(var(--muted-foreground))" },
  ".cm-comment-preview-body": {
    fontSize: "13px",
    lineHeight: "1.45",
    display: "-webkit-box",
    WebkitLineClamp: "4",
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  ".cm-comment-preview-replies": {
    marginTop: "6px",
    fontSize: "10px",
    color: "hsl(var(--muted-foreground))",
  },
});

/** Innermost highlight covering a position, if any. */
function highlightAt(view: EditorView, pos: number): CommentHighlight | undefined {
  const highlights = view.state.field(highlightsField, false);
  if (!highlights) return undefined;
  return highlights
    .filter((highlight) => pos >= highlight.from && pos <= highlight.to)
    .sort((a, b) => a.to - a.from - (b.to - b.from))[0];
}

function activateThreadAt(
  view: EditorView,
  pos: number,
  onActivateThread: CommentHighlightActivateHandler,
): boolean {
  const match = highlightAt(view, pos);
  if (!match) return false;
  onActivateThread(match.threadId);
  return true;
}

function buildPreviewDom(preview: CommentHighlightPreview): HTMLElement {
  const root = document.createElement("div");
  root.className = "cm-comment-preview";

  const head = document.createElement("div");
  head.className = "cm-comment-preview-head";

  const avatar = document.createElement("span");
  avatar.className = "cm-comment-preview-avatar";
  avatar.style.backgroundColor = preview.authorColor ?? "hsl(var(--muted-foreground))";
  avatar.textContent = preview.isAgent ? "🤖" : initials(preview.authorName);
  head.appendChild(avatar);

  const name = document.createElement("span");
  name.className = "cm-comment-preview-name";
  name.textContent = preview.authorName;
  head.appendChild(name);

  if (preview.isAgent) {
    const meta = document.createElement("span");
    meta.className = "cm-comment-preview-meta";
    meta.textContent = preview.onBehalfOf ? `AI · for ${preview.onBehalfOf}` : "AI";
    head.appendChild(meta);
  }
  root.appendChild(head);

  const body = document.createElement("div");
  body.className = "cm-comment-preview-body";
  body.textContent = preview.body;
  root.appendChild(body);

  if (preview.replyCount > 0) {
    const replies = document.createElement("div");
    replies.className = "cm-comment-preview-replies";
    replies.textContent = `+${preview.replyCount} ${preview.replyCount === 1 ? "reply" : "replies"}`;
    root.appendChild(replies);
  }

  return root;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const commentHoverTooltip = hoverTooltip(
  (view, pos) => {
    const match = highlightAt(view, pos);
    if (!match?.preview) return null;
    return {
      pos: match.from,
      end: match.to,
      above: true,
      create() {
        return { dom: buildPreviewDom(match.preview as CommentHighlightPreview) };
      },
    };
  },
  { hoverTime: 250 },
);

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
    commentHoverTooltip,
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
