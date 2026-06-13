// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import type { EditorView, KeyBinding } from "@codemirror/view";
import { describe, expect, it, vi } from "vite-plus/test";
import { useCellKeyboardNavigation } from "../useCellKeyboardNavigation";

function bindingFor(bindings: KeyBinding[], key: string): KeyBinding {
  const binding = bindings.find((candidate) => candidate.key === key);
  expect(binding).toBeDefined();
  return binding!;
}

describe("useCellKeyboardNavigation", () => {
  it("routes Shift-Enter through execute and then focuses the next cell", () => {
    const onExecute = vi.fn();
    const onFocusNext = vi.fn();

    const { result } = renderHook(() =>
      useCellKeyboardNavigation({
        onFocusPrevious: vi.fn(),
        onFocusNext,
        onExecute,
      }),
    );

    expect(bindingFor(result.current, "Shift-Enter").run({} as EditorView)).toBe(true);

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onFocusNext).toHaveBeenCalledWith("start");
  });

  it("routes Ctrl-Enter and Mod-Enter through in-place execute when provided", () => {
    const onExecute = vi.fn();
    const onExecuteInPlace = vi.fn();
    const onFocusNext = vi.fn();

    const { result } = renderHook(() =>
      useCellKeyboardNavigation({
        onFocusPrevious: vi.fn(),
        onFocusNext,
        onExecute,
        onExecuteInPlace,
      }),
    );

    expect(bindingFor(result.current, "Ctrl-Enter").run({} as EditorView)).toBe(true);
    expect(bindingFor(result.current, "Mod-Enter").run({} as EditorView)).toBe(true);

    expect(onExecuteInPlace).toHaveBeenCalledTimes(2);
    expect(onExecute).not.toHaveBeenCalled();
    expect(onFocusNext).not.toHaveBeenCalled();
  });

  it("falls back to execute for in-place keys when no in-place callback exists", () => {
    const onExecute = vi.fn();

    const { result } = renderHook(() =>
      useCellKeyboardNavigation({
        onFocusPrevious: vi.fn(),
        onFocusNext: vi.fn(),
        onExecute,
      }),
    );

    expect(bindingFor(result.current, "Ctrl-Enter").run({} as EditorView)).toBe(true);
    expect(bindingFor(result.current, "Mod-Enter").run({} as EditorView)).toBe(true);

    expect(onExecute).toHaveBeenCalledTimes(2);
  });

  it("consumes execution shortcuts without executing or moving focus when requested", () => {
    const onFocusNext = vi.fn();

    const { result } = renderHook(() =>
      useCellKeyboardNavigation({
        onFocusPrevious: vi.fn(),
        onFocusNext,
        consumeExecutionShortcuts: true,
      }),
    );

    expect(bindingFor(result.current, "Shift-Enter").run({} as EditorView)).toBe(true);
    expect(bindingFor(result.current, "Ctrl-Enter").run({} as EditorView)).toBe(true);
    expect(bindingFor(result.current, "Mod-Enter").run({} as EditorView)).toBe(true);
    expect(bindingFor(result.current, "Alt-Enter").run({} as EditorView)).toBe(true);

    expect(onFocusNext).not.toHaveBeenCalled();
  });
});
