import type { NotebookHost } from "@nteract/notebook-host";
import {
  closeNotebookRail,
  getNotebookRailUiState,
  openNotebookRailPanel,
  resetNotebookRailUiState,
} from "@/components/notebook/state/rail-ui-state";

export function initializeNotebookPresentation(host: Pick<NotebookHost, "presentation">): void {
  const rail = host.presentation?.rail;
  resetNotebookRailUiState({
    activePanelId: rail?.initialPanel ?? "outline",
    collapsed: rail?.visible === false || (rail?.initialCollapsed ?? true),
  });
}

export function registerNotebookRailCommands(
  host: Pick<NotebookHost, "commands">,
  showRail: () => void,
): () => void {
  const unregisterOpen = host.commands.register("notebook.rail.open", ({ panelId }) => {
    showRail();
    openNotebookRailPanel(panelId);
  });
  const unregisterClose = host.commands.register("notebook.rail.close", () => {
    if (document.activeElement?.closest('[data-slot="notebook-rail-panel"]')) {
      const label = getNotebookRailUiState().activePanelId === "packages" ? "Packages" : "Outline";
      document
        .querySelector<HTMLButtonElement>(`[data-testid="notebook-rail"] button[aria-label="${label}"]`)
        ?.focus();
    }
    closeNotebookRail();
  });
  return () => {
    unregisterOpen();
    unregisterClose();
  };
}
