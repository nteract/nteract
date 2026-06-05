// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CodeMirrorEditor, type CodeMirrorEditorRef } from "../codemirror-editor";
import { ReadOnlyCodeMirror } from "../readonly-codemirror";

vi.mock("@/lib/dark-mode", () => ({
  isDarkMode: () => false,
  useColorTheme: () => undefined,
}));

describe("CodeMirrorEditor", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("focuses without scrolling before handling a mouse click into an unfocused editor", async () => {
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => undefined);

    render(<CodeMirrorEditor initialValue={"first\nsecond\nthird"} theme="light" />);

    const content = await waitFor(() => {
      const el = document.querySelector(".cm-content");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    fireEvent.pointerDown(content);

    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("sets both DOM editability and CodeMirror read-only state in read-only mode", async () => {
    const ref = createRef<CodeMirrorEditorRef>();
    render(<CodeMirrorEditor ref={ref} initialValue={"print('hello')"} readOnly theme="light" />);

    const content = await waitFor(() => {
      const el = document.querySelector(".cm-content");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const editorView = await waitFor(() => {
      const view = ref.current?.getEditor();
      expect(view).not.toBeNull();
      return view;
    });

    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(editorView?.state.facet(EditorState.readOnly)).toBe(true);
  });

  it("reports primary cursor position changes", async () => {
    const ref = createRef<CodeMirrorEditorRef>();
    const onSelectionChange = vi.fn();

    render(
      <CodeMirrorEditor
        ref={ref}
        initialValue="first value"
        onSelectionChange={onSelectionChange}
        theme="light"
      />,
    );

    const editorView = await waitFor(() => {
      const view = ref.current?.getEditor();
      expect(view).not.toBeNull();
      return view;
    });

    act(() => {
      editorView?.dispatch({ selection: { anchor: 5 } });
    });

    expect(onSelectionChange).toHaveBeenCalledWith(5);
  });

  it("keeps read-only CodeMirror content in sync with value changes", async () => {
    const { rerender } = render(<ReadOnlyCodeMirror value="first value" language="plain" />);

    const content = await waitFor(() => {
      const el = document.querySelector(".cm-content");
      expect(el).not.toBeNull();
      expect(el?.textContent).toContain("first value");
      return el as HTMLElement;
    });

    rerender(<ReadOnlyCodeMirror value="second value" language="plain" />);

    await waitFor(() => {
      expect(content.textContent).toContain("second value");
      expect(content.textContent).not.toContain("first value");
    });
    expect(content.getAttribute("contenteditable")).toBe("false");
  });
});
