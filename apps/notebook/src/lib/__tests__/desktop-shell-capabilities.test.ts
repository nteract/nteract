import { describe, expect, it } from "vite-plus/test";
import { desktopNotebookShellCapabilities } from "../desktop-shell-capabilities";

describe("desktopNotebookShellCapabilities", () => {
  it("exposes runtime execution availability from the daemon session", () => {
    const ready = desktopNotebookShellCapabilities({
      canAcceptCellMutations: true,
      sessionReady: true,
      localActor: "local:kyle/desktop:window",
      connectionScope: null,
    });
    expect(ready.runtime.executionAvailable).toBe(true);
    expect(ready.canExecute).toBe(true);

    const notReady = desktopNotebookShellCapabilities({
      canAcceptCellMutations: true,
      sessionReady: false,
      localActor: "local:kyle/desktop:window",
      connectionScope: null,
    });
    expect(notReady.runtime.executionAvailable).toBe(false);
    expect(notReady.canExecute).toBe(false);

    // A ready runtime is available even when the document is not writable, but
    // execution still requires write authority.
    const readyReadOnly = desktopNotebookShellCapabilities({
      canAcceptCellMutations: false,
      sessionReady: true,
      localActor: "local:kyle/desktop:window",
      connectionScope: null,
    });
    expect(readyReadOnly.runtime.executionAvailable).toBe(true);
    expect(readyReadOnly.canExecute).toBe(false);
  });

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
    expect(capabilities.auth.canUseAuthenticatedIdentity).toBe(false);
    expect(capabilities.interaction).toMatchObject({
      selectedMode: "edit",
      activeMode: "edit",
      state: "editing",
      canEditMarkdown: true,
      canEditCells: true,
      canEditStructure: true,
      canRequestEdit: false,
    });
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
    expect(capabilities.auth.canUseAuthenticatedIdentity).toBe(true);
    expect(capabilities.interaction).toMatchObject({
      selectedMode: "view",
      activeMode: "view",
      state: "viewing",
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
    });
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
    expect(capabilities.interaction).toMatchObject({
      selectedMode: "edit",
      activeMode: "view",
      state: "requested",
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
    });
  });

  it("maps local read-only files to viewer access without cloud source", () => {
    const capabilities = desktopNotebookShellCapabilities({
      canAcceptCellMutations: false,
      sessionReady: true,
      localActor: "local:kyle/desktop:window",
      connectionScope: "viewer",
    });

    expect(capabilities.access).toMatchObject({
      level: "viewer",
      source: "local",
      actorLabel: "local:kyle/desktop:window",
    });
    expect(capabilities.canRead).toBe(true);
    expect(capabilities.canEditMarkdown).toBe(false);
    expect(capabilities.canEditCells).toBe(false);
    expect(capabilities.canEditStructure).toBe(false);
    expect(capabilities.canExecute).toBe(false);
    expect(capabilities.canManagePackages).toBe(false);
    expect(capabilities.runtime).toMatchObject({
      canWriteRuntimeState: false,
      connected: true,
      source: "local",
      actorLabel: null,
    });
    expect(capabilities.interaction).toMatchObject({
      selectedMode: "view",
      activeMode: "view",
      state: "viewing",
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
    });
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
    expect(capabilities.interaction).toMatchObject({
      selectedMode: "view",
      activeMode: "view",
      state: "viewing",
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
    });
  });

  it("projects desktop agent actors without treating desktop as a single human", () => {
    const capabilities = desktopNotebookShellCapabilities({
      canAcceptCellMutations: true,
      sessionReady: true,
      localActor: "user:anaconda:kyle%40example.com/agent:codex:s1",
      connectionScope: "editor",
    });

    expect(capabilities.access.level).toBe("editor");
    expect(capabilities.canEditMarkdown).toBe(true);
    expect(capabilities.interaction).toMatchObject({
      selectedMode: "edit",
      activeMode: "edit",
      state: "editing",
    });
    expect(capabilities.access.actor).toMatchObject({
      actorLabel: "user:anaconda:kyle%40example.com/agent:codex:s1",
      principal: {
        label: "kyle@example.com",
        source: { provider: "anaconda", namespace: "anaconda" },
      },
      operator: { kind: "agent", label: "Codex" },
      scope: "editor",
    });
  });
});
