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

// How long the affordance peeks open when it first appears, so a fresh
// selection can tell what it is before it settles to a quiet dot.
const SOURCE_COMMENT_PEEK_MS = 1400;

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
      pos: selection.head,
      above: true,
      strictSide: false,
      create(view) {
        // Shared dot affordance (styles/comment-affordance.css), matching the
        // rendered-markdown plane. CodeMirror wraps this in a .cm-tooltip; the
        // shared CSS strips that wrapper's chrome so only the dot shows. The dot
        // peeks open once on appear so a fresh selection can tell what it is,
        // then settles to a quiet dot.
        const button = document.createElement("button");
        button.type = "button";
        button.className = "comment-affordance comment-affordance-peek";
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
        const peekTimer = setTimeout(() => {
          button.classList.remove("comment-affordance-peek");
        }, SOURCE_COMMENT_PEEK_MS);
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
            clearTimeout(peekTimer);
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
