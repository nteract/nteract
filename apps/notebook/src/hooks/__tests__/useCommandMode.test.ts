// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { NotebookInteractionTarget } from "runtimed";
import { useCommandMode } from "../useCommandMode";

let mockTarget: NotebookInteractionTarget | null = null;

vi.mock("@/components/notebook/state/cell-ui-state", () => ({
  getActiveInteractionTarget: () => mockTarget,
}));

function dispatchKeyDown(init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  return document.dispatchEvent(event);
}

describe("useCommandMode", () => {
  beforeEach(() => {
    mockTarget = null;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("enters command mode on Escape from an editor target", () => {
    mockTarget = { kind: "editor", cellId: "cell-1" };
    const showCommandMode = vi.fn();
    const enterEditMode = vi.fn();
    const runCommand = vi.fn();

    renderHook(() => useCommandMode({ showCommandMode, enterEditMode, runCommand }));

    dispatchKeyDown({ key: "Escape" });

    expect(showCommandMode).toHaveBeenCalledTimes(1);
  });

  it("enters command mode on Escape from an output target", () => {
    mockTarget = { kind: "output", cellId: "cell-1" };
    const showCommandMode = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode, enterEditMode: vi.fn(), runCommand: vi.fn() }),
    );

    dispatchKeyDown({ key: "Escape" });

    expect(showCommandMode).toHaveBeenCalledTimes(1);
  });

  it("does nothing on Escape when already in command mode", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const showCommandMode = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode, enterEditMode: vi.fn(), runCommand: vi.fn() }),
    );

    dispatchKeyDown({ key: "Escape" });

    expect(showCommandMode).not.toHaveBeenCalled();
  });

  it("does nothing on Escape when no cell is selected", () => {
    mockTarget = null;
    const showCommandMode = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode, enterEditMode: vi.fn(), runCommand: vi.fn() }),
    );

    dispatchKeyDown({ key: "Escape" });

    expect(showCommandMode).not.toHaveBeenCalled();
  });

  it("enters edit mode on Enter while in command mode", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const enterEditMode = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode, runCommand: vi.fn() }),
    );

    dispatchKeyDown({ key: "Enter" });

    expect(enterEditMode).toHaveBeenCalledTimes(1);
  });

  it("ignores Enter when not in command mode", () => {
    mockTarget = { kind: "editor", cellId: "cell-1" };
    const enterEditMode = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode, runCommand: vi.fn() }),
    );

    dispatchKeyDown({ key: "Enter" });

    expect(enterEditMode).not.toHaveBeenCalled();
  });

  it.each([
    ["a", "notebook.insertCellAbove", undefined],
    ["b", "notebook.insertCellBelow", undefined],
    ["m", "notebook.changeCellType", { type: "markdown" }],
    ["y", "notebook.changeCellType", { type: "code" }],
    ["x", "notebook.cutCell", undefined],
    ["o", "notebook.toggleOutput", undefined],
  ] as const)("routes bare '%s' to %s while in command mode", (key, commandId, payload) => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const runCommand = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode: vi.fn(), runCommand }),
    );

    dispatchKeyDown({ key });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(commandId, payload);
  });

  it("ignores letter shortcuts when not in command mode", () => {
    mockTarget = { kind: "editor", cellId: "cell-1" };
    const runCommand = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode: vi.fn(), runCommand }),
    );

    dispatchKeyDown({ key: "a" });

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("ignores letter shortcuts with a modifier key held", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const runCommand = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode: vi.fn(), runCommand }),
    );

    dispatchKeyDown({ key: "a", metaKey: true });
    dispatchKeyDown({ key: "a", ctrlKey: true });
    dispatchKeyDown({ key: "a", altKey: true });

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("ignores letter shortcuts when focus is inside a native input", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const runCommand = vi.fn();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode: vi.fn(), runCommand }),
    );

    dispatchKeyDown({ key: "a" });

    expect(runCommand).not.toHaveBeenCalled();
  });

  it("deletes the cell on a second bare 'd' within the double-key window", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const runCommand = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode: vi.fn(), runCommand }),
    );

    dispatchKeyDown({ key: "d" });
    expect(runCommand).not.toHaveBeenCalled();

    dispatchKeyDown({ key: "d" });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("notebook.deleteFocusedCell", undefined);
  });

  it("does not delete on a single 'd' followed by an unrelated key", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const runCommand = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode: vi.fn(), runCommand }),
    );

    dispatchKeyDown({ key: "d" });
    dispatchKeyDown({ key: "b" });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("notebook.insertCellBelow", undefined);
  });

  it("ignores a repeated (auto-repeat) 'd' keydown as the second press", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const runCommand = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode: vi.fn(), runCommand }),
    );

    dispatchKeyDown({ key: "d" });
    dispatchKeyDown({ key: "d", repeat: true });

    expect(runCommand).not.toHaveBeenCalled();

    // A genuine second distinct press still completes the pair afterward.
    dispatchKeyDown({ key: "d" });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("notebook.deleteFocusedCell", undefined);
  });

  it("does not carry a pending 'd' press over to a different cell", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const runCommand = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode: vi.fn(), runCommand }),
    );

    dispatchKeyDown({ key: "d" });

    // Focus moves to a different cell (e.g. a hidden-group reveal) while
    // still in command mode.
    mockTarget = { kind: "cell", cellId: "cell-2" };
    dispatchKeyDown({ key: "d" });

    expect(runCommand).not.toHaveBeenCalled();

    // The second press on cell-2 is now the new pending first press; a
    // third press on cell-2 within the window completes the pair.
    dispatchKeyDown({ key: "d" });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("notebook.deleteFocusedCell", undefined);
  });

  it("does nothing for letter shortcuts when disabled", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const runCommand = vi.fn();

    renderHook(() =>
      useCommandMode({
        showCommandMode: vi.fn(),
        enterEditMode: vi.fn(),
        runCommand,
        disabled: true,
      }),
    );

    dispatchKeyDown({ key: "a" });

    expect(runCommand).not.toHaveBeenCalled();
  });
});
