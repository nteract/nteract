/**
 * Editor geometry shared with the cell layout.
 *
 * The code-cell state lane (run button, execution count) is positioned
 * against the first editor line. Both sides derive the line box from the
 * values here: `cell/cell-layout.ts` carries them as Tailwind literals and a
 * unit test keeps the two in step.
 */

/**
 * Line-height set on `.cm-scroller` by `notebookEditorTheme`. CodeMirror's
 * base theme uses the same value; setting it explicitly makes the dependency
 * visible. The first line box is `font-size × editorLineHeight`.
 */
export const editorLineHeight = 1.4;

/** Default editor font size in rem, matching Tailwind `text-sm`. */
export const editorDefaultFontSizeRem = 0.875;

/**
 * Font size for the `CodeMirrorEditor` wrapper. Embedding hosts set
 * `--nteract-editor-font-size` on `:root`; nteract leaves it unset.
 *
 * Tailwind only generates classes it finds as literal strings, so this is
 * spelled out rather than built from `editorDefaultFontSizeRem`.
 */
export const editorFontSizeClass = "text-[length:var(--nteract-editor-font-size,0.875rem)]";
