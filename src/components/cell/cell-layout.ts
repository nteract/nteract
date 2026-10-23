/**
 * Shared notebook cell geometry.
 *
 * The ribbon sits flush against the notebook rail. Source, markdown, outputs,
 * and insertion controls align to the document column defined here.
 *
 * `--cell-state-lane-shift` is half the difference between the current editor
 * line box and the default one. The line box is
 * `var(--nteract-editor-font-size, 0.875rem) × editorLineHeight` (see
 * `editor/editor-metrics.ts`), so the default line box is 1.225rem and the
 * shift is 0 unless a host sets the font-size variable.
 *
 * Tailwind only generates classes it finds as literal strings, so the `1.4`
 * and `1.225rem` are spelled out here; `__tests__/cell-layout.test.ts` checks
 * them against `editor-metrics.ts`.
 */
export const notebookCellLayoutVars =
  "[--cell-content-column-inset:2rem] [--cell-output-row-inset:1rem] [--cell-output-inner-inset:1rem] [--cell-state-lane-shift:calc((var(--nteract-editor-font-size,0.875rem)*1.4-1.225rem)/2)] sm:[--cell-content-column-inset:3.25rem] sm:[--cell-output-row-inset:1.75rem] sm:[--cell-output-inner-inset:1.5rem]";

/**
 * Top padding for the state lane holding the run button and execution count.
 * 1rem compact / 0.875rem wide at the default font size; the shift term keeps
 * the lane on the first editor line when a host changes the font size.
 */
export const cellStateLanePadding =
  "pt-[calc(1rem+var(--cell-state-lane-shift,0px))] sm:pt-[calc(0.875rem+var(--cell-state-lane-shift,0px))]";

export const cellContentColumnInset = "pl-[var(--cell-content-column-inset,3.25rem)]";
export const cellContentColumnOffset = "ml-[var(--cell-content-column-inset,3.25rem)]";
export const cellOutputRowInset = "pl-[var(--cell-output-row-inset,1.75rem)]";
export const cellOutputInnerInset = "pl-[var(--cell-output-inner-inset,1.5rem)]";
