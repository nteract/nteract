import { useSyncExternalStore } from "react";
import type { NotebookRailPanelId } from "@/components/notebook-rail";

export interface NotebookRailUiState {
  activePanelId: NotebookRailPanelId;
  collapsed: boolean;
  selectedOutlineItemId: string | null;
}

const DEFAULT_RAIL_UI_STATE: NotebookRailUiState = Object.freeze({
  activePanelId: "outline",
  collapsed: true,
  selectedOutlineItemId: null,
});

let railUiState: NotebookRailUiState = DEFAULT_RAIL_UI_STATE;
const subscribers = new Set<() => void>();

export function useNotebookRailUiState(): NotebookRailUiState {
  return useSyncExternalStore(subscribeNotebookRailUiState, getNotebookRailUiState);
}

export function getNotebookRailUiState(): NotebookRailUiState {
  return railUiState;
}

export function setActiveNotebookRailPanel(panelId: NotebookRailPanelId): void {
  setNotebookRailUiState({ activePanelId: panelId });
}

export function setNotebookRailCollapsed(collapsed: boolean): void {
  setNotebookRailUiState({ collapsed });
}

export function setSelectedNotebookOutlineItemId(itemId: string | null): void {
  setNotebookRailUiState({ selectedOutlineItemId: itemId });
}

export function openNotebookRailPanel(panelId: NotebookRailPanelId): void {
  setNotebookRailUiState({ activePanelId: panelId, collapsed: false });
}

export function closeNotebookRail(): void {
  setNotebookRailUiState({ collapsed: true });
}

export function toggleNotebookRailPanel(panelId: NotebookRailPanelId): void {
  const current = getNotebookRailUiState();
  if (!current.collapsed && current.activePanelId === panelId) {
    closeNotebookRail();
    return;
  }
  openNotebookRailPanel(panelId);
}

export function resetNotebookRailUiState(next: Partial<NotebookRailUiState> = {}): void {
  setNotebookRailUiState({
    activePanelId: next.activePanelId ?? DEFAULT_RAIL_UI_STATE.activePanelId,
    collapsed: next.collapsed ?? DEFAULT_RAIL_UI_STATE.collapsed,
    selectedOutlineItemId: hasPatch(next, "selectedOutlineItemId")
      ? (next.selectedOutlineItemId ?? null)
      : DEFAULT_RAIL_UI_STATE.selectedOutlineItemId,
  });
}

function subscribeNotebookRailUiState(callback: () => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

function setNotebookRailUiState(patch: Partial<NotebookRailUiState>): void {
  const next = {
    activePanelId: patch.activePanelId ?? railUiState.activePanelId,
    collapsed: patch.collapsed ?? railUiState.collapsed,
    selectedOutlineItemId: hasPatch(patch, "selectedOutlineItemId")
      ? (patch.selectedOutlineItemId ?? null)
      : railUiState.selectedOutlineItemId,
  };
  if (
    next.activePanelId === railUiState.activePanelId &&
    next.collapsed === railUiState.collapsed &&
    next.selectedOutlineItemId === railUiState.selectedOutlineItemId
  ) {
    return;
  }
  railUiState = Object.freeze(next);
  for (const callback of subscribers) {
    callback();
  }
}

function hasPatch<T extends object>(patch: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}
