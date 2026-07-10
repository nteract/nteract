// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_NOTEBOOK_EDITOR_SETTINGS,
  projectNotebookEditorSettings,
  setNotebookEditorSettings,
} from "../editor-settings-store";

describe("editor-settings-store", () => {
  afterEach(() => {
    setNotebookEditorSettings(DEFAULT_NOTEBOOK_EDITOR_SETTINGS);
  });

  it("projects host editor settings into the frontend shape", () => {
    expect(
      projectNotebookEditorSettings({
        code_font_family: ' "Hack", monospace; color: red ',
        markdown_font_family: "Georgia, serif",
        line_numbers: true,
      }),
    ).toEqual({
      codeFontFamily: ' "Hack", monospace',
      markdownFontFamily: "Georgia, serif",
      lineNumbers: true,
    });
  });

  it("preserves spaces while typing a custom font stack", () => {
    setNotebookEditorSettings({ codeFontFamily: "Fraunces, " });
    expect(setNotebookEditorSettings({ codeFontFamily: "Fraunces, " }).codeFontFamily).toBe(
      "Fraunces, ",
    );
    expect(
      setNotebookEditorSettings({ codeFontFamily: "Fraunces, Georgia, serif" }).codeFontFamily,
    ).toBe("Fraunces, Georgia, serif");
  });

  it("treats whitespace-only font families as empty", () => {
    expect(setNotebookEditorSettings({ codeFontFamily: "   " }).codeFontFamily).toBe("");
  });

  it("applies font settings as notebook typography variables", () => {
    setNotebookEditorSettings({
      codeFontFamily: '"Fira Code", monospace',
      markdownFontFamily: "Georgia, serif",
      lineNumbers: false,
    });

    expect(document.documentElement.style.getPropertyValue("--output-mono-font")).toBe(
      '"Fira Code", monospace',
    );
    expect(document.documentElement.style.getPropertyValue("--output-document-font")).toBe(
      "Georgia, serif",
    );

    setNotebookEditorSettings(DEFAULT_NOTEBOOK_EDITOR_SETTINGS);

    expect(document.documentElement.style.getPropertyValue("--output-mono-font")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--output-document-font")).toBe("");
  });
});
