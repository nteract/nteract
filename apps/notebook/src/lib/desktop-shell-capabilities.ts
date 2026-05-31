import type {
  NotebookShellAccessLevel,
  NotebookShellAccessSource,
  NotebookShellCapabilities,
} from "@/components/notebook-shell/capabilities";
import { createNotebookShellCapabilities } from "@/components/notebook-shell/capabilities";

export interface DesktopNotebookShellCapabilityInput {
  canAcceptCellMutations: boolean;
  sessionReady: boolean;
  localActor: string | null;
  connectionScope: string | null;
}

export function desktopNotebookShellCapabilities({
  canAcceptCellMutations,
  sessionReady,
  localActor,
  connectionScope,
}: DesktopNotebookShellCapabilityInput): NotebookShellCapabilities {
  const accessLevel = desktopAccessLevelFromConnectionScope(connectionScope);
  const source = desktopAccessSourceFromConnectionScope(connectionScope);

  return createNotebookShellCapabilities({
    canMutateDocument: canAcceptCellMutations,
    canRequestEdit: false,
    canExecute: sessionReady,
    canToggleCode: true,
    canViewPackages: true,
    canManagePackages: true,
    canManageSharing: source === "cloud",
    access: {
      level: accessLevel,
      source,
      isPublic: false,
      actorLabel: localActor,
      identityLabel: localActor,
    },
    auth: {
      canSignIn: false,
      canUseAuthenticatedIdentity: Boolean(localActor),
      needsAttention: false,
    },
  });
}

function desktopAccessLevelFromConnectionScope(
  connectionScope: string | null,
): NotebookShellAccessLevel {
  if (connectionScope === "viewer" || connectionScope === "editor" || connectionScope === "owner") {
    return connectionScope;
  }
  if (connectionScope === "runtime_peer") {
    return "viewer";
  }
  return "owner";
}

function desktopAccessSourceFromConnectionScope(
  connectionScope: string | null,
): NotebookShellAccessSource {
  return connectionScope ? "cloud" : "local";
}
