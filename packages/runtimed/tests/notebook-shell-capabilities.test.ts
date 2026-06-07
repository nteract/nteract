import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  projectNotebookRoomEditAccess,
  projectNotebookShellCapabilities,
  readOnlyNotebookShellCapabilities,
  type NotebookShellAccessCapabilities,
  type NotebookShellAuthCapabilities,
  type NotebookShellRuntimeCapabilities,
} from "../src";
import { clearNotebookShellCapabilitiesCachesForTests } from "../src/notebook-shell-capabilities";

beforeEach(() => {
  clearNotebookShellCapabilitiesCachesForTests();
});

function access(
  overrides: Partial<NotebookShellAccessCapabilities> = {},
): NotebookShellAccessCapabilities {
  return {
    level: "viewer",
    source: "cloud",
    isPublic: false,
    actorLabel: null,
    identityLabel: null,
    ...overrides,
  };
}

function auth(
  overrides: Partial<NotebookShellAuthCapabilities> = {},
): NotebookShellAuthCapabilities {
  return {
    canSignIn: false,
    canUseAuthenticatedIdentity: false,
    needsAttention: false,
    ...overrides,
  };
}

function runtime(
  overrides: Partial<NotebookShellRuntimeCapabilities> = {},
): NotebookShellRuntimeCapabilities {
  return {
    canWriteRuntimeState: false,
    connected: false,
    executionAvailable: false,
    source: "cloud",
    actorLabel: null,
    identityLabel: null,
    ...overrides,
  };
}

