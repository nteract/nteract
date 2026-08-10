import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import {
  MAX_SOURCE_COMMENT_EXACT_QUOTE_BYTES,
  sourceRangeAnchorFromSelection,
  type SourceRangeCommentAnchor,
} from "./comment-source-anchor";

export type SourceCommentRequestHandler = (
  anchor: SourceRangeCommentAnchor,
  quote?: string | null,
) => void;

const setSourceCommentFocusEffect = StateEffect.define<boolean>();
const utf8Encoder = new TextEncoder();
const COMMENT_AFFORDANCE_ICON_SVG =
  '<svg class="comment-affordance-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
  '<path d="M12 7v6"/><path d="M9 10h6"/></svg>';

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

  // The tooltip anchors at the head, the moving end of the selection. When the
  // selection runs leftward the head is at its start, so flip the toolbar to the
  // left of the head instead of letting it sit over the selected text.
  const leftward = selection.head < selection.anchor;

  return [
    {
      pos: selection.head,
      above: true,
      strictSide: false,
      create(view) {
        // Shared selection toolbar (styles/comment-affordance.css), matching the
        // rendered-markdown plane. CodeMirror wraps this in a .cm-tooltip; the
        // shared CSS strips that wrapper's chrome so only the toolbar shows.
        const root = document.createElement("span");
        root.className = leftward
          ? "comment-affordance comment-affordance-flip"
          : "comment-affordance";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "comment-affordance-button";
        button.setAttribute("aria-label", "Add comment on selection");
        button.setAttribute("data-testid", "source-comment-button");
        button.innerHTML = COMMENT_AFFORDANCE_ICON_SVG;
        const tip = document.createElement("span");
        tip.className = "comment-affordance-tip";
        tip.setAttribute("aria-hidden", "true");
        tip.textContent = "Add comment";
        root.appendChild(button);
        root.appendChild(tip);
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          requestSourceComment(cellId, view, onCreateSourceComment);
        });
        return { dom: root };
      },
    },
  ];
}

function requestSourceComment(
  cellId: string,
  view: EditorView,
  onCreateSourceComment: SourceCommentRequestHandler,
): boolean {
  const anchor = sourceRangeAnchorFromSelection(cellId, view);
  if (!anchor) return false;

  onCreateSourceComment(anchor);
  return true;
}
