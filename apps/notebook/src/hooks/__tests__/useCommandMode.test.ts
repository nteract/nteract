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
    const enterEditMode = vi.fn(() => true);

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode, runCommand: vi.fn() }),
    );

    dispatchKeyDown({ key: "Enter" });

    expect(enterEditMode).toHaveBeenCalledTimes(1);
  });

  it("leaves Enter unhandled when the selected cell cannot enter edit mode", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const enterEditMode = vi.fn(() => false);

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode, runCommand: vi.fn() }),
    );

    expect(dispatchKeyDown({ key: "Enter" })).toBe(true);
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

  it("does not treat Shift+Enter as bare Enter", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const enterEditMode = vi.fn(() => true);

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode, runCommand: vi.fn() }),
    );

    expect(dispatchKeyDown({ key: "Enter", shiftKey: true })).toBe(true);
    expect(enterEditMode).not.toHaveBeenCalled();
  });

  it.each([
    ["ArrowUp", "previous"],
    ["ArrowDown", "next"],
    ["k", "previous"],
    ["j", "next"],
    ["K", "previous"],
    ["J", "next"],
  ] as const)("routes %s to command-mode %s selection", (key, direction) => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const navigateSelection = vi.fn(() => true);

    renderHook(() =>
      useCommandMode({
        showCommandMode: vi.fn(),
        enterEditMode: vi.fn(),
        navigateSelection,
        runCommand: vi.fn(),
      }),
    );

    expect(dispatchKeyDown({ key })).toBe(false);
    expect(navigateSelection).toHaveBeenCalledWith(direction, "cell-1");
  });

  it("leaves an arrow unhandled when selection cannot move", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const navigateSelection = vi.fn(() => false);

    renderHook(() =>
      useCommandMode({
        showCommandMode: vi.fn(),
        enterEditMode: vi.fn(),
        navigateSelection,
        runCommand: vi.fn(),
      }),
    );

    expect(dispatchKeyDown({ key: "ArrowUp" })).toBe(true);
    expect(navigateSelection).toHaveBeenCalledTimes(1);
  });

  it.each(["ArrowDown", "ArrowUp", "j", "k"])(
    "ignores %s outside command mode or with modifiers",
    (key) => {
      mockTarget = { kind: "editor", cellId: "cell-1" };
      const navigateSelection = vi.fn(() => true);

      renderHook(() =>
        useCommandMode({
          showCommandMode: vi.fn(),
          enterEditMode: vi.fn(),
          navigateSelection,
          runCommand: vi.fn(),
        }),
      );

      dispatchKeyDown({ key });
      mockTarget = { kind: "cell", cellId: "cell-1" };
      dispatchKeyDown({ key, shiftKey: true });
      dispatchKeyDown({ key, metaKey: true });
      dispatchKeyDown({ key, ctrlKey: true });
      dispatchKeyDown({ key, altKey: true });

      expect(navigateSelection).not.toHaveBeenCalled();
    },
  );

  it("uses the latest arrow navigation callback after rerender", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const firstNavigate = vi.fn(() => true);
    const secondNavigate = vi.fn(() => true);
    const { rerender } = renderHook(
      ({ navigateSelection }) =>
        useCommandMode({
          showCommandMode: vi.fn(),
          enterEditMode: vi.fn(),
          navigateSelection,
          runCommand: vi.fn(),
        }),
      { initialProps: { navigateSelection: firstNavigate } },
    );

    rerender({ navigateSelection: secondNavigate });
    dispatchKeyDown({ key: "ArrowDown" });

    expect(firstNavigate).not.toHaveBeenCalled();
    expect(secondNavigate).toHaveBeenCalledWith("next", "cell-1");
  });

  it.each(["ArrowDown", "ArrowUp", "j", "k"])("does not complete D,D after %s", (key) => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const runCommand = vi.fn();

    renderHook(() =>
      useCommandMode({
        showCommandMode: vi.fn(),
        enterEditMode: vi.fn(),
        navigateSelection: vi.fn(() => true),
        runCommand,
      }),
    );

    dispatchKeyDown({ key: "d" });
    dispatchKeyDown({ key });
    dispatchKeyDown({ key: "d" });

    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["a", "insert-above"],
    ["b", "insert-below"],
    ["m", "change-to-markdown"],
    ["y", "change-to-code"],
    ["o", "toggle-output"],
  ] as const)("routes bare '%s' to %s while in command mode", (key, command) => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const runCommand = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode: vi.fn(), runCommand }),
    );

    dispatchKeyDown({ key });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(command, "cell-1");
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

  it("does not bind X until recoverable cell cut and paste semantics exist", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const runCommand = vi.fn();

    renderHook(() =>
      useCommandMode({ showCommandMode: vi.fn(), enterEditMode: vi.fn(), runCommand }),
    );

    const unhandled = dispatchKeyDown({ key: "x" });

    expect(unhandled).toBe(true);
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

  it("does not hijack Enter, Escape, arrows, or letter keys from a focused button", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const showCommandMode = vi.fn();
    const enterEditMode = vi.fn();
    const navigateSelection = vi.fn(() => true);
    const runCommand = vi.fn();
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    renderHook(() =>
      useCommandMode({ showCommandMode, enterEditMode, navigateSelection, runCommand }),
    );

    dispatchKeyDown({ key: "Enter" });
    dispatchKeyDown({ key: "Escape" });
    dispatchKeyDown({ key: "ArrowDown" });
    dispatchKeyDown({ key: "a" });

    expect(showCommandMode).not.toHaveBeenCalled();
    expect(enterEditMode).not.toHaveBeenCalled();
    expect(navigateSelection).not.toHaveBeenCalled();
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
    expect(runCommand).toHaveBeenCalledWith("delete", "cell-1");
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
    expect(runCommand).toHaveBeenCalledWith("insert-below", "cell-1");
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
    expect(runCommand).toHaveBeenCalledWith("delete", "cell-1");
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
    expect(runCommand).toHaveBeenCalledWith("delete", "cell-2");
  });

  it("does nothing for command-mode shortcuts when disabled", () => {
    mockTarget = { kind: "cell", cellId: "cell-1" };
    const navigateSelection = vi.fn(() => true);
    const runCommand = vi.fn();

    renderHook(() =>
      useCommandMode({
        showCommandMode: vi.fn(),
        enterEditMode: vi.fn(),
        navigateSelection,
        runCommand,
        disabled: true,
      }),
    );

    dispatchKeyDown({ key: "a" });
    dispatchKeyDown({ key: "ArrowDown" });

    expect(navigateSelection).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });
});
