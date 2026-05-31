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
    expect(capabilities.canEditStructure).toBe(true);
    expect(capabilities.canRequestEdit).toBe(false);
    expect(capabilities.canExecute).toBe(true);
    expect(capabilities.canManagePackages).toBe(true);
    expect(capabilities.canManageSharing).toBe(false);
    expect(capabilities.runtime).toMatchObject({
      canWriteRuntimeState: true,
      connected: true,
      source: "local",
      actorLabel: "local:kyle/desktop:window",
    });
    expect(capabilities.access.actor).toMatchObject({
      principal: {
        label: "Kyle",
        source: { provider: "local", namespace: "kyle" },
      },
      operator: { kind: "desktop" },
      scope: "owner",
    });
    expect(capabilities.runtime.actor).toMatchObject({
      principal: { label: "Kyle" },
      operator: { kind: "desktop" },
      scope: "runtime_peer",
    });
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
    expect(capabilities.canEditStructure).toBe(false);
    expect(capabilities.canRequestEdit).toBe(false);
    expect(capabilities.canExecute).toBe(false);
    expect(capabilities.canManagePackages).toBe(false);
    expect(capabilities.runtime).toMatchObject({
      canWriteRuntimeState: false,
      connected: false,
      source: "cloud",
      actorLabel: null,
    });
    expect(capabilities.access.actor).toMatchObject({
      principal: {
        label: "Alice",
        source: { provider: "anaconda", namespace: "anaconda" },
      },
      operator: { kind: "desktop" },
      scope: "viewer",
    });
    expect(capabilities.runtime.actor).toBeNull();
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
    expect(capabilities.canEditStructure).toBe(false);
    expect(capabilities.canExecute).toBe(false);
    expect(capabilities.runtime.canWriteRuntimeState).toBe(false);
  });

  it("keeps runtime peer authority separate from document editing access", () => {
    const capabilities = desktopNotebookShellCapabilities({
      canAcceptCellMutations: false,
      sessionReady: true,
      localActor: "user:anaconda:alice/runtime:jupyterhub",
      connectionScope: "runtime_peer",
    });

    expect(capabilities.access.level).toBe("viewer");
    expect(capabilities.canEditMarkdown).toBe(false);
    expect(capabilities.canEditCells).toBe(false);
    expect(capabilities.canEditStructure).toBe(false);
    expect(capabilities.canManageSharing).toBe(false);
    expect(capabilities.runtime).toMatchObject({
      canWriteRuntimeState: true,
      connected: true,
      source: "cloud",
      actorLabel: "user:anaconda:alice/runtime:jupyterhub",
    });
    expect(capabilities.runtime.actor).toMatchObject({
      principal: { label: "Alice" },
      operator: { kind: "runtime", label: "JupyterHub" },
      scope: "runtime_peer",
    });
  });
});
