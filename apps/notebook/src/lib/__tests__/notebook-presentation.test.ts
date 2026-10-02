import { createCommandRegistry } from "@nteract/notebook-host";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getNotebookRailUiState,
  resetNotebookRailUiState,
  setNotebookRailCollapsed,
} from "@/components/notebook/state/rail-ui-state";
import {
  initializeNotebookPresentation,
  registerNotebookRailCommands,
} from "../notebook-presentation";

afterEach(() => resetNotebookRailUiState());

describe("notebook presentation", () => {
  it("keeps existing defaults when configuration is absent", () => {
    initializeNotebookPresentation({});
    expect(getNotebookRailUiState()).toEqual({
      activePanelId: "outline",
      collapsed: true,
      selectedOutlineItemId: null,
    });
  });

  it("initializes the requested panel before rendering without overwriting later interactions", () => {
    initializeNotebookPresentation({
      presentation: { rail: { initialPanel: "packages", initialCollapsed: false } },
    });
    expect(getNotebookRailUiState().activePanelId).toBe("packages");
    expect(getNotebookRailUiState().collapsed).toBe(false);
    setNotebookRailCollapsed(true);
    expect(getNotebookRailUiState().collapsed).toBe(true);
  });

  it("never expands a hidden rail at initialization", () => {
    initializeNotebookPresentation({
      presentation: { rail: { visible: false, initialPanel: "packages", initialCollapsed: false } },
    });
    expect(getNotebookRailUiState().collapsed).toBe(true);
  });

  it("restores a hidden rail through open and collapses through close", async () => {
    const commands = createCommandRegistry();
    const showRail = vi.fn();
    const dispose = registerNotebookRailCommands({ commands }, showRail);
    await commands.run("notebook.rail.open", { panelId: "packages" });
    expect(showRail).toHaveBeenCalledOnce();
    expect(getNotebookRailUiState().activePanelId).toBe("packages");
    expect(getNotebookRailUiState().collapsed).toBe(false);
    await commands.run("notebook.rail.close", undefined);
    expect(getNotebookRailUiState().collapsed).toBe(true);
    expect(showRail).toHaveBeenCalledOnce();
    dispose();
    expect(commands.list()).toEqual([]);
    registerNotebookRailCommands({ commands }, showRail)();
  });

  it("moves panel focus to the visible rail button before closing", async () => {
    const commands = createCommandRegistry();
    const dispose = registerNotebookRailCommands({ commands }, vi.fn());
    const rail = document.createElement("aside");
    rail.dataset.testid = "notebook-rail";
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Packages");
    rail.append(button);
    const panel = document.createElement("div");
    panel.dataset.slot = "notebook-rail-panel";
    const input = document.createElement("input");
    panel.append(input);
    document.body.append(rail, panel);
    try {
      await commands.run("notebook.rail.open", { panelId: "packages" });
      input.focus();
      await commands.run("notebook.rail.close", undefined);
      expect(document.activeElement).toBe(button);
      expect(getNotebookRailUiState().collapsed).toBe(true);
    } finally {
      dispose();
      rail.remove();
      panel.remove();
    }
  });
});
