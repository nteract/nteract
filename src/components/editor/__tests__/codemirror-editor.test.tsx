// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CodeMirrorEditor, type CodeMirrorEditorRef } from "../codemirror-editor";

vi.mock("@/lib/dark-mode", () => ({
  isDarkMode: () => false,
  useColorTheme: () => undefined,
}));

describe("CodeMirrorEditor", () => {
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
    expect(editorView?.state.readOnly).toBe(true);
  });
});