describe("projectNotebookShellCapabilities", () => {
  it("projects read-only viewer access into shell capabilities", () => {
    const interaction = projectNotebookRoomEditAccess({
      accessLevel: "viewer",
      requestedScope: "viewer",
      selectedMode: "view",
      canAcceptDocumentMutations: true,
      canRequestEdit: false,
    });

    expect(
      projectNotebookShellCapabilities({
        interaction,
        access: access(),
        controls: { canToggleCode: true },
        execution: { available: true, requiresDocumentEditPermission: true },
        packages: { canView: true, canManage: true, manageRequiresDocumentMutationSupport: true },
        sharing: { canManage: true, requiresAuthenticatedIdentity: true },
      }),
    ).toMatchObject({
      canRead: true,
      canEditMarkdown: false,
      canEditCells: false,
      canEditStructure: false,
      canExecute: false,
      canToggleCode: true,
      canViewPackages: true,
      canManagePackages: false,
      canManageSharing: false,
      access: { level: "viewer", source: "cloud" },
      runtime: { executionAvailable: true },
    });
  });

  it("can require full document mutation support for execution and package management", () => {
    const interaction = projectNotebookRoomEditAccess({
      accessLevel: "owner",
      requestedScope: "owner",
      selectedMode: "edit",
      canAcceptDocumentMutations: false,
      canRequestEdit: false,
    });

    const capabilities = projectNotebookShellCapabilities({
      interaction,
      access: access({ level: "owner", source: "local" }),
      runtime: runtime({ source: "local", connected: true, executionAvailable: true }),
      execution: {
        available: true,
        requiresDocumentEditPermission: true,
        requiresDocumentMutationSupport: true,
      },
      packages: {
        canView: true,
        canManage: true,
        manageRequiresDocumentMutationSupport: true,
      },
    });

    expect(capabilities.access.level).toBe("owner");
    expect(capabilities.interaction?.state).toBe("requested");
    expect(capabilities.canExecute).toBe(false);
    expect(capabilities.canManagePackages).toBe(false);
  });

  it("allows attached cloud runtimes to execute from document edit permission without active edit mode", () => {
    const interaction = projectNotebookRoomEditAccess({
      accessLevel: "editor",
      requestedScope: "editor",
      selectedMode: "view",
      canAcceptDocumentMutations: true,
      canRequestEdit: true,
    });

    const capabilities = projectNotebookShellCapabilities({
      interaction,
      access: access({ level: "editor" }),
      runtime: runtime({ executionAvailable: true }),
      execution: {
        available: true,
        requiresDocumentEditPermission: true,
      },
    });

    expect(capabilities.canEditCells).toBe(false);
    expect(capabilities.canExecute).toBe(true);
  });

  it("keeps runtime availability visible when execution submission is not allowed", () => {
    const interaction = projectNotebookRoomEditAccess({
      accessLevel: "editor",
      requestedScope: "editor",
      selectedMode: "edit",
      canAcceptDocumentMutations: true,
      canRequestEdit: true,
    });

    const capabilities = projectNotebookShellCapabilities({
      interaction,
      access: access({ level: "editor" }),
      runtime: runtime({ connected: true, executionAvailable: true }),
      execution: {
        available: true,
        canSubmit: false,
        requiresDocumentEditPermission: true,
      },
    });

    expect(capabilities.runtime.connected).toBe(true);
    expect(capabilities.runtime.executionAvailable).toBe(true);
    expect(capabilities.canExecute).toBe(false);
  });

  it("applies sharing requirements for authenticated cloud hosts", () => {
    const interaction = projectNotebookRoomEditAccess({
      accessLevel: "owner",
      requestedScope: "owner",
      selectedMode: "edit",
      canAcceptDocumentMutations: true,
      canRequestEdit: true,
    });

    const capabilities = projectNotebookShellCapabilities({
      interaction,
      access: access({ level: "owner", source: "cloud" }),
      auth: auth({ canUseAuthenticatedIdentity: true }),
      sharing: {
        canManage: true,
        requiresAuthenticatedIdentity: true,
        requiredAccessLevels: ["owner"],
        requiredSources: ["cloud"],
      },
    });

    expect(capabilities.canManageSharing).toBe(true);

    expect(
      projectNotebookShellCapabilities({
        interaction,
        access: access({ level: "owner", source: "local" }),
        auth: auth({ canUseAuthenticatedIdentity: true }),
        sharing: {
          canManage: true,
          requiresAuthenticatedIdentity: true,
          requiredAccessLevels: ["owner"],
          requiredSources: ["cloud"],
        },
      }).canManageSharing,
    ).toBe(false);
  });

  it("exports the default read-only capability projection from runtimed", () => {
    expect(readOnlyNotebookShellCapabilities).toMatchObject({
      canRead: true,
      canExecute: false,
      canManagePackages: false,
      access: { level: "viewer", source: "unknown" },
      runtime: { connected: false, executionAvailable: false, target: null },
    });
    expect(Object.isFrozen(readOnlyNotebookShellCapabilities)).toBe(true);
    expect(Object.isFrozen(readOnlyNotebookShellCapabilities.access)).toBe(true);
    expect(Object.isFrozen(readOnlyNotebookShellCapabilities.auth)).toBe(true);
    expect(Object.isFrozen(readOnlyNotebookShellCapabilities.runtime)).toBe(true);
  });

  it("returns stable frozen capabilities for equivalent shell inputs", () => {
    const interaction = projectNotebookRoomEditAccess({
      accessLevel: "editor",
      requestedScope: "editor",
      selectedMode: "edit",
      canAcceptDocumentMutations: true,
      canRequestEdit: true,
    });
    const first = projectNotebookShellCapabilities({
      interaction,
      access: access({ level: "editor", actorLabel: "user:anaconda:alice/browser:viewer" }),
      auth: auth({ canUseAuthenticatedIdentity: true }),
      runtime: runtime({
        connected: true,
        executionAvailable: true,
        target: {
          id: "room-workstation",
          kind: "cloud_workstation",
          status: "ready",
          label: "Room workstation",
          statusLabel: "Ready",
          detail: "A runtime peer is attached to this room.",
          providerLabel: "Cloud room",
          defaultEnvironmentLabel: "Current Python",
          environmentLabel: "Current Python",
          cpuCount: 4,
          memoryBytes: 16 * 1024 ** 3,
          resourceLabel: "4 CPU / 16 GB RAM",
          workingDirectoryLabel: "/home/kyle/notebooks",
        },
      }),
      execution: { available: true, requiresDocumentEditPermission: true },
      packages: { canView: true, canManage: true, manageRequiresDocumentMutationSupport: true },
      sharing: {
        canManage: true,
        requiresAuthenticatedIdentity: true,
        requiredAccessLevels: ["editor", "owner"],
        requiredSources: ["cloud"],
      },
    });
    const second = projectNotebookShellCapabilities({
      interaction,
      access: access({ level: "editor", actorLabel: "user:anaconda:alice/browser:viewer" }),
      auth: auth({ canUseAuthenticatedIdentity: true }),
      runtime: runtime({
        connected: true,
        executionAvailable: true,
        target: {
          id: "room-workstation",
          kind: "cloud_workstation",
          status: "ready",
          label: "Room workstation",
          statusLabel: "Ready",
          detail: "A runtime peer is attached to this room.",
          providerLabel: "Cloud room",
          defaultEnvironmentLabel: "Current Python",
          environmentLabel: "Current Python",
          cpuCount: 4,
          memoryBytes: 16 * 1024 ** 3,
          resourceLabel: "4 CPU / 16 GB RAM",
          workingDirectoryLabel: "/home/kyle/notebooks",
        },
      }),
      execution: { available: true, requiresDocumentEditPermission: true },
      packages: { canView: true, canManage: true, manageRequiresDocumentMutationSupport: true },
      sharing: {
        canManage: true,
        requiresAuthenticatedIdentity: true,
        requiredAccessLevels: ["editor", "owner"],
        requiredSources: ["cloud"],
      },
    });

    expect(first).toBe(second);
    expect(first.access).toBe(second.access);
    expect(first.auth).toBe(second.auth);
    expect(first.runtime).toBe(second.runtime);
    expect(first.runtime.target).toBe(second.runtime.target);
    expect(first.runtime.target).toMatchObject({
      id: "room-workstation",
      defaultEnvironmentLabel: "Current Python",
      cpuCount: 4,
      memoryBytes: 16 * 1024 ** 3,
      resourceLabel: "4 CPU / 16 GB RAM",
      workingDirectoryLabel: "/home/kyle/notebooks",
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.access)).toBe(true);
    expect(Object.isFrozen(first.auth)).toBe(true);
    expect(Object.isFrozen(first.runtime)).toBe(true);
    expect(Object.isFrozen(first.runtime.target)).toBe(true);
  });
});
