import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import {
  MAX_SOURCE_COMMENT_EXACT_QUOTE_CHARS,
  sourceRangeAnchorFromSelection,
  type SourceRangeCommentAnchor,
} from "./comment-source-anchor";

export type SourceCommentRequestHandler = (anchor: SourceRangeCommentAnchor) => void;

const setSourceCommentFocusEffect = StateEffect.define<boolean>();

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

  return [sourceCommentTheme, tooltipField, focusSync, shortcut];
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
  if (selectedText.length > MAX_SOURCE_COMMENT_EXACT_QUOTE_CHARS) return [];

  return [
    {
      pos: selection.to,
      above: true,
      strictSide: false,
      create(view) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cm-source-comment-button";
        button.textContent = "Comment";
        button.title = "Comment on selected source";
        button.setAttribute("aria-label", "Comment on selected source");
        button.setAttribute("data-testid", "source-comment-button");
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

const sourceCommentTheme = EditorView.baseTheme({
  ".cm-source-comment-button": {
    border: "1px solid hsl(var(--border))",
    borderRadius: "0.375rem",
    backgroundColor: "hsl(var(--background))",
    color: "hsl(var(--foreground))",
    boxShadow: "0 1px 4px rgb(0 0 0 / 0.14)",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "11px",
    fontWeight: "500",
    lineHeight: "1",
    padding: "5px 7px",
  },
  ".cm-source-comment-button:hover": {
    backgroundColor: "hsl(var(--muted))",
  },
  ".cm-source-comment-button:focus-visible": {
    outline: "2px solid hsl(var(--ring))",
    outlineOffset: "2px",
  },
});
