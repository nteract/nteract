import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import {
  MAX_SOURCE_COMMENT_EXACT_QUOTE_BYTES,
  selectionRectFromView,
  sourceRangeAnchorFromSelection,
  type SourceCommentSelectionRect,
  type SourceRangeCommentAnchor,
} from "./comment-source-anchor";

export type SourceCommentRequestHandler = (
  anchor: SourceRangeCommentAnchor,
  rect: SourceCommentSelectionRect | null,
) => void;

const setSourceCommentFocusEffect = StateEffect.define<boolean>();
const utf8Encoder = new TextEncoder();

interface SourceCommentTooltipState {
  focused: boolean;
  tooltips: readonly Tooltip[];
}

export function sourceCommentExtension(
  cellId: string,
  onCreateSourceComment: SourceCommentRequestHandler,
): Extension {
  const tooltipField = StateField.define<SourceCommentTooltipState>({
    create() {
      return { focused: false, tooltips: [] };
    },
    update(value, transaction) {
      let focused = value.focused;
      let focusChanged = false;
      for (const effect of transaction.effects) {
        if (effect.is(setSourceCommentFocusEffect)) {
          focused = effect.value;
          focusChanged = true;
        }
      }

      if (!focusChanged && !transaction.selection && !transaction.docChanged) return value;
      return {
        focused,
        tooltips: focused
          ? sourceCommentTooltips(transaction.state, cellId, onCreateSourceComment)
          : [],
      };
    },
    provide: (field) => showTooltip.computeN([field], (state) => state.field(field).tooltips),
  });

  const focusSync = EditorView.updateListener.of((update) => {
    if (!update.focusChanged && !update.selectionSet && !update.docChanged) return;
    const current = update.state.field(tooltipField, false);
    if (!current || current.focused === update.view.hasFocus) return;
    update.view.dispatch({
      effects: setSourceCommentFocusEffect.of(update.view.hasFocus),
    });
  });

  const shortcut = keymap.of([
    {
      key: "Mod-Alt-m",
      run(view) {
        return requestSourceComment(cellId, view, onCreateSourceComment);
      },
    },
  ]);

  return [tooltipField, focusSync, shortcut];
}

function sourceCommentTooltips(
  state: EditorView["state"],
  cellId: string,
  onCreateSourceComment: SourceCommentRequestHandler,
): readonly Tooltip[] {
  const selection = state.selection.main;
  if (selection.empty) return [];
  const selectedText = state.doc.sliceString(selection.from, selection.to);
  if (selectedText.trim().length === 0) return [];
  if (utf8Encoder.encode(selectedText).length > MAX_SOURCE_COMMENT_EXACT_QUOTE_BYTES) return [];

  return [
    {
      pos: selection.to,
      above: true,
      strictSide: false,
      create(view) {
        // Shared dot affordance (styles/comment-affordance.css), matching the
        // rendered-markdown plane. CodeMirror wraps this in a .cm-tooltip; the
        // shared CSS strips that wrapper's chrome so only the dot shows.
        const button = document.createElement("button");
        button.type = "button";
        button.className = "comment-affordance";
        button.title = "Comment on selection";
        button.setAttribute("aria-label", "Comment on selection");
        button.setAttribute("data-testid", "source-comment-button");
        const dot = document.createElement("span");
        dot.className = "comment-affordance-dot";
        dot.setAttribute("aria-hidden", "true");
        dot.appendChild(createCommentIcon());
        button.appendChild(dot);
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          requestSourceComment(cellId, view, onCreateSourceComment);
        });
        return { dom: button };
      },
    },
  ];
}

function createCommentIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "comment-affordance-icon");
  icon.setAttribute("width", "14");
  icon.setAttribute("height", "14");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");

  const bubble = document.createElementNS("http://www.w3.org/2000/svg", "path");
  bubble.setAttribute("d", "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
  icon.appendChild(bubble);

  const vertical = document.createElementNS("http://www.w3.org/2000/svg", "path");
  vertical.setAttribute("d", "M12 7v6");
  icon.appendChild(vertical);

  const horizontal = document.createElementNS("http://www.w3.org/2000/svg", "path");
  horizontal.setAttribute("d", "M9 10h6");
  icon.appendChild(horizontal);

  return icon;
}

function requestSourceComment(
  cellId: string,
  view: EditorView,
  onCreateSourceComment: SourceCommentRequestHandler,
): boolean {
  const anchor = sourceRangeAnchorFromSelection(cellId, view);
  if (!anchor) return false;

  onCreateSourceComment(anchor, selectionRectFromView(view));
  return true;
}
