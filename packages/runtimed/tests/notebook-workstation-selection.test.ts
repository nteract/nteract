import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  clearNotebookWorkstationSelectionProjectionCacheForTests,
  projectNotebookWorkstationAcceleratorSummary,
  projectNotebookWorkstationSelection,
  type NotebookRegisteredWorkstation,
} from "../src";

beforeEach(() => {
  clearNotebookWorkstationSelectionProjectionCacheForTests();
});

const lab2Workstation: NotebookRegisteredWorkstation = {
  id: "ws-lab2",
  displayName: "Lab2 workstation",
  provider: "runtime_peer",
  defaultEnvironmentLabel: "Current Python",
  environmentPolicy: "current_python",
  status: "online",
  installedBuild: "0.1.0+abc123",
  channel: "nightly",
  cpuCount: 8,
  memoryBytes: 32 * 1024 ** 3,
  accelerators: [
    {
      kind: "gpu",
      vendor: "NVIDIA",
      model: "A100",
      count: 1,
      memory_bytes_per_device: 80 * 1024 ** 3,
      readiness: "ready",
    },
  ],
  workingDirectory: "/home/ubuntu/codex/nteract",
  environments: [
    {
      id: "current-python",
      label: "Current Python",
      policy: "current_python",
      available: true,
      isDefault: true,
    },
  ],
};

