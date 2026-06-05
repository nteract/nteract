import {
  projectNotebookEditAccess,
  type NotebookEditAccessProjection,
  type NotebookEditHostSupport,
  type NotebookEditMode,
  type NotebookEditPermission,
  type NotebookEditState,
  type ProjectNotebookEditAccessOptions,
} from "runtimed";

export type NotebookInteractionMode = NotebookEditMode;
export type NotebookInteractionState = NotebookEditState;
export type NotebookInteractionPermission = NotebookEditPermission;
export type NotebookInteractionHostSupport = NotebookEditHostSupport;
export type NotebookInteractionModeProjection = NotebookEditAccessProjection;
export type CreateNotebookInteractionModeProjectionOptions = ProjectNotebookEditAccessOptions;

export function createNotebookInteractionModeProjection(
  options: CreateNotebookInteractionModeProjectionOptions,
): NotebookInteractionModeProjection {
  return projectNotebookEditAccess(options);
}
