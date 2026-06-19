import { type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  ViewPlugin,
} from "@codemirror/view";
import { actorInitials, onBehalfOfText } from "runtimed";

/** Compact thread summary shown when hovering a highlighted range. */
export interface CommentHighlightPreview {
  authorName: string;
  authorColor?: string;
  imageUrl?: string | null;
  isAgent?: boolean;
  onBehalfOf?: string | null;
  onBehalfOfColor?: string | null;
  body: string;
  replyCount: number;
}

export interface CommentHighlight {
  from: number;
  to: number;
  threadId: string;
  resolved: boolean;
  color?: string;
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
    backgroundColor: "hsl(var(--muted-foreground) / 0.12)",
    borderBottomColor: "hsl(var(--muted-foreground) / 0.4)",
  },
  ".cm-tooltip.cm-tooltip-hover": {
    border: "none",
    backgroundColor: "transparent",
    color: "hsl(var(--popover-foreground, 222 47% 11%))",
    padding: "0",
  },
});

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

const BOT_ICON_SVG =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';

function buildPreviewDom(preview: CommentHighlightPreview): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText =
    "width:min(300px,80vw);padding:10px 12px;border:1px solid hsl(var(--border, 214 32% 91%));border-radius:10px;background:hsl(var(--popover, 0 0% 100%));color:hsl(var(--popover-foreground, 222 47% 11%));box-shadow:0 8px 24px rgb(0 0 0 / 0.14);font:inherit;";

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:5px;";

  const avatar = document.createElement("span");
  avatar.style.cssText =
    "position:relative;flex:none;width:18px;height:18px;border-radius:50%;color:#fff;font-size:9px;font-weight:600;display:grid;place-items:center;";
  avatar.style.backgroundColor = preview.authorColor ?? "hsl(var(--muted-foreground, 215 16% 47%))";
  if (preview.imageUrl) {
    const image = document.createElement("img");
    image.src = preview.imageUrl;
    image.alt = "";
    image.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover;";
    avatar.appendChild(image);
  } else if (preview.isAgent) {
    avatar.innerHTML = BOT_ICON_SVG;
  } else {
    avatar.textContent = actorInitials(preview.authorName);
  }

  if (preview.isAgent && preview.onBehalfOf) {
    const badge = document.createElement("span");
    badge.style.cssText =
      "position:absolute;bottom:-3px;right:-3px;width:11px;height:11px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:6px;font-weight:700;box-shadow:0 0 0 2px hsl(var(--popover, 0 0% 100%));";
    badge.style.backgroundColor =
      preview.onBehalfOfColor ?? "hsl(var(--muted-foreground, 215 16% 47%))";
    badge.textContent = actorInitials(preview.onBehalfOf).slice(0, 1);
    avatar.appendChild(badge);
  }
  head.appendChild(avatar);

  const name = document.createElement("span");
  name.style.cssText = "font-size:12px;font-weight:600;";
  name.textContent = preview.authorName;
  head.appendChild(name);

  if (preview.isAgent) {
    const meta = document.createElement("span");
    meta.style.cssText = "font-size:10px;color:hsl(var(--muted-foreground, 215 16% 47%));";
    meta.textContent = `AI${onBehalfOfText(preview.onBehalfOf)}`;
    head.appendChild(meta);
  }
  root.appendChild(head);

  const body = document.createElement("div");
  body.style.cssText =
    "font-size:13px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word;";
  body.textContent = preview.body;
  root.appendChild(body);

  if (preview.replyCount > 0) {
    const replies = document.createElement("div");
    replies.style.cssText =
      "margin-top:6px;font-size:10px;color:hsl(var(--muted-foreground, 215 16% 47%));";
    replies.textContent = `+${preview.replyCount} ${preview.replyCount === 1 ? "reply" : "replies"}`;
    root.appendChild(replies);
  }

  return root;
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
  onActivate: CommentHighlightActivateHandler;
  onReady?: (view: EditorView) => void;
}

export function commentHighlightExtension(options: CommentHighlightExtensionOptions): Extension {
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