describe("notebook workstation selection projection", () => {
  it("returns stable frozen projections for equivalent registered workstation inputs", () => {
    const first = projectNotebookWorkstationSelection({
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canSetDefaultWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [lab2Workstation],
    });
    const second = projectNotebookWorkstationSelection({
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canSetDefaultWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [{ ...lab2Workstation }],
    });

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.registeredWorkstations)).toBe(true);
    expect(Object.isFrozen(first.defaultWorkstation)).toBe(true);
    expect(Object.isFrozen(first.defaultWorkstation?.environments[0])).toBe(true);
    expect(first.state).toBe("default");
    expect(first.launchCandidate?.id).toBe("ws-lab2");
    expect(first.defaultWorkstation).toMatchObject({
      id: "ws-lab2",
      displayName: "Lab2 workstation",
      providerLabel: "Workstation",
      installedBuild: "0.1.0+abc123",
      channel: "nightly",
      isDefault: true,
      cpuCount: 8,
      memoryBytes: 32 * 1024 ** 3,
      accelerators: [
        expect.objectContaining({
          kind: "gpu",
          model: "A100",
          count: 1,
          readiness: "ready",
        }),
      ],
      workingDirectoryLabel: "/home/ubuntu/codex/nteract",
    });
    expect(first.defaultWorkstation?.facts).toContainEqual({
      detail: null,
      kind: "accelerator",
      label: "GPU",
      tone: "positive",
      value: "1× NVIDIA A100 · 80 GiB",
    });
  });

  it("formats multiple GPUs and surfaces detected-but-not-ready diagnostics", () => {
    const projection = projectNotebookWorkstationSelection({
      registeredWorkstations: [
        {
          ...lab2Workstation,
          accelerators: [
            {
              kind: "gpu",
              vendor: "NVIDIA",
              model: "A100",
              count: 2,
              memory_bytes_per_device: 80 * 1024 ** 3,
              readiness: "not_ready",
              diagnostic: "NVIDIA driver is not visible to the workstation service.",
            },
          ],
        },
      ],
    });

    expect(projection.registeredWorkstations[0]?.facts).toContainEqual({
      detail: "NVIDIA driver is not visible to the workstation service.",
      kind: "accelerator",
      label: "GPU",
      tone: "attention",
      value: "2× NVIDIA A100 · 80 GiB each",
    });
    expect(projection.registeredWorkstations[0]?.canAttach).toBe(true);
  });

  it("bounds extensible accelerator kind labels for narrow rails", () => {
    const summary = projectNotebookWorkstationAcceleratorSummary(
      [
        {
          kind: "neural-processing-unit",
          vendor: "Example",
          model: "NPU-1",
          count: 1,
          readiness: "unknown",
        },
      ],
      false,
    );

    expect(summary).toMatchObject({
      label: "Accel",
      tone: "attention",
      value: "NEURAL-PROCESSING-UNIT 1× Example NPU-1",
    });
  });

  it("preserves known-none versus unknown while omitting both GPU facts", () => {
    const projection = projectNotebookWorkstationSelection({
      registeredWorkstations: [
        { ...lab2Workstation, id: "ws-known-none", accelerators: [] },
        { ...lab2Workstation, id: "ws-legacy", accelerators: null },
      ],
    });

    expect(projection.registeredWorkstations[0]?.accelerators).toEqual([]);
    expect(projection.registeredWorkstations[1]?.accelerators).toBeNull();
    expect(
      projection.registeredWorkstations.flatMap((workstation) => workstation.facts),
    ).not.toContainEqual(expect.objectContaining({ kind: "accelerator" }));
  });

  it("retains neutral GPU hardware facts when the workstation is offline", () => {
    const projection = projectNotebookWorkstationSelection({
      registeredWorkstations: [{ ...lab2Workstation, status: "offline" }],
    });

    expect(projection.registeredWorkstations[0]?.facts).toContainEqual({
      detail: null,
      kind: "accelerator",
      label: "GPU",
      tone: "neutral",
      value: "1× NVIDIA A100 · 80 GiB",
    });
  });

  it("retains accelerator attention while a non-offline workstation needs attention", () => {
    const projection = projectNotebookWorkstationSelection({
      registeredWorkstations: [
        {
          ...lab2Workstation,
          status: "attention",
          accelerators: lab2Workstation.accelerators?.map((accelerator) => ({
            ...accelerator,
            readiness: "not_ready" as const,
          })),
        },
      ],
    });

    expect(
      projection.registeredWorkstations[0]?.facts.find((fact) => fact.kind === "accelerator"),
    ).toMatchObject({ tone: "attention" });
  });

  it("invalidates stable projections when only accelerator readiness changes", () => {
    const first = projectNotebookWorkstationSelection({
      registeredWorkstations: [lab2Workstation],
    });
    const second = projectNotebookWorkstationSelection({
      registeredWorkstations: [
        {
          ...lab2Workstation,
          accelerators: lab2Workstation.accelerators?.map((accelerator) => ({
            ...accelerator,
            readiness: "unknown" as const,
          })),
        },
      ],
    });

    expect(second).not.toBe(first);
    expect(second.registeredWorkstations[0]).not.toBe(first.registeredWorkstations[0]);
    expect(
      second.registeredWorkstations[0]?.facts.find((fact) => fact.kind === "accelerator"),
    ).toMatchObject({ tone: "attention" });
  });

  it("keeps registered, selected, and attached workstation states distinct", () => {
    const selected = projectNotebookWorkstationSelection({
      canSelectWorkstation: true,
      defaultWorkstationId: "ws-other",
      registeredWorkstations: [lab2Workstation],
      selectedWorkstationId: "ws-lab2",
    });

    expect(selected.state).toBe("selected");
    expect(selected.activeTarget).toBeNull();
    expect(selected.selectedWorkstation?.isSelected).toBe(true);
    expect(selected.launchCandidate?.id).toBe("ws-lab2");

    const attached = projectNotebookWorkstationSelection({
      activeAttachment: {
        workstation_id: "ws-attached",
        display_name: "Connected workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
      },
      canSelectWorkstation: true,
      registeredWorkstations: [lab2Workstation],
      selectedWorkstationId: "ws-lab2",
    });

    expect(attached.state).toBe("attached");
    expect(attached.activeWorkstationId).toBe("ws-attached");
    expect(attached.activeTarget).toMatchObject({
      id: "ws-attached",
      label: "Connected workstation",
      status: "ready",
    });
    expect(attached.selectedWorkstation?.id).toBe("ws-lab2");
  });

  it("carries latest build metadata into registered workstation projections", () => {
    const projection = projectNotebookWorkstationSelection({
      registeredWorkstations: [
        {
          ...lab2Workstation,
          latestBuild: "0.2.0-nightly.202607091009",
          isOutdated: true,
        },
      ],
    });

    expect(projection.registeredWorkstations[0]).toMatchObject({
      installedBuild: "0.1.0+abc123",
      channel: "nightly",
      latestBuild: "0.2.0-nightly.202607091009",
      isOutdated: true,
    });
  });

  it("does not let a stale attachment hide an offline registered workstation", () => {
    const projection = projectNotebookWorkstationSelection({
      activeAttachment: {
        workstation_id: "ws-lab2",
        display_name: "Lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
      },
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

    expect(projection.state).toBe("default");
    expect(projection.activeWorkstationId).toBe("ws-lab2");
    expect(projection.activeTarget).toMatchObject({
      id: "ws-lab2",
      label: "Lab2 workstation",
      status: "offline",
      detail: "No heartbeat from this workstation recently.",
    });
    expect(projection.defaultWorkstation?.isAttached).toBe(false);
    expect(projection.launchCandidate?.id).toBe("ws-lab2");
  });

  it("keeps idle attachment identity when an offline registry row degrades the target", () => {
    const projection = projectNotebookWorkstationSelection({
      activeAttachment: {
        workstation_id: "ws-lab2",
        display_name: "Lab2 workstation",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "idle",
      },
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

    expect(projection.state).toBe("default");
    expect(projection.activeWorkstationId).toBe("ws-lab2");
    expect(projection.activeTarget).toMatchObject({
      id: "ws-lab2",
      label: "Lab2 workstation",
      status: "offline",
      attachmentIdle: true,
      detail: "No heartbeat from this workstation recently.",
    });
    expect(projection.defaultWorkstation?.isAttached).toBe(false);
    expect(projection.launchCandidate?.id).toBe("ws-lab2");
  });

  it("directs owners with no registered workstations toward workstation setup", () => {
    const projection = projectNotebookWorkstationSelection({
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      registeredWorkstations: [],
    });

    expect(projection.state).toBe("needs_registration");
    expect(projection.launchCandidate).toBeNull();
    expect(projection.canRegisterWorkstation).toBe(true);
  });

  it("does not show the registration state when the user cannot select compute for the notebook", () => {
    const projection = projectNotebookWorkstationSelection({
      canRegisterWorkstation: true,
      canSelectWorkstation: false,
      registeredWorkstations: [],
    });

    expect(projection.state).toBe("unselected");
  });

  it("deduplicates invalid registry entries without treating registration as attachment", () => {
    const projection = projectNotebookWorkstationSelection({
      canSelectWorkstation: true,
      registeredWorkstations: [
        { ...lab2Workstation, id: " " },
        lab2Workstation,
        { ...lab2Workstation, displayName: "Duplicate" },
      ],
    });

    expect(projection.state).toBe("unselected");
    expect(projection.registeredWorkstations).toHaveLength(1);
    expect(projection.registeredWorkstations[0]?.isAttached).toBe(false);
  });
});
