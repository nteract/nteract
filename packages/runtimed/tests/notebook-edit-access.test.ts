import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  clearNotebookEditAccessProjectionCachesForTests,
  notebookRoomAccessLevelFromConnectionScope,
  projectNotebookEditAccess,
  projectNotebookRoomEditAccess,
} from "../src/notebook-edit-access";

beforeEach(() => {
  clearNotebookEditAccessProjectionCachesForTests();
});

describe("projectNotebookEditAccess", () => {
  it("keeps a user-selected view mode read-only even when edit permission exists", () => {
    const interaction = projectNotebookEditAccess({
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

  it("intersects granted permission with host support for active edits", () => {
    const interaction = projectNotebookEditAccess({
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

  it("treats edit as requested when permission or host support is missing", () => {
    expect(
      projectNotebookEditAccess({
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
      }),
    ).toMatchObject({
      activeMode: "view",
      state: "requested",
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
    });

    expect(
      projectNotebookEditAccess({
        selectedMode: "edit",
        permission: {
          canEditMarkdown: true,
          canEditCells: true,
          canEditStructure: true,
        },
        hostSupport: {
          canEditMarkdown: false,
          canEditCells: false,
          canEditStructure: false,
          canRequestEdit: false,
        },
      }),
    ).toMatchObject({
      activeMode: "view",
      state: "requested",
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
    });
  });

  it("returns a stable frozen object for equivalent edit inputs", () => {
    const first = projectNotebookEditAccess({
      selectedMode: "edit",
      permission: {
        canEditMarkdown: true,
        canEditCells: true,
        canEditStructure: true,
      },
      hostSupport: {
        canEditMarkdown: true,
        canEditCells: false,
        canEditStructure: true,
        canRequestEdit: true,
      },
    });
    const second = projectNotebookEditAccess({
      selectedMode: "edit",
      permission: {
        canEditMarkdown: true,
        canEditCells: true,
        canEditStructure: true,
      },
      hostSupport: {
        canEditMarkdown: true,
        canEditCells: false,
        canEditStructure: true,
        canRequestEdit: true,
      },
    });

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe("projectNotebookRoomEditAccess", () => {
  it("maps owner room access to document editing when the host can mutate", () => {
    const projection = projectNotebookRoomEditAccess({
      accessLevel: "owner",
      requestedScope: "owner",
      selectedMode: "edit",
      canAcceptDocumentMutations: true,
      canRequestEdit: false,
    });

    expect(projection).toMatchObject({
      accessLevel: "owner",
      requestedScope: "owner",
      hasDocumentEditPermission: true,
      selectedDocumentEditMode: true,
      requestedDocumentEditAccess: true,
      editAccessPending: false,
      selectedMode: "edit",
      activeMode: "edit",
      state: "editing",
      canEditMarkdown: true,
      canEditCells: true,
      canEditStructure: true,
    });
  });

  it("keeps requested editor access pending while a requested room reconnect is loading", () => {
    const projection = projectNotebookRoomEditAccess({
      accessLevel: "viewer",
      requestedScope: "editor",
      selectedMode: "edit",
      canAcceptDocumentMutations: false,
      canRequestEdit: true,
      editAccessRequestPending: true,
    });

    expect(projection).toMatchObject({
      inputSelectedMode: "edit",
      selectedMode: "view",
      activeMode: "view",
      state: "viewing",
      hasDocumentEditPermission: false,
      requestedDocumentEditAccess: true,
      editAccessPending: true,
      canRequestEdit: true,
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
    });
  });

  it("separates runtime peer scope from document edit access", () => {
    const projection = projectNotebookRoomEditAccess({
      accessLevel: "viewer",
      requestedScope: "runtime_peer",
      selectedMode: "edit",
      canAcceptDocumentMutations: true,
      canRequestEdit: true,
      editAccessRequestPending: true,
    });

    expect(projection).toMatchObject({
      requestedScope: "runtime_peer",
      hasDocumentEditPermission: false,
      requestedDocumentEditAccess: false,
      editAccessPending: false,
      selectedMode: "edit",
      activeMode: "view",
      state: "requested",
    });
  });

  it("requires host mutation support even after document edit access is granted", () => {
    const projection = projectNotebookRoomEditAccess({
      accessLevel: "editor",
      requestedScope: "editor",
      selectedMode: "edit",
      canAcceptDocumentMutations: false,
      canRequestEdit: true,
    });

    expect(projection).toMatchObject({
      hasDocumentEditPermission: true,
      selectedMode: "edit",
      activeMode: "view",
      state: "requested",
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
    });
  });

  it("returns a stable frozen object for equivalent room edit inputs", () => {
    const first = projectNotebookRoomEditAccess({
      accessLevel: "viewer",
      requestedScope: "editor",
      selectedMode: "edit",
      canAcceptDocumentMutations: false,
      canRequestEdit: true,
      editAccessRequestPending: true,
    });
    const second = projectNotebookRoomEditAccess({
      accessLevel: "viewer",
      requestedScope: "editor",
      selectedMode: "edit",
      canAcceptDocumentMutations: false,
      canRequestEdit: true,
      editAccessRequestPending: true,
    });

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe("notebookRoomAccessLevelFromConnectionScope", () => {
  it("maps runtime peers to viewer document access and unknown scopes to the host fallback", () => {
    expect(notebookRoomAccessLevelFromConnectionScope("runtime_peer", "owner")).toBe("viewer");
    expect(notebookRoomAccessLevelFromConnectionScope("editor", "viewer")).toBe("editor");
    expect(notebookRoomAccessLevelFromConnectionScope("unexpected", "none")).toBe("none");
    expect(notebookRoomAccessLevelFromConnectionScope(null, "owner")).toBe("owner");
  });
});
