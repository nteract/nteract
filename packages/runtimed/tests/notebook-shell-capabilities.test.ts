import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  projectNotebookRoomEditAccess,
  projectNotebookRuntimeTargetFromWorkstationAttachment,
  projectNotebookShellCapabilities,
  readOnlyNotebookShellCapabilities,
  resolveNotebookShellRuntimeTarget,
  stabilizeNotebookShellCapabilities,
  type NotebookShellAccessCapabilities,
  type NotebookShellAuthCapabilities,
  type NotebookShellRuntimeCapabilities,
  type WorkstationAttachmentState,
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
      runtime: {
        connected: false,
        executionAvailable: false,
        target: {
          id: "runtime:none",
          kind: "unknown",
          status: "offline",
          label: "No runtime target",
        },
      },
    });
    expect(Object.isFrozen(readOnlyNotebookShellCapabilities)).toBe(true);
    expect(Object.isFrozen(readOnlyNotebookShellCapabilities.access)).toBe(true);
    expect(Object.isFrozen(readOnlyNotebookShellCapabilities.auth)).toBe(true);
    expect(Object.isFrozen(readOnlyNotebookShellCapabilities.runtime)).toBe(true);
    expect(Object.isFrozen(readOnlyNotebookShellCapabilities.runtime.target)).toBe(true);
  });

  it("projects missing runtime targets into stable defaults before React consumes them", () => {
    const interaction = projectNotebookRoomEditAccess({
      accessLevel: "viewer",
      requestedScope: "viewer",
      selectedMode: "view",
      canAcceptDocumentMutations: true,
      canRequestEdit: false,
    });

    const first = projectNotebookShellCapabilities({
      interaction,
      access: access({ source: "cloud" }),
      runtime: runtime({ source: "cloud", connected: false, executionAvailable: false }),
    });
    const second = projectNotebookShellCapabilities({
      interaction,
      access: access({ source: "cloud" }),
      runtime: runtime({ source: "cloud", connected: false, executionAvailable: false }),
    });

    expect(first).toBe(second);
    expect(first.runtime).toBe(second.runtime);
    expect(first.runtime.target).toBe(second.runtime.target);
    expect(first.runtime.target).toMatchObject({
      id: "workstation:none",
      kind: "cloud_workstation",
      status: "offline",
      label: "No compute session",
      defaultEnvironmentLabel: "Not running",
    });
    expect(resolveNotebookShellRuntimeTarget(first.runtime)).toBe(first.runtime.target);

    const stabilized = stabilizeNotebookShellCapabilities({
      ...first,
      runtime: { ...first.runtime, target: null },
    });
    expect(stabilized).toBe(first);
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
          id: "attached-workstation",
          kind: "cloud_workstation",
          status: "ready",
          label: "Connected workstation",
          statusLabel: "Ready",
          detail: "A compute session is connected to this notebook.",
          providerLabel: "Cloud room",
          defaultEnvironmentLabel: "Current Python",
          environmentLabel: "Current Python",
          kernelStatusLabel: "idle",
          cpuCount: 4,
          memoryBytes: 16 * 1024 ** 3,
          resourceLabel: "4 CPU / 16 GB RAM",
          runtimePeerCount: 2,
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
          id: "attached-workstation",
          kind: "cloud_workstation",
          status: "ready",
          label: "Connected workstation",
          statusLabel: "Ready",
          detail: "A compute session is connected to this notebook.",
          providerLabel: "Cloud room",
          defaultEnvironmentLabel: "Current Python",
          environmentLabel: "Current Python",
          kernelStatusLabel: "idle",
          cpuCount: 4,
          memoryBytes: 16 * 1024 ** 3,
          resourceLabel: "4 CPU / 16 GB RAM",
          runtimePeerCount: 2,
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
      id: "attached-workstation",
      defaultEnvironmentLabel: "Current Python",
      kernelStatusLabel: "idle",
      cpuCount: 4,
      memoryBytes: 16 * 1024 ** 3,
      resourceLabel: "4 CPU / 16 GB RAM",
      runtimePeerCount: 2,
      workingDirectoryLabel: "/home/kyle/notebooks",
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.access)).toBe(true);
    expect(Object.isFrozen(first.auth)).toBe(true);
    expect(Object.isFrozen(first.runtime)).toBe(true);
    expect(Object.isFrozen(first.runtime.target)).toBe(true);
  });

  it("preserves runtime session replacements in stabilized runtime targets", () => {
    const interaction = projectNotebookRoomEditAccess({
      accessLevel: "owner",
      requestedScope: "editor",
      selectedMode: "edit",
      canAcceptDocumentMutations: true,
      canRequestEdit: true,
    });
    const first = projectNotebookShellCapabilities({
      interaction,
      access: access({ level: "owner", source: "cloud" }),
      runtime: runtime({
        connected: true,
        executionAvailable: true,
        target: {
          id: "attached-workstation",
          runtimeSessionId: "job-123",
          kind: "cloud_workstation",
          status: "ready",
          label: "Connected workstation",
        },
      }),
    });
    const second = projectNotebookShellCapabilities({
      interaction,
      access: access({ level: "owner", source: "cloud" }),
      runtime: runtime({
        connected: true,
        executionAvailable: true,
        target: {
          id: "attached-workstation",
          runtimeSessionId: "job-456",
          kind: "cloud_workstation",
          status: "ready",
          label: "Connected workstation",
        },
      }),
    });

    expect(first.runtime.target).not.toBe(second.runtime.target);
    expect(first.runtime.target?.runtimeSessionId).toBe("job-123");
    expect(second.runtime.target?.runtimeSessionId).toBe("job-456");
  });
});

