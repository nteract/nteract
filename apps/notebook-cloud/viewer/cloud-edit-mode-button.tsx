import {
  NotebookEditModeButton,
  type NotebookInteractionMode,
  type NotebookInteractionModeProjection,
  type NotebookShellCapabilities,
} from "@/components/notebook";
import type { CloudPrototypeAuthState } from "./collaborator-auth";

export function CloudNotebookEditModeButton({
  authState,
  hasAppSession,
  accessLevel,
  accessPending,
  interaction,
  reconnecting = false,
  onModeChange,
  onRequestEditAccess,
}: {
  authState: CloudPrototypeAuthState;
  hasAppSession: boolean;
  accessLevel: NotebookShellCapabilities["access"]["level"];
  accessPending: boolean;
  interaction: NotebookInteractionModeProjection | null;
  reconnecting?: boolean;
  onModeChange: (mode: NotebookInteractionMode) => void;
  onRequestEditAccess: () => void;
}) {
  const canUseEditModeControl =
    hasAppSession || authState.mode === "dev" || authState.mode === "oidc";
  if (
    !canUseEditModeControl ||
    (!interaction?.canRequestEdit && interaction?.activeMode !== "edit")
  ) {
    return null;
  }
  const canSwitchToEdit = accessLevel === "editor" || accessLevel === "owner";
  const editLabel = canSwitchToEdit ? "Editing" : "Request edit";
  const editTitle = canSwitchToEdit ? "Switch to edit mode" : "Request edit access";

  return (
    <NotebookEditModeButton
      editLabel={editLabel}
      editTitle={editTitle}
      requestedEditLabel={reconnecting ? "Offline" : "Request sent"}
      requestedEditTitle={
        reconnecting ? "Offline while the room reconnects" : "Edit access requested"
      }
      mode={accessPending ? "view" : interaction.selectedMode}
      state={accessPending ? "viewing" : interaction.state}
      variant="segmented"
      disabled={accessPending}
      onModeChange={(mode) => {
        if (mode === "edit" && !canSwitchToEdit) {
          onRequestEditAccess();
          return;
        }
        onModeChange(mode);
      }}
    />
  );
}
