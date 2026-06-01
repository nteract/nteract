export type NotebookInteractionMode = "view" | "edit";
export type NotebookInteractionState = "viewing" | "requested" | "editing";

export interface NotebookInteractionPermission {
  canEditMarkdown: boolean;
  canEditCells: boolean;
  canEditStructure: boolean;
}

export interface NotebookInteractionHostSupport {
  canEditMarkdown: boolean;
  canEditCells: boolean;
  canEditStructure: boolean;
  canRequestEdit: boolean;
}

export interface NotebookInteractionModeProjection extends NotebookInteractionPermission {
  selectedMode: NotebookInteractionMode;
  activeMode: NotebookInteractionMode;
  state: NotebookInteractionState;
  canRequestEdit: boolean;
}

export interface CreateNotebookInteractionModeProjectionOptions {
  selectedMode: NotebookInteractionMode;
  permission: NotebookInteractionPermission;
  hostSupport: NotebookInteractionHostSupport;
}

export function createNotebookInteractionModeProjection({
  hostSupport,
  permission,
  selectedMode,
}: CreateNotebookInteractionModeProjectionOptions): NotebookInteractionModeProjection {
  const wantsEdit = selectedMode === "edit";
  const hasAnyEditPermission =
    permission.canEditMarkdown || permission.canEditCells || permission.canEditStructure;
  const canActivateEdit = wantsEdit && hasAnyEditPermission;
  const activeMode: NotebookInteractionMode = canActivateEdit ? "edit" : "view";
  const state: NotebookInteractionState = !wantsEdit
    ? "viewing"
    : canActivateEdit
      ? "editing"
      : "requested";

  return {
    selectedMode,
    activeMode,
    state,
    canRequestEdit: hostSupport.canRequestEdit,
    canEditMarkdown:
      activeMode === "edit" && permission.canEditMarkdown && hostSupport.canEditMarkdown,
    canEditCells: activeMode === "edit" && permission.canEditCells && hostSupport.canEditCells,
    canEditStructure:
      activeMode === "edit" && permission.canEditStructure && hostSupport.canEditStructure,
  };
}

export function notebookInteractionPresenceLabel(
  interaction: NotebookInteractionModeProjection | null | undefined,
): string | null {
  if (!interaction) return null;

  switch (interaction.state) {
    case "editing":
      return "editing";
    case "requested":
      return "waiting for edit access";
    case "viewing":
      return interaction.canRequestEdit ? "viewing" : "view only";
  }
}
