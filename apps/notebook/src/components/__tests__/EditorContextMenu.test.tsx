import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildEditorContextGroups,
  type BuildEditorContextGroupsOptions,
} from "../EditorContextMenu";

function buildActions(overrides: Partial<BuildEditorContextGroupsOptions> = {}) {
  const groups = buildEditorContextGroups({
    editable: false,
    hasSelection: false,
    canComment: false,
    onCopy: vi.fn(),
    onCut: vi.fn(),
    onPaste: vi.fn(),
    onAddComment: vi.fn(),
    ...overrides,
  });

  return groups[0]?.actions ?? [];
}

describe("buildEditorContextGroups", () => {
  it("shows copy, cut, paste, and comment for editable selections that can comment", () => {
    const actions = buildActions({
      editable: true,
      hasSelection: true,
      canComment: true,
    });

    expect(actions.map((action) => action.id)).toEqual(["copy", "cut", "paste", "add-comment"]);
    expect(actions.map((action) => action.shortcut)).toEqual(["⌘C", "⌘X", "⌘V", "C"]);
    expect(actions.find((action) => action.id === "add-comment")?.separatorBefore).toBe(true);
  });

  it("shows paste only for editable editors without a selection", () => {
    const actions = buildActions({
      editable: true,
      hasSelection: false,
      canComment: true,
    });

    expect(actions.map((action) => action.id)).toEqual(["paste"]);
  });

  it("shows copy only for read-only selections", () => {
    const actions = buildActions({
      editable: false,
      hasSelection: true,
      canComment: true,
    });

    expect(actions.map((action) => action.id)).toEqual(["copy"]);
  });

  it("returns no editor actions for read-only editors without a selection", () => {
    expect(
      buildEditorContextGroups({
        editable: false,
        hasSelection: false,
        canComment: true,
      }),
    ).toEqual([]);
  });

  it("shows change to Markdown for code cells", () => {
    const actions = buildActions({
      editable: true,
      cellType: "code",
      onChangeCellType: vi.fn(),
    });

    expect(actions.map((action) => action.id)).toEqual(["paste", "change-to-markdown"]);
    expect(actions.find((action) => action.id === "change-to-markdown")?.label).toBe(
      "Change to Markdown",
    );
  });

  it("shows change to Code for markdown cells", () => {
    const actions = buildActions({
      editable: true,
      cellType: "markdown",
      onChangeCellType: vi.fn(),
    });

    expect(actions.map((action) => action.id)).toEqual(["paste", "change-to-code"]);
    expect(actions.find((action) => action.id === "change-to-code")?.label).toBe("Change to Code");
  });

  it("shows both code and Markdown targets for raw cells", () => {
    const actions = buildActions({
      editable: true,
      cellType: "raw",
      onChangeCellType: vi.fn(),
    });

    expect(actions.map((action) => action.id)).toEqual([
      "paste",
      "change-to-code",
      "change-to-markdown",
    ]);
    expect(actions.map((action) => action.label)).toEqual([
      "Paste",
      "Change to Code",
      "Change to Markdown",
    ]);
  });
});
