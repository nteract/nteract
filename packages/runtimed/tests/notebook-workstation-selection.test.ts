import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  clearNotebookWorkstationSelectionProjectionCacheForTests,
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
  cpuCount: 8,
  memoryBytes: 32 * 1024 ** 3,
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
      providerLabel: "Runtime peer",
      isDefault: true,
      cpuCount: 8,
      memoryBytes: 32 * 1024 ** 3,
      workingDirectoryLabel: "/home/ubuntu/codex/nteract",
    });
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
        display_name: "Attached workstation",
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
      label: "Attached workstation",
      status: "ready",
    });
    expect(attached.selectedWorkstation?.id).toBe("ws-lab2");
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
