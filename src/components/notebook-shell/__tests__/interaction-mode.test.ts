import { describe, expect, it } from "vite-plus/test";
import {
  createNotebookInteractionModeProjection,
  notebookInteractionPresenceLabel,
} from "../interaction-mode";

describe("createNotebookInteractionModeProjection", () => {
  it("keeps a user-selected view mode read-only even when edit permission exists", () => {
    const interaction = createNotebookInteractionModeProjection({
      selectedMode: "view",
      permission: {
        canEditMarkdown: true,
        canEditCells: true,
        canEditStructure: true,
      },
      hostSupport: {
        canEditMarkdown: true,
        canEditCells: true,
        canEditStructure: true,
        canRequestEdit: true,
      },
    });

    expect(interaction).toMatchObject({
      selectedMode: "view",
      activeMode: "view",
      state: "viewing",
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
    });
  });

  it("treats edit as requested when permission has not been granted", () => {
    const interaction = createNotebookInteractionModeProjection({
      selectedMode: "edit",
      permission: {
        canEditMarkdown: false,
        canEditCells: false,
        canEditStructure: false,
      },
      hostSupport: {
        canEditMarkdown: true,
        canEditCells: true,
        canEditStructure: true,
        canRequestEdit: true,
      },
    });

    expect(interaction).toMatchObject({
      selectedMode: "edit",
      activeMode: "view",
      state: "requested",
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
    });
  });

  it("intersects granted permission with host support for active edits", () => {
    const interaction = createNotebookInteractionModeProjection({
      selectedMode: "edit",
      permission: {
        canEditMarkdown: true,
        canEditCells: true,
        canEditStructure: true,
      },
      hostSupport: {
        canEditMarkdown: true,
        canEditCells: false,
        canEditStructure: false,
        canRequestEdit: false,
      },
    });

    expect(interaction).toMatchObject({
      selectedMode: "edit",
      activeMode: "edit",
      state: "editing",
      canRequestEdit: false,
      canEditMarkdown: true,
      canEditCells: false,
      canEditStructure: false,
    });
  });

  it("uses selected mode, permission, and host support for shared presence copy", () => {
    const editableView = createNotebookInteractionModeProjection({
      selectedMode: "view",
      permission: {
        canEditMarkdown: true,
        canEditCells: true,
        canEditStructure: false,
      },
      hostSupport: {
        canEditMarkdown: true,
        canEditCells: true,
        canEditStructure: false,
        canRequestEdit: true,
      },
    });
    const activeEdit = createNotebookInteractionModeProjection({
      selectedMode: "edit",
      permission: {
        canEditMarkdown: true,
        canEditCells: true,
        canEditStructure: false,
      },
      hostSupport: {
        canEditMarkdown: true,
        canEditCells: true,
        canEditStructure: false,
        canRequestEdit: true,
      },
    });
    const requestedEdit = createNotebookInteractionModeProjection({
      selectedMode: "edit",
      permission: {
        canEditMarkdown: false,
        canEditCells: false,
        canEditStructure: false,
      },
      hostSupport: {
        canEditMarkdown: true,
        canEditCells: true,
        canEditStructure: true,
        canRequestEdit: true,
      },
    });
    const readOnlyView = createNotebookInteractionModeProjection({
      selectedMode: "view",
      permission: {
        canEditMarkdown: false,
        canEditCells: false,
        canEditStructure: false,
      },
      hostSupport: {
        canEditMarkdown: true,
        canEditCells: true,
        canEditStructure: true,
        canRequestEdit: false,
      },
    });

    expect(notebookInteractionPresenceLabel(editableView)).toBe("viewing");
    expect(notebookInteractionPresenceLabel(activeEdit)).toBe("editing");
    expect(notebookInteractionPresenceLabel(requestedEdit)).toBe("waiting for edit access");
    expect(notebookInteractionPresenceLabel(readOnlyView)).toBe("view only");
    expect(notebookInteractionPresenceLabel(null)).toBeNull();
  });
});
