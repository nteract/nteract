import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  clearNotebookWorkstationLaunchReadinessProjectionCacheForTests,
  clearNotebookWorkstationSelectionProjectionCacheForTests,
  projectNotebookWorkstationLaunchReadiness,
  projectNotebookWorkstationSelection,
  type NotebookRegisteredWorkstation,
  type NotebookShellCapabilities,
} from "../src";

type LaunchCapabilities = Pick<NotebookShellCapabilities, "canExecute" | "runtime">;

const localReadyCapabilities: LaunchCapabilities = {
  canExecute: true,
  runtime: {
    actorLabel: null,
    canWriteRuntimeState: false,
    connected: true,
    executionAvailable: true,
    identityLabel: null,
    source: "local",
    target: {
      id: "local-daemon",
      kind: "local_daemon",
      label: "This machine",
      status: "ready",
      statusLabel: "Ready",
    },
  },
};

const cloudUnavailableCapabilities: LaunchCapabilities = {
  canExecute: false,
  runtime: {
    actorLabel: null,
    canWriteRuntimeState: false,
    connected: false,
    executionAvailable: false,
    identityLabel: null,
    source: "cloud",
    target: {
      id: "workstation:none",
      kind: "cloud_workstation",
      label: "No workstation attached",
      status: "offline",
      statusLabel: "Offline",
    },
  },
};

const lab2Workstation: NotebookRegisteredWorkstation = {
  id: "ws-lab2",
  displayName: "Lab2 workstation",
  provider: "runtime_peer",
  defaultEnvironmentLabel: "Current Python",
  environmentPolicy: "current_python",
  status: "online",
  cpuCount: 8,
  memoryBytes: 32 * 1024 ** 3,
  workingDirectory: "/home/ubuntu/codex/nteract",
};

beforeEach(() => {
  clearNotebookWorkstationLaunchReadinessProjectionCacheForTests();
  clearNotebookWorkstationSelectionProjectionCacheForTests();
});

