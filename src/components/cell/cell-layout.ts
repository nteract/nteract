/**
 * Shared notebook cell geometry.
 *
 * The ribbon sits flush against the notebook rail. Source, markdown, outputs,
 * and insertion controls align to the document column defined here.
 */
export const notebookCellLayoutVars =
  "[--cell-content-column-inset:2rem] [--cell-output-row-inset:1rem] [--cell-output-inner-inset:1rem] sm:[--cell-content-column-inset:3.25rem] sm:[--cell-output-row-inset:1.75rem] sm:[--cell-output-inner-inset:1.5rem]";

export const cellContentColumnInset = "pl-[var(--cell-content-column-inset,3.25rem)]";
export const cellContentColumnOffset = "ml-[var(--cell-content-column-inset,3.25rem)]";
export const cellOutputRowInset = "pl-[var(--cell-output-row-inset,1.75rem)]";
export const cellOutputInnerInset = "pl-[var(--cell-output-inner-inset,1.5rem)]";
