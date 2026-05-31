import type { JupyterOutput } from "@/components/cell/jupyter-output";
import type { SupportedLanguage } from "@/components/editor/languages";

export interface NotebookCellListItem {
  id: string;
  cellType: string;
  source: string;
  language?: string | null;
  executionCount?: number | null;
  outputs?: readonly unknown[];
}

export interface ReadOnlyNotebookCellData extends NotebookCellListItem {
  language?: SupportedLanguage | null;
  outputs?: readonly JupyterOutput[];
  executionId?: string | null;
}
