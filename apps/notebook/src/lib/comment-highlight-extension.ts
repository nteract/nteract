import { type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  ViewPlugin,
} from "@codemirror/view";
import { actorInitials, onBehalfOfPhrase } from "runtimed";
import { agentBrandMarkSvg } from "@/components/comments/agent-brand-mark";
import { RAIL_TAKEOVER_MEDIA_QUERY } from "@/components/rail";

/** Compact thread summary shown when hovering a highlighted range. */
export interface CommentHighlightPreview {
  authorName: string;
  authorColor?: string;
  imageUrl?: string | null;
  isAgent?: boolean;
  agentSlug?: string | null;
  onBehalfOf?: string | null;
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

const commentHighlightTheme = EditorView.baseTheme({
  ".cm-tooltip.cm-tooltip-hover": {
    border: "none",
    backgroundColor: "transparent",
    color: "var(--popover-foreground, #1e1e1e)",
    padding: "0",
  },
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

function buildPreviewDom(preview: CommentHighlightPreview): HTMLElement {
  const root = document.createElement("div");
  root.style.cssText =
    "width:min(300px,80vw);padding:10px 12px;border:1px solid var(--border, #ebebeb);border-radius:10px;background:var(--popover, #ffffff);color:var(--popover-foreground, #1e1e1e);box-shadow:0 8px 24px rgb(0 0 0 / 0.14);font:inherit;";

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:5px;";

  const avatar = document.createElement("span");
  avatar.style.cssText =
    "flex:none;width:18px;height:18px;border-radius:50%;color:#fff;font-size:9px;font-weight:600;display:grid;place-items:center;";
  avatar.style.backgroundColor = preview.authorColor ?? "var(--muted-foreground, #737373)";
  if (preview.imageUrl) {
    const image = document.createElement("img");
    image.src = preview.imageUrl;
    image.alt = "";
    image.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover;";
    avatar.appendChild(image);
  } else if (preview.isAgent) {
    // Same registry as the Discussions panel, so an agent wears one mark in both
    // places, and the person it acts for is named in the line rather than badged
    // onto the agent's face.
    avatar.innerHTML = agentBrandMarkSvg(preview.agentSlug, 12);
  } else {
    avatar.textContent = actorInitials(preview.authorName);
  }
  head.appendChild(avatar);

  const name = document.createElement("span");
  name.style.cssText = "font-size:12px;font-weight:600;";
  name.textContent = preview.authorName;
  head.appendChild(name);

  if (preview.isAgent) {
    // Same name line as the Discussions panel: the principal an agent acts for is
    // spelled out, and bare "AI" only stands in when it acts for itself.
    const meta = document.createElement("span");
    meta.style.cssText = "font-size:10px;color:var(--muted-foreground, #737373);";
    meta.textContent = onBehalfOfPhrase(preview.onBehalfOf) || "AI";
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
      "margin-top:6px;font-size:10px;color:var(--muted-foreground, #737373);";
    replies.textContent = `+${preview.replyCount} ${preview.replyCount === 1 ? "reply" : "replies"}`;
    root.appendChild(replies);
  }

  return root;
}

/**
 * Hover previews repeat what the Discussions panel already shows, so they only earn
 * their keep when the panel cannot sit beside the notebook. Below the rail takeover
 * width the panel covers the stage, so hovering a highlight is the only way to read
 * its thread without leaving the notebook. Read per hover rather than captured when
 * the extension is built, so resizing the window takes effect immediately.
 */
export function commentHoverPreviewsEnabled(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(RAIL_TAKEOVER_MEDIA_QUERY).matches;
}

const commentHoverTooltip = hoverTooltip(
  (view, pos) => {
    if (!commentHoverPreviewsEnabled()) return null;
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
