// The Page document's editor vocabulary, shared by the editor
// (WordgardEditor.jsx) and the read-only card shell (card-shell.mjs), so a
// card draws every node the way the Page does.
import { Wordgard, Decoration } from "wordgard/editor";
import { GardState } from "wordgard/state";
import { tables } from "wordgard/table";
import {
  blockDoc,
  paragraph,
  heading,
  lineBreak,
  strong,
  emphasis,
  code,
  codeBlock,
  codeBlockLanguage,
  bulletList,
  orderedList,
  blockquote,
} from "wordgard/schema";
import { tablePresentation } from "./wordgard-tables.mjs";
import { PagesLink, elements } from "./wordgard-model.mjs";
import { taskLists } from "./wordgard-task-lists.mjs";
import { displaySymbols } from "./wordgard-symbols.mjs";
import {
  wordgardCodeNewlines,
  wordgardForeignMarks,
  wordgardListStarts,
} from "./wordgard-binding.mjs";
import { wordgardWidgets } from "./wordgard-widgets.mjs";
import { wordgardDataframes } from "./wordgard-dataframes.mjs";
import { wordgardViews } from "./wordgard-views.mjs";
import { wordgardImages } from "./wordgard-images.mjs";
import { codeHighlighting } from "./code-highlight.mjs";

/** The block and mark node types every Page editor holds. */
export const pageNodes = () => [
  blockDoc(),
  paragraph(),
  heading(),
  lineBreak(),
  strong(),
  emphasis(),
  code(),
  bulletList(),
  orderedList(),
  taskLists(),
  blockquote(),
  codeBlock(),
];

/**
 * A read-only Page block with the editor's own widgets (Mermaid, dataframes,
 * highlighted code, task checkboxes, tables), and nothing that edits,
 * collaborates, comments, uploads or keeps history. Links draw as text: no
 * href. `eagerDataframes` loads every dataframe at once instead of when it
 * nears the viewport, for a shell nobody scrolls.
 *
 * With `views` and `sources` (a session's view replicas and source store),
 * each view node draws its chart near the viewport, as the editor does.
 * Without them a view node draws its own inert figure.
 */
export function readOnlyPageConfig({
  pageId,
  eagerDataframes = false,
  views = null,
  sources = null,
}) {
  return [
    ...pageNodes(),
    tables({ cellContent: "inline", cellSpanning: false }),
    tablePresentation,
    GardState.schemaElement.of(elements),
    Decoration.Mark.shape(PagesLink, { element: "a", attributes: () => ({}) }),
    wordgardWidgets(),
    wordgardDataframes({ pageId, eager: eagerDataframes }),
    ...(views && sources ? [wordgardViews({ views, sources })] : []),
    wordgardImages(),
    wordgardCodeNewlines,
    wordgardForeignMarks,
    wordgardListStarts,
    codeHighlighting,
    displaySymbols,
    GardState.readOnly.of(true),
    Wordgard.editable.of(false),
    codeBlockLanguage(),
  ];
}
