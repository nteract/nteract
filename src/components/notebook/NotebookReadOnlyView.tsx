import { ReadOnlyNotebook, type ReadOnlyNotebookProps } from "@/components/cell/ReadOnlyNotebook";
import type { NotebookViewModel } from "./view-model";

export interface NotebookReadOnlyViewProps extends Omit<ReadOnlyNotebookProps, "cells"> {
  viewModel: Pick<NotebookViewModel, "readOnlyCells">;
}

export function NotebookReadOnlyView({ viewModel, ...props }: NotebookReadOnlyViewProps) {
  return <ReadOnlyNotebook cells={viewModel.readOnlyCells} {...props} />;
}
