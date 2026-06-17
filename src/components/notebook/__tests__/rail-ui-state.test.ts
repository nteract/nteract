import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  closeNotebookRail,
  getNotebookRailUiState,
  openNotebookRailPanel,
  resetNotebookRailUiState,
  setActiveNotebookRailPanel,
  setNotebookRailCollapsed,
  setSelectedNotebookOutlineItemId,
  toggleNotebookRailPanel,
  useNotebookRailUiState,
} from "@/components/notebook/state/rail-ui-state";

afterEach(() => {
  resetNotebookRailUiState();
});

describe("notebook rail UI state", () => {
  it("opens, closes, and toggles panels through one shared store", () => {
    expect(getNotebookRailUiState()).toEqual({
      activePanelId: "outline",
      collapsed: true,
      selectedOutlineItemId: null,
    });

    setSelectedNotebookOutlineItemId("intro:heading:0");
    expect(getNotebookRailUiState()).toEqual({
      activePanelId: "outline",
      collapsed: true,
      selectedOutlineItemId: "intro:heading:0",
    });

    openNotebookRailPanel("packages");
    expect(getNotebookRailUiState()).toEqual({
      activePanelId: "packages",
      collapsed: false,
      selectedOutlineItemId: "intro:heading:0",
    });

    openNotebookRailPanel("comments");
    expect(getNotebookRailUiState()).toEqual({
      activePanelId: "comments",
      collapsed: false,
      selectedOutlineItemId: "intro:heading:0",
    });

    toggleNotebookRailPanel("comments");
    expect(getNotebookRailUiState()).toEqual({
      activePanelId: "comments",
      collapsed: true,
      selectedOutlineItemId: "intro:heading:0",
    });

    toggleNotebookRailPanel("packages");
    expect(getNotebookRailUiState()).toEqual({
      activePanelId: "packages",
      collapsed: false,
      selectedOutlineItemId: "intro:heading:0",
    });

    toggleNotebookRailPanel("outline");
    expect(getNotebookRailUiState()).toEqual({
      activePanelId: "outline",
      collapsed: false,
      selectedOutlineItemId: "intro:heading:0",
    });

    setSelectedNotebookOutlineItemId(null);
    expect(getNotebookRailUiState().selectedOutlineItemId).toBe(null);

    closeNotebookRail();
    expect(getNotebookRailUiState()).toEqual({
      activePanelId: "outline",
      collapsed: true,
      selectedOutlineItemId: null,
    });
  });

  it("notifies React consumers when host policy updates the rail", () => {
    const { result } = renderHook(() => useNotebookRailUiState());

    act(() => setActiveNotebookRailPanel("workstations"));
    expect(result.current).toEqual({
      activePanelId: "workstations",
      collapsed: true,
      selectedOutlineItemId: null,
    });

    act(() => setNotebookRailCollapsed(false));
    expect(result.current).toEqual({
      activePanelId: "workstations",
      collapsed: false,
      selectedOutlineItemId: null,
    });

    act(() => setSelectedNotebookOutlineItemId("outline-1"));
    expect(result.current).toEqual({
      activePanelId: "workstations",
      collapsed: false,
      selectedOutlineItemId: "outline-1",
    });
  });
});
