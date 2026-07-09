import { describe, expect, it } from "vite-plus/test";
import { projectNotebookWorkstationSelection, type NotebookRegisteredWorkstation } from "runtimed";
import { projectWorkstationsPage } from "../workstations-page-model";

const labWorkstation: NotebookRegisteredWorkstation = {
  id: "ws-lab2",
  displayName: "Lab2 workstation",
  provider: "runtime_peer",
  defaultEnvironmentLabel: "Current Python",
  environmentPolicy: "current_python",
  installedBuild: "0.1.0+abc123",
  channel: "nightly",
  status: "online",
  cpuCount: 8,
  memoryBytes: 16 * 1024 ** 3,
  workingDirectory: "/home/ubuntu/project",
  environments: [],
};

describe("workstations page model", () => {
  it("projects registry-carried build metadata into detail spec cells", () => {
    const selection = projectNotebookWorkstationSelection({
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [labWorkstation],
    });

    const page = projectWorkstationsPage(selection.registeredWorkstations);

    expect(page.items[0]?.specs.map((spec) => [spec.key, spec.label, spec.value])).toEqual([
      ["cpu", "vCPU", "8"],
      ["memory", "Memory", "16 GiB"],
      ["build", "Build", "0.1.0+abc123"],
      ["channel", "Channel", "nightly"],
      ["environment", "Environment", "Current Python"],
      ["working-directory", "Working directory", "/home/ubuntu/project"],
    ]);
  });

  it("projects outdated build metadata without changing liveness actions", () => {
    const selection = projectNotebookWorkstationSelection({
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [
        {
          ...labWorkstation,
          latestBuild: "0.2.0-nightly.202607091009",
          isOutdated: true,
        },
      ],
    });

    const page = projectWorkstationsPage(selection.registeredWorkstations);
    const item = page.items[0];
    const buildSpec = item?.specs.find((spec) => spec.key === "build");

    expect(item?.outdatedLabel).toBe("Update available");
    expect(item?.latestBuildLabel).toBe("Latest 0.2.0-nightly.202607091009");
    expect(item?.rowSublineLabel).toBe("Online · Latest 0.2.0-nightly.202607091009");
    expect(item?.canReconnect).toBe(false);
    expect(item?.canRestart).toBe(true);
    expect(buildSpec).toMatchObject({
      detail: "Latest 0.2.0-nightly.202607091009",
      tone: "attention",
    });
  });
});
