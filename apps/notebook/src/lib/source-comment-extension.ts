import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { wireCommentAffordanceMotion } from "@/components/comments/comment-affordance-motion";
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

  // The tooltip anchors at the head, the moving end of the selection. When the
  // selection runs leftward the head is at its start, so flip the dot to the left
  // of the head instead of letting it sit on the right, over the selected text.
  const leftward = selection.head < selection.anchor;

  return [
    {
      pos: selection.head,
      above: true,
      strictSide: false,
      create(view) {
        // Shared dot affordance (styles/comment-affordance.css), matching the
        // rendered-markdown plane. CodeMirror wraps this in a .cm-tooltip; the
        // shared CSS strips that wrapper's chrome so only the dot shows. It stays
        // a quiet dot while you select and folds out to a "Comment" pill only on
        // hover or keyboard focus, so dragging a selection never flashes the pill.
        const button = document.createElement("button");
        button.type = "button";
        button.className = leftward
          ? "comment-affordance comment-affordance-flip"
          : "comment-affordance";
        // No title attribute: the native browser tooltip duplicates the bubble's
        // own "Comment" label. aria-label keeps it accessible.
        button.setAttribute("aria-label", "Comment on selection");
        button.setAttribute("data-testid", "source-comment-button");
        const dot = document.createElement("span");
        dot.className = "comment-affordance-dot";
        dot.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.className = "comment-affordance-label";
        label.textContent = "Comment";
        dot.appendChild(label);
        button.appendChild(dot);
        const disposeMotion = wireCommentAffordanceMotion(button);
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          requestSourceComment(cellId, view, onCreateSourceComment);
        });
        return {
          dom: button,
          destroy() {
            disposeMotion();
          },
        };
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

  onCreateSourceComment(anchor, selectionRectFromView(view));
  return true;
}