describe("projectNotebookRuntimeTargetFromWorkstationAttachment", () => {
  function attachment(
    overrides: Partial<WorkstationAttachmentState> = {},
  ): WorkstationAttachmentState {
    return {
      workstation_id: "ws-lab2",
      display_name: "Lab 2",
      provider: "local_daemon",
      default_environment_label: "Current Python",
      environment_policy: "current_python",
      status: "ready",
      status_message: null,
      cpu_count: 8,
      memory_bytes: 32 * 1024 ** 3,
      working_directory: "/home/ubuntu/notebooks",
      updated_at: "2026-06-07T21:00:00Z",
      runtime_session_id: "job-123",
      ...overrides,
    };
  }

  it("projects a RuntimeStateDoc workstation attachment into a shell target", () => {
    const target = projectNotebookRuntimeTargetFromWorkstationAttachment(attachment(), {
      runtimePeerCount: 1,
    });

    expect(target).toMatchObject({
      id: "ws-lab2",
      kind: "cloud_workstation",
      status: "ready",
      label: "Lab 2",
      statusLabel: "Ready",
      providerLabel: "Local daemon",
      defaultEnvironmentLabel: "Current Python",
      environmentLabel: "Current Python",
      runtimeSessionId: "job-123",
      cpuCount: 8,
      memoryBytes: 32 * 1024 ** 3,
      runtimePeerCount: 1,
      workingDirectoryLabel: "/home/ubuntu/notebooks",
    });
  });

  it("uses runtime session id in target projection identity", () => {
    const first = projectNotebookRuntimeTargetFromWorkstationAttachment(
      attachment({ runtime_session_id: "job-123" }),
    );
    const second = projectNotebookRuntimeTargetFromWorkstationAttachment(
      attachment({ runtime_session_id: "job-456" }),
    );

    expect(first).not.toBe(second);
    expect(first?.runtimeSessionId).toBe("job-123");
    expect(second?.runtimeSessionId).toBe("job-456");
  });

  it("keeps connecting attachments connected but not executable", () => {
    const target = projectNotebookRuntimeTargetFromWorkstationAttachment(
      attachment({
        status: "connecting",
        status_message: "Waiting for runtime peer heartbeat",
      }),
    );

    expect(target).toMatchObject({
      status: "connecting",
      statusLabel: "Connecting",
      detail: "Waiting for runtime peer heartbeat",
    });
  });

  it("can project stale ready hosted attachments as needing attention", () => {
    const target = projectNotebookRuntimeTargetFromWorkstationAttachment(
      attachment({
        status_message: "stale ready status message",
      }),
      {
        requireRuntimePeer: true,
        runtimePeerCount: 0,
      },
    );

    expect(target).toMatchObject({
      id: "ws-lab2",
      status: "attention",
      statusLabel: "Needs attention",
      detail: "Room link lost: no compute session is currently attached to the room.",
      runtimePeerCount: null,
      roomLink: {
        status: "lost",
        statusLabel: "Lost",
        lastSeenAt: null,
      },
    });
  });

  it("carries room-link last-seen state for stale hosted attachments", () => {
    const target = projectNotebookRuntimeTargetFromWorkstationAttachment(attachment(), {
      requireRuntimePeer: true,
      runtimePeerCount: 0,
      runtimeLastSeenAt: "2026-06-07T21:02:00Z",
    });

    expect(target).toMatchObject({
      status: "attention",
      roomLink: {
        status: "lost",
        statusLabel: "Lost",
        lastSeenAt: "2026-06-07T21:02:00Z",
      },
    });
  });
});
