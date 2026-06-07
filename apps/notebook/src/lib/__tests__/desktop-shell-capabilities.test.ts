import { describe, expect, it } from "vite-plus/test";
import { desktopNotebookShellCapabilities } from "../desktop-shell-capabilities";
import { RUNTIME_STATUS } from "../kernel-status";

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
      actorLabel: "local:kyle/runtime:local",
      target: {
        id: "local-daemon",
        kind: "local_daemon",
        status: "ready",
        label: "This machine",
        statusLabel: "Ready",
        providerLabel: "Local daemon",
        defaultEnvironmentLabel: "Notebook runtime",
      },
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
      operator: { kind: "runtime", label: "Local" },
      scope: "runtime_peer",
    });
  });

  it("projects daemon kernel status into the local workstation target", () => {
    const capabilities = desktopNotebookShellCapabilities({
      canAcceptCellMutations: true,
      sessionReady: true,
      localActor: "local:kyle/desktop:window",
      connectionScope: null,
      kernelStatusKey: RUNTIME_STATUS.RUNNING_IDLE,
    });

    expect(capabilities.runtime.target).toMatchObject({
      id: "local-daemon",
      kernelStatusLabel: "idle",
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
      target: {
        id: "local-daemon",
        kind: "local_daemon",
        status: "ready",
        label: "This machine",
      },
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

  it("maps unknown non-null connection scopes to no document access", () => {
    const capabilities = desktopNotebookShellCapabilities({
      canAcceptCellMutations: true,
      sessionReady: true,
      localActor: "user:anaconda:alice/desktop:window",
      connectionScope: "surprise",
    });

    expect(capabilities.access).toMatchObject({
      level: "none",
      source: "cloud",
      actorLabel: "user:anaconda:alice/desktop:window",
    });
    expect(capabilities.canRead).toBe(false);
    expect(capabilities.canEditMarkdown).toBe(false);
    expect(capabilities.canEditCells).toBe(false);
    expect(capabilities.canEditStructure).toBe(false);
    expect(capabilities.canExecute).toBe(false);
    expect(capabilities.canManagePackages).toBe(false);
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
      target: {
        id: "runtime-peer",
        kind: "runtime_peer",
        status: "attached",
        label: "Runtime peer",
        providerLabel: "Cloud room",
        defaultEnvironmentLabel: "Runtime peer",
      },
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

  it("requires a host room sharing capability before cloud owners can manage sharing", () => {
    const ownerWithoutSharingHost = desktopNotebookShellCapabilities({
      canAcceptCellMutations: true,
      sessionReady: true,
      localActor: "user:anaconda:alice/desktop:window",
      connectionScope: "owner",
    });
    expect(ownerWithoutSharingHost.canManageSharing).toBe(false);

    const ownerWithSharingHost = desktopNotebookShellCapabilities({
      canAcceptCellMutations: true,
      sessionReady: true,
      localActor: "user:anaconda:alice/desktop:window",
      connectionScope: "owner",
      hostCapabilities: { canManageSharing: true },
    });
    expect(ownerWithSharingHost.canManageSharing).toBe(true);

    const localWithSharingHost = desktopNotebookShellCapabilities({
      canAcceptCellMutations: true,
      sessionReady: true,
      localActor: "local:kyle/desktop:window",
      connectionScope: null,
      hostCapabilities: { canManageSharing: true },
    });
    expect(localWithSharingHost.canManageSharing).toBe(false);
  });

  it("returns stable frozen capabilities for equivalent desktop inputs", () => {
    const input = {
      canAcceptCellMutations: true,
      sessionReady: true,
      localActor: "user:anaconda:alice/desktop:window",
      connectionScope: "owner",
      hostCapabilities: { canManageSharing: true },
    };
    const first = desktopNotebookShellCapabilities(input);
    const second = desktopNotebookShellCapabilities({
      canAcceptCellMutations: true,
      sessionReady: true,
      localActor: "user:anaconda:alice/desktop:window",
      connectionScope: "owner",
      hostCapabilities: { canManageSharing: true },
    });

    expect(first).toBe(second);
    expect(first.access).toBe(second.access);
    expect(first.auth).toBe(second.auth);
    expect(first.runtime).toBe(second.runtime);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.access)).toBe(true);
    expect(Object.isFrozen(first.runtime)).toBe(true);
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
