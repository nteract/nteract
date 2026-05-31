import { describe, expect, it } from "vite-plus/test";
import { desktopNotebookShellCapabilities } from "../desktop-shell-capabilities";

describe("desktopNotebookShellCapabilities", () => {
  it("maps local notebooks to owner-level writable shell access", () => {
    const capabilities = desktopNotebookShellCapabilities({
      canAcceptCellMutations: true,
      sessionReady: true,
      localActor: "local:kyle/desktop:window",
      connectionScope: null,
    });

    expect(capabilities.access).toMatchObject({
      level: "owner",
      source: "local",
      actorLabel: "local:kyle/desktop:window",
    });
    expect(capabilities.canEditCells).toBe(true);
    expect(capabilities.canRequestEdit).toBe(false);
    expect(capabilities.canExecute).toBe(true);
    expect(capabilities.canManagePackages).toBe(true);
    expect(capabilities.canManageSharing).toBe(false);
  });

  it("maps cloud viewer scope in desktop to read-only shell access", () => {
    const capabilities = desktopNotebookShellCapabilities({
      canAcceptCellMutations: true,
      sessionReady: true,
      localActor: "user:anaconda:alice/desktop:window",
      connectionScope: "viewer",
    });

    expect(capabilities.access).toMatchObject({
      level: "viewer",
      source: "cloud",
      actorLabel: "user:anaconda:alice/desktop:window",
    });
    expect(capabilities.canRead).toBe(true);
    expect(capabilities.canEditCells).toBe(false);
    expect(capabilities.canRequestEdit).toBe(false);
    expect(capabilities.canExecute).toBe(false);
    expect(capabilities.canManagePackages).toBe(false);
  });

  it("keeps desktop editing disabled until local Automerge mutations are accepted", () => {
    const capabilities = desktopNotebookShellCapabilities({
      canAcceptCellMutations: false,
      sessionReady: true,
      localActor: "local:kyle/desktop:window",
      connectionScope: null,
    });

    expect(capabilities.access.level).toBe("owner");
    expect(capabilities.canEditCells).toBe(false);
    expect(capabilities.canExecute).toBe(false);
  });
});
