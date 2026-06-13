import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  clearNotebookWorkstationPanelProjectionCacheForTests,
  projectNotebookRoomEditAccess,
  projectNotebookShellCapabilities,
  projectNotebookWorkstationPanel,
  type NotebookShellAccessCapabilities,
  type NotebookShellAuthCapabilities,
  type NotebookShellRuntimeCapabilities,
} from "../src";
import { clearNotebookShellCapabilitiesCachesForTests } from "../src/notebook-shell-capabilities";

beforeEach(() => {
  clearNotebookShellCapabilitiesCachesForTests();
  clearNotebookWorkstationPanelProjectionCacheForTests();
});

function access(
  overrides: Partial<NotebookShellAccessCapabilities> = {},
): NotebookShellAccessCapabilities {
  return {
    level: "owner",
    source: "local",
    isPublic: false,
    actorLabel: "local:kyle/desktop:main",
    identityLabel: "Kyle",
    ...overrides,
  };
}

function runtime(
  overrides: Partial<NotebookShellRuntimeCapabilities> = {},
): NotebookShellRuntimeCapabilities {
  return {
    canWriteRuntimeState: true,
    connected: true,
    executionAvailable: true,
    source: "local",
    actorLabel: "local:kyle/runtime:local",
    identityLabel: "Kyle",
    target: {
      id: "local-daemon",
      kind: "local_daemon",
      status: "ready",
      label: "This machine",
      statusLabel: "Ready",
      providerLabel: "Local daemon",
      defaultEnvironmentLabel: "Notebook runtime",
      kernelStatusLabel: "idle",
      cpuCount: 8,
      memoryBytes: 16 * 1024 ** 3,
      workingDirectoryLabel: "~/notebooks",
    },
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

function capabilities({
  accessOverrides,
  authOverrides,
  runtimeOverrides,
}: {
  accessOverrides?: Partial<NotebookShellAccessCapabilities>;
  authOverrides?: Partial<NotebookShellAuthCapabilities>;
  runtimeOverrides?: Partial<NotebookShellRuntimeCapabilities>;
} = {}) {
  return projectNotebookShellCapabilities({
    interaction: projectNotebookRoomEditAccess({
      accessLevel: accessOverrides?.level ?? "owner",
      requestedScope: accessOverrides?.level ?? "owner",
      selectedMode: "edit",
      canAcceptDocumentMutations: true,
      canRequestEdit: false,
    }),
    access: access(accessOverrides),
    auth: auth(authOverrides),
    runtime: runtime(runtimeOverrides),
    execution: {
      available: runtimeOverrides?.executionAvailable ?? true,
      requiresDocumentEditPermission: true,
      requiresDocumentMutationSupport: true,
    },
    packages: { canView: true, canManage: true },
  });
}

describe("projectNotebookWorkstationPanel", () => {
  it("projects local workstation resources into a stable panel view model", () => {
    const first = projectNotebookWorkstationPanel(capabilities());
    const second = projectNotebookWorkstationPanel(capabilities());

    expect(first).toBe(second);
    expect(first.facts).toBe(second.facts);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.facts)).toBe(true);
    expect(first).toMatchObject({
      targetId: "local-daemon",
      targetKind: "local_daemon",
      title: "This machine",
      statusLabel: "Ready",
      tone: "ready",
      providerLabel: "Local daemon",
      defaultEnvironmentLabel: "Notebook runtime",
      summary: "This machine",
    });
    expect(first.facts.map((fact) => [fact.kind, fact.label, fact.value])).toEqual([
      ["provider", "Provider", "Local daemon"],
      ["default_environment", "Default env", "Notebook runtime"],
      ["kernel", "Kernel", "idle"],
      ["cpu", "CPUs", "8"],
      ["memory", "RAM", "16 GiB"],
      ["working_directory", "Working dir", "~/notebooks"],
      ["execution_state", "State", "Can run"],
      ["remote_hint", "Remote", "Coming soon"],
    ]);
    expect(first.facts.find((fact) => fact.kind === "execution_state")?.tone).toBe("positive");
  });

  it("projects missing cloud workstations as offline without identity facts", () => {
    const projection = projectNotebookWorkstationPanel(
      capabilities({
        accessOverrides: { level: "viewer", source: "cloud", identityLabel: "Kyle" },
        runtimeOverrides: {
          canWriteRuntimeState: false,
          connected: false,
          executionAvailable: false,
          source: "cloud",
          actorLabel: null,
          identityLabel: null,
          target: {
            id: "workstation:none",
            kind: "cloud_workstation",
            status: "offline",
            label: "No workstation attached",
            statusLabel: "Offline",
            detail: "Attach a user-owned workstation to run cells in this room.",
            providerLabel: "Cloud room",
            defaultEnvironmentLabel: "Not attached",
          },
        },
      }),
    );

    expect(projection).toMatchObject({
      targetId: "workstation:none",
      title: "No workstation attached",
      statusLabel: "Offline",
      tone: "offline",
      detail: "Attach a user-owned workstation to run cells in this room.",
      providerLabel: "Cloud room",
      defaultEnvironmentLabel: "Not attached",
    });
    expect(projection.facts.map((fact) => fact.value)).toEqual([
      "Cloud room",
      "Not attached",
      "Not runnable",
    ]);
    expect(projection.facts.find((fact) => fact.kind === "execution_state")?.tone).toBe(
      "attention",
    );
    expect(projection.facts.map((fact) => fact.value)).not.toContain("Kyle");
  });

  it("projects attached cloud runtime peers as workstation facts", () => {
    const projection = projectNotebookWorkstationPanel(
      capabilities({
        accessOverrides: { level: "editor", source: "cloud" },
        runtimeOverrides: {
          canWriteRuntimeState: false,
          connected: true,
          executionAvailable: true,
          source: "cloud",
          target: {
            id: "attached-workstation",
            kind: "cloud_workstation",
            status: "ready",
            label: "Attached workstation",
            statusLabel: "Ready",
            detail: "A runtime peer is attached to this room.",
            providerLabel: "Cloud room",
            defaultEnvironmentLabel: "Current Python",
            runtimePeerCount: 2,
          },
        },
      }),
    );

    expect(projection).toMatchObject({
      targetId: "attached-workstation",
      title: "Attached workstation",
      statusLabel: "Ready",
      tone: "ready",
      summary: "Attached workstation",
    });
    expect(projection.facts.map((fact) => [fact.kind, fact.label, fact.value])).toEqual([
      ["provider", "Provider", "Cloud room"],
      ["default_environment", "Default env", "Current Python"],
      ["runtime_peers", "Compute sessions", "2"],
      ["execution_state", "State", "Can run"],
    ]);
  });

  it("projects stale cloud attachments with access-sensitive user copy", () => {
    const target = {
      id: "ws-lab2",
      kind: "cloud_workstation" as const,
      status: "attention" as const,
      label: "Lab2",
      statusLabel: "Needs attention",
      detail:
        "runtime peer disconnected: runtime peer left the room and did not return within the grace window",
      providerLabel: "Workstation",
      defaultEnvironmentLabel: "Current Python",
    };
    const ownerProjection = projectNotebookWorkstationPanel(
      capabilities({
        accessOverrides: { level: "owner", source: "cloud" },
        authOverrides: { canUseAuthenticatedIdentity: true },
        runtimeOverrides: {
          canWriteRuntimeState: false,
          connected: false,
          executionAvailable: false,
          source: "cloud",
          target,
        },
      }),
    );
    const viewerProjection = projectNotebookWorkstationPanel(
      capabilities({
        accessOverrides: { level: "viewer", source: "cloud" },
        runtimeOverrides: {
          canWriteRuntimeState: false,
          connected: false,
          executionAvailable: false,
          source: "cloud",
          target,
        },
      }),
    );

    expect(ownerProjection.detail).toBe(
      "Compute from Lab2 is no longer connected to this notebook. Start compute again from an available workstation.",
    );
    expect(viewerProjection.detail).toBe(
      "Compute from Lab2 is no longer connected to this notebook. The owner can start compute again from an available workstation.",
    );
    expect(ownerProjection.detail).not.toContain("runtime peer");
    expect(viewerProjection.detail).not.toContain("grace window");
    expect(ownerProjection).not.toBe(viewerProjection);
  });
});
