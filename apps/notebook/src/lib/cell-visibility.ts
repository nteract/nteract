import type { NotebookCell } from "../types";

/**
 * Whether a code cell's outputs are hidden via the Jupyter
 * `metadata.jupyter.outputs_hidden` convention. Single source of truth for
 * this read — App.tsx's output-toggle command and NotebookView's
 * eye/eyeOff gutter button must agree on the same metadata shape.
 */
export function isCellOutputsHidden(cell: NotebookCell): boolean {
  const jupyter = cell.metadata?.jupyter as { outputs_hidden?: boolean } | undefined;
  return jupyter?.outputs_hidden === true;
}
