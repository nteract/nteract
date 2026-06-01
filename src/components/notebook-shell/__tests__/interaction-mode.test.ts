import { describe, expect, it } from "vite-plus/test";
import { createNotebookInteractionModeProjection } from "../interaction-mode";

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
});
