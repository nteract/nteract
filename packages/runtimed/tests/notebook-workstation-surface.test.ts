import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  clearNotebookWorkstationLaunchReadinessProjectionCacheForTests,
  clearNotebookWorkstationSelectionProjectionCacheForTests,
  clearNotebookWorkstationSurfaceProjectionCacheForTests,
  projectNotebookWorkstationSurface,
  type NotebookRegisteredWorkstation,
  type NotebookShellCapabilities,
} from "../src";

type SurfaceCapabilities = Pick<NotebookShellCapabilities, "canExecute" | "runtime">;

const cloudUnavailableCapabilities: SurfaceCapabilities = {
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
      label: "No compute session",
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
  clearNotebookWorkstationSurfaceProjectionCacheForTests();
});

describe("notebook workstation surface projection", () => {
  it("projects an online default workstation into a start-compute toolbar intent", () => {
    const projection = projectNotebookWorkstationSurface({
      capabilities: cloudUnavailableCapabilities,
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canSetDefaultWorkstation: true,
      canStartWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [lab2Workstation],
    });

    expect(projection.selection.state).toBe("default");
    expect(projection.launchReadiness.state).toBe("needs_attachment");
    expect(projection.canStartSelectedWorkstation).toBe(true);
    expect(projection.toolbarAction).toMatchObject({
      disabled: false,
      kind: "attach_workstation",
      label: "Start compute",
      pending: false,
      title: "Start compute on Lab2 workstation",
      workstationId: "ws-lab2",
    });
  });

  it("projects attach mutations as pending toolbar state and busy workstation id", () => {
    const projection = projectNotebookWorkstationSurface({
      capabilities: cloudUnavailableCapabilities,
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canSetDefaultWorkstation: true,
      canStartWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      mutation: {
        kind: "attach",
        message: "Starting workstation...",
        workstationId: "ws-lab2",
      },
      registeredWorkstations: [lab2Workstation],
    });

    expect(projection.busyWorkstationId).toBe("ws-lab2");
    expect(projection.canStartSelectedWorkstation).toBe(false);
    expect(projection.panelStatusMessage).toBe("Starting workstation...");
    expect(projection.toolbarAction).toMatchObject({
      disabled: true,
      kind: "attach_workstation",
      label: "Starting",
      pending: true,
      title: "Starting compute on Lab2 workstation",
      workstationId: "ws-lab2",
    });
  });

  it("prioritizes loading, registry errors, then workstation unavailable details", () => {
    const loading = projectNotebookWorkstationSurface({
      capabilities: cloudUnavailableCapabilities,
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canStartWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      loadingMessage: "Preparing workstation access...",
      registeredWorkstations: [{ ...lab2Workstation, status: "offline", statusMessage: "Offline" }],
      registryError: "Registry unavailable",
    });
    expect(loading.panelStatusMessage).toBe("Preparing workstation access...");

    const errored = projectNotebookWorkstationSurface({
      capabilities: cloudUnavailableCapabilities,
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canStartWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [{ ...lab2Workstation, status: "offline", statusMessage: "Offline" }],
      registryError: "Registry unavailable",
    });
    expect(errored.panelStatusMessage).toBe("Registry unavailable");

    const unavailable = projectNotebookWorkstationSurface({
      capabilities: cloudUnavailableCapabilities,
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canStartWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [{ ...lab2Workstation, status: "offline", statusMessage: "Offline" }],
    });
    expect(unavailable.panelStatusMessage).toBe("Offline");
  });

  it("suppresses startability when the host cannot start workstations", () => {
    const projection = projectNotebookWorkstationSurface({
      capabilities: cloudUnavailableCapabilities,
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canSetDefaultWorkstation: true,
      canStartWorkstation: false,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [lab2Workstation],
    });

    expect(projection.canStartSelectedWorkstation).toBe(false);
    expect(projection.toolbarAction).toBeNull();
  });

  it("returns stable frozen projections for equivalent inputs", () => {
    const first = projectNotebookWorkstationSurface({
      capabilities: cloudUnavailableCapabilities,
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canSetDefaultWorkstation: true,
      canStartWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [lab2Workstation],
    });
    const second = projectNotebookWorkstationSurface({
      capabilities: { ...cloudUnavailableCapabilities },
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canSetDefaultWorkstation: true,
      canStartWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [{ ...lab2Workstation }],
    });

    expect(first).toBe(second);
    expect(first.toolbarAction).toBe(second.toolbarAction);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.toolbarAction)).toBe(true);
  });
});