describe("notebook workstation launch readiness projection", () => {
  it("returns a stable ready projection for executable attached compute", () => {
    const first = projectNotebookWorkstationLaunchReadiness({
      capabilities: localReadyCapabilities,
    });
    const second = projectNotebookWorkstationLaunchReadiness({
      capabilities: { ...localReadyCapabilities },
    });

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.primaryAction)).toBe(true);
    expect(first).toMatchObject({
      canRun: true,
      state: "ready",
      statusLabel: "Ready",
      targetLabel: "This machine",
      workstationId: "local-daemon",
      primaryAction: {
        kind: "none",
      },
    });
  });

  it("projects missing workstation registration as setup rather than launch", () => {
    const selection = projectNotebookWorkstationSelection({
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      registeredWorkstations: [],
    });
    const projection = projectNotebookWorkstationLaunchReadiness({
      capabilities: cloudUnavailableCapabilities,
      selection,
    });

    expect(projection).toMatchObject({
      canRun: false,
      detail: "Open the workstation panel to register compute before running this notebook.",
      state: "needs_registration",
      statusLabel: "Setup needed",
      primaryAction: {
        kind: "setup_workstation",
        label: "Set up compute",
      },
    });
  });

  it("does not direct viewers toward workstation setup when none are registered", () => {
    const selection = projectNotebookWorkstationSelection({
      canRegisterWorkstation: false,
      canSelectWorkstation: false,
      registeredWorkstations: [],
    });
    const projection = projectNotebookWorkstationLaunchReadiness({
      capabilities: cloudUnavailableCapabilities,
      selection,
    });

    expect(projection).toMatchObject({
      canRun: false,
      state: "unavailable",
      primaryAction: {
        kind: "none",
      },
    });
  });

  it("projects a selected online workstation as needing attachment", () => {
    const selection = projectNotebookWorkstationSelection({
      canSelectWorkstation: true,
      registeredWorkstations: [lab2Workstation],
      selectedWorkstationId: "ws-lab2",
    });
    const projection = projectNotebookWorkstationLaunchReadiness({
      capabilities: cloudUnavailableCapabilities,
      selection,
    });

    expect(projection).toMatchObject({
      canRun: false,
      state: "needs_attachment",
      statusLabel: "Attach needed",
      targetLabel: "Lab2 workstation",
      workstationId: "ws-lab2",
      primaryAction: {
        kind: "attach_workstation",
        label: "Attach compute",
      },
    });
  });

  it("keeps online workstations without launch context unavailable", () => {
    const missingWorkingDirectory = projectNotebookWorkstationSelection({
      canSelectWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [{ ...lab2Workstation, workingDirectory: null }],
    });
    const missingWorkingDirectoryProjection = projectNotebookWorkstationLaunchReadiness({
      capabilities: cloudUnavailableCapabilities,
      selection: missingWorkingDirectory,
    });

    expect(missingWorkingDirectoryProjection).toMatchObject({
      canRun: false,
      detail:
        "This workstation does not have a working directory configured for notebook execution.",
      primaryAction: {
        kind: "open_workstations",
        label: "Review compute",
      },
      state: "workstation_unavailable",
      targetLabel: "Lab2 workstation",
      workstationId: "ws-lab2",
    });

    const missingEnvironment = projectNotebookWorkstationSelection({
      canSelectWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [
        {
          ...lab2Workstation,
          defaultEnvironmentLabel: null,
          environments: [
            {
              id: "project-env",
              label: "Project environment",
              available: false,
            },
          ],
        },
      ],
    });
    const missingEnvironmentProjection = projectNotebookWorkstationLaunchReadiness({
      capabilities: cloudUnavailableCapabilities,
      selection: missingEnvironment,
    });

    expect(missingEnvironmentProjection).toMatchObject({
      canRun: false,
      detail: "This workstation does not have a runnable default environment configured.",
      primaryAction: {
        kind: "open_workstations",
        label: "Review compute",
      },
      state: "workstation_unavailable",
      targetLabel: "Lab2 workstation",
      workstationId: "ws-lab2",
    });
  });

  it("projects an offline default workstation as unavailable with its status message", () => {
    const selection = projectNotebookWorkstationSelection({
      canSelectWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [
        {
          ...lab2Workstation,
          status: "offline",
          statusMessage: "No heartbeat from this workstation recently.",
        },
      ],
    });
    const projection = projectNotebookWorkstationLaunchReadiness({
      capabilities: cloudUnavailableCapabilities,
      selection,
    });

    expect(projection).toMatchObject({
      canRun: false,
      detail: "No heartbeat from this workstation recently.",
      primaryAction: {
        kind: "open_workstations",
        label: "Review compute",
      },
      state: "workstation_unavailable",
      statusLabel: "Offline",
      targetLabel: "Lab2 workstation",
      workstationId: "ws-lab2",
    });
  });

  it("projects registered workstations without a selected/default target as selection needed", () => {
    const selection = projectNotebookWorkstationSelection({
      canSelectWorkstation: true,
      registeredWorkstations: [lab2Workstation],
    });
    const projection = projectNotebookWorkstationLaunchReadiness({
      capabilities: cloudUnavailableCapabilities,
      selection,
    });

    expect(projection).toMatchObject({
      canRun: false,
      state: "needs_selection",
      statusLabel: "Choose compute",
      primaryAction: {
        kind: "select_workstation",
      },
    });
  });

  it("keeps attached compute permission limits distinct from missing compute", () => {
    const projection = projectNotebookWorkstationLaunchReadiness({
      capabilities: {
        ...localReadyCapabilities,
        canExecute: false,
      },
    });

    expect(projection).toMatchObject({
      canRun: false,
      state: "limited",
      statusLabel: "Ready",
      primaryAction: {
        kind: "none",
      },
    });
  });

  it("projects room-host attachment progress from RuntimeStateDoc target state", () => {
    const selection = projectNotebookWorkstationSelection({
      activeAttachment: {
        workstation_id: "ws-lab2",
        display_name: "Lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "connecting",
      },
      canSelectWorkstation: true,
      registeredWorkstations: [lab2Workstation],
      selectedWorkstationId: "ws-lab2",
    });
    const projection = projectNotebookWorkstationLaunchReadiness({
      capabilities: {
        ...cloudUnavailableCapabilities,
        runtime: {
          ...cloudUnavailableCapabilities.runtime,
          connected: true,
        },
      },
      selection,
    });

    expect(projection).toMatchObject({
      canRun: false,
      state: "attaching",
      statusLabel: "Connecting",
      targetLabel: "Lab2 workstation",
      workstationId: "ws-lab2",
    });
  });
});
