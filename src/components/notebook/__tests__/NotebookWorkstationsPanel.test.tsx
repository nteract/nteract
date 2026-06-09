import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type { NotebookShellCapabilities } from "../capabilities";
import {
  projectNotebookWorkstationSelection,
  readOnlyNotebookShellCapabilities,
} from "../capabilities";
import {
  notebookWorkstationsSummary,
  NotebookWorkstationsPanel,
} from "../NotebookWorkstationsPanel";

const localReadyCapabilities: NotebookShellCapabilities = {
  ...readOnlyNotebookShellCapabilities,
  canExecute: true,
  access: {
    ...readOnlyNotebookShellCapabilities.access,
    level: "owner",
    source: "local",
    actorLabel: "local:kyle/desktop:main",
    identityLabel: "Kyle",
    actor: {
      actorLabel: "local:kyle/desktop:main",
      principal: {
        id: "local:kyle",
        label: "Kyle",
        source: { provider: "local", namespace: "local" },
      },
      operator: { id: "desktop:main", kind: "desktop", label: "Desktop" },
      scope: "owner",
      status: "active",
    },
  },
  runtime: {
    canWriteRuntimeState: true,
    connected: true,
    executionAvailable: true,
    source: "local",
    actorLabel: "local:kyle/runtime:python",
    identityLabel: "Kyle",
    target: {
      id: "local-daemon",
      kind: "local_daemon",
      status: "ready",
      label: "This machine",
      statusLabel: "Ready",
      detail: "The local daemon is available for this notebook.",
      providerLabel: "Local daemon",
      defaultEnvironmentLabel: "Notebook runtime",
      environmentLabel: "Notebook runtime",
      kernelStatusLabel: "idle",
      cpuCount: 8,
      memoryBytes: 16 * 1024 ** 3,
      workingDirectoryLabel: "~/notebooks",
    },
    actor: {
      actorLabel: "local:kyle/runtime:python",
      principal: {
        id: "local:kyle",
        label: "Kyle",
        source: { provider: "local", namespace: "local" },
      },
      operator: { id: "runtime:python", kind: "runtime", label: "Python runtime" },
      scope: "runtime_peer",
      status: "active",
    },
  },
};

describe("NotebookWorkstationsPanel", () => {
  it("renders a local executable runtime as a workstation target", () => {
    render(<NotebookWorkstationsPanel capabilities={localReadyCapabilities} />);

    expect(screen.queryByText("local-daemon")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "This machine" })).toBeVisible();
    expect(screen.getByText("Ready")).toBeVisible();
    expect(screen.queryByText("The local daemon is available for this notebook.")).toBeNull();
    expect(screen.getByText("Local daemon")).toBeVisible();
    expect(screen.getByText("Notebook runtime")).toBeVisible();
    expect(screen.getByText("Default env")).toBeVisible();
    expect(screen.getByText("Kernel")).toBeVisible();
    expect(screen.getByText("idle")).toBeVisible();
    expect(screen.getByText("CPUs")).toBeVisible();
    expect(screen.getByText("8")).toBeVisible();
    expect(screen.getByText("RAM")).toBeVisible();
    expect(screen.getByText("16 GiB")).toBeVisible();
    expect(screen.getByText("Working dir")).toBeVisible();
    expect(screen.getByText("~/notebooks")).toBeVisible();
    expect(screen.queryByText("Resources")).not.toBeInTheDocument();
    expect(screen.queryByText("Kyle")).not.toBeInTheDocument();
    expect(screen.queryByText("Python runtime")).not.toBeInTheDocument();
    expect(screen.queryByText("Principal")).not.toBeInTheDocument();
    expect(screen.queryByText("Operator")).not.toBeInTheDocument();
    expect(screen.getByText("Can run")).toBeVisible();
    expect(screen.getByText("Remote")).toBeVisible();
    expect(screen.getByText("Coming soon")).toBeVisible();
  });

  it("renders cloud rooms without runtime peers as offline workstations", () => {
    const capabilities: NotebookShellCapabilities = {
      ...readOnlyNotebookShellCapabilities,
      access: {
        ...readOnlyNotebookShellCapabilities.access,
        source: "cloud",
        identityLabel: "Kyle",
      },
      runtime: {
        ...readOnlyNotebookShellCapabilities.runtime,
        source: "cloud",
        target: {
          id: "workstation:none",
          kind: "cloud_workstation",
          status: "offline",
          label: "No workstation attached",
          statusLabel: "Offline",
          detail: "Attach a user-owned workstation to run cells in this room.",
          providerLabel: "Cloud room",
          defaultEnvironmentLabel: "Not attached",
          environmentLabel: "Not attached",
        },
      },
    };

    render(<NotebookWorkstationsPanel capabilities={capabilities} />);

    expect(screen.queryByText("workstation:none")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No workstation attached" })).toBeVisible();
    expect(screen.getByText("Offline")).toBeVisible();
    expect(
      screen.getByText("Attach a user-owned workstation to run cells in this room."),
    ).toBeVisible();
    expect(screen.getByText("Cloud room")).toBeVisible();
    expect(screen.queryByText("Kyle")).not.toBeInTheDocument();
    expect(screen.getByText("Not attached")).toBeVisible();
    expect(screen.queryByText("Principal")).not.toBeInTheDocument();
    expect(screen.queryByText("Operator")).not.toBeInTheDocument();
    expect(screen.getByText("Not runnable")).toBeVisible();
    expect(screen.queryByText("Coming soon")).not.toBeInTheDocument();
  });

  it("directs eligible cloud users with no registered workstations toward setup", () => {
    const capabilities: NotebookShellCapabilities = {
      ...readOnlyNotebookShellCapabilities,
      access: {
        ...readOnlyNotebookShellCapabilities.access,
        level: "owner",
        source: "cloud",
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: true,
        needsAttention: false,
      },
      runtime: {
        ...readOnlyNotebookShellCapabilities.runtime,
        source: "cloud",
        target: {
          id: "workstation:none",
          kind: "cloud_workstation",
          status: "offline",
          label: "No workstation attached",
          statusLabel: "Offline",
          detail: "Attach a user-owned workstation to run cells in this room.",
          providerLabel: "Cloud room",
          defaultEnvironmentLabel: "Not attached",
          environmentLabel: "Not attached",
        },
      },
    };
    const selection = projectNotebookWorkstationSelection({
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      registeredWorkstations: [],
    });

    render(<NotebookWorkstationsPanel capabilities={capabilities} selection={selection} />);

    expect(screen.getByTestId("workstation-registration-empty")).toBeVisible();
    expect(screen.getByText("No workstation registered")).toBeVisible();
    expect(
      screen.getByText(
        "Run the workstation agent on a machine you own, then attach it here to start compute.",
      ),
    ).toBeVisible();
  });

  it("does not show workstation setup for viewers without compute selection authority", () => {
    const selection = projectNotebookWorkstationSelection({
      canRegisterWorkstation: true,
      canSelectWorkstation: false,
      registeredWorkstations: [],
    });

    render(
      <NotebookWorkstationsPanel
        capabilities={readOnlyNotebookShellCapabilities}
        selection={selection}
      />,
    );

    expect(screen.queryByTestId("workstation-registration-empty")).not.toBeInTheDocument();
  });

  it("renders registered workstation targets with default and attach actions", () => {
    const attached: string[] = [];
    const defaults: string[] = [];
    const selection = projectNotebookWorkstationSelection({
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canSetDefaultWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [
        {
          id: "ws-lab2",
          displayName: "Lab2",
          defaultEnvironmentLabel: "Current Python",
          environmentPolicy: "current_python",
          provider: "runtime_peer",
          status: "online",
          workingDirectory: "/home/ubuntu/project",
        },
        {
          id: "ws-offline",
          displayName: "Offline workstation",
          provider: "runtime_peer",
          status: "offline",
          statusMessage: "No heartbeat from this workstation recently.",
        },
      ],
    });

    render(
      <NotebookWorkstationsPanel
        capabilities={readOnlyNotebookShellCapabilities}
        selection={selection}
        onAttachWorkstation={(workstationId) => attached.push(workstationId)}
        onSetDefaultWorkstation={(workstationId) => defaults.push(workstationId)}
      />,
    );

    expect(screen.getByText("id ws-lab2")).toBeVisible();
    expect(screen.getByText("Lab2")).toBeVisible();
    expect(screen.getByText("Default")).toBeVisible();
    expect(screen.getByText("Env")).toBeVisible();
    expect(screen.getByText("/home/ubuntu/project")).toBeVisible();
    const attachButtons = screen.getAllByRole("button", { name: "Attach" });
    fireEvent.click(attachButtons[0]!);
    expect(attached).toEqual(["ws-lab2"]);

    expect(screen.getByText("Offline workstation")).toBeVisible();
    expect(screen.getByText("No heartbeat from this workstation recently.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Set default" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Set default" }));
    expect(defaults).toEqual(["ws-offline"]);
    expect(attachButtons[1]).toBeDisabled();
  });

  it("keeps the detached cloud target compact when registered workstations are listed", () => {
    const capabilities: NotebookShellCapabilities = {
      ...readOnlyNotebookShellCapabilities,
      access: {
        ...readOnlyNotebookShellCapabilities.access,
        level: "owner",
        source: "cloud",
      },
      auth: {
        canSignIn: false,
        canUseAuthenticatedIdentity: true,
        needsAttention: false,
      },
      runtime: {
        ...readOnlyNotebookShellCapabilities.runtime,
        source: "cloud",
        target: {
          id: "workstation:none",
          kind: "cloud_workstation",
          status: "offline",
          label: "No workstation attached",
          statusLabel: "Offline",
          detail: "Attach a user-owned workstation to run cells in this room.",
          providerLabel: "Cloud room",
          defaultEnvironmentLabel: "Not attached",
          environmentLabel: "Not attached",
        },
      },
    };
    const selection = projectNotebookWorkstationSelection({
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canSetDefaultWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [
        {
          id: "ws-lab2",
          displayName: "Lab2",
          defaultEnvironmentLabel: "Current Python",
          environmentPolicy: "current_python",
          provider: "runtime_peer",
          status: "offline",
          statusMessage: "No heartbeat from this workstation recently.",
          workingDirectory: "/home/ubuntu/project",
        },
      ],
    });

    render(
      <NotebookWorkstationsPanel
        capabilities={capabilities}
        selection={selection}
        statusMessage="No heartbeat from this workstation recently."
        onAttachWorkstation={() => {}}
        onSetDefaultWorkstation={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "No workstation attached" })).toBeVisible();
    expect(
      screen.getByText("Attach a user-owned workstation to run cells in this room."),
    ).toBeVisible();
    expect(screen.queryByText("Cloud room")).not.toBeInTheDocument();
    expect(screen.queryByText("Not runnable")).not.toBeInTheDocument();
    expect(screen.getByText("Lab2")).toBeVisible();
    expect(screen.getByText("Current Python")).toBeVisible();
    expect(screen.getByText("id ws-lab2")).toBeVisible();
    expect(screen.getAllByText("No heartbeat from this workstation recently.")).toHaveLength(1);
  });

  it("does not duplicate the attached workstation in the registered list", () => {
    const capabilities: NotebookShellCapabilities = {
      ...readOnlyNotebookShellCapabilities,
      canExecute: true,
      access: {
        ...readOnlyNotebookShellCapabilities.access,
        level: "owner",
        source: "cloud",
      },
      runtime: {
        ...readOnlyNotebookShellCapabilities.runtime,
        canWriteRuntimeState: true,
        connected: true,
        executionAvailable: true,
        source: "cloud",
        target: {
          id: "ws-lab2",
          kind: "runtime_peer",
          status: "ready",
          label: "Lab2",
          statusLabel: "Ready",
          providerLabel: "Runtime peer",
          defaultEnvironmentLabel: "Current Python",
          environmentLabel: "Current Python",
          cpuCount: 8,
          memoryBytes: 30 * 1024 ** 3,
          workingDirectoryLabel: "/home/ubuntu/project",
        },
      },
    };
    const selection = projectNotebookWorkstationSelection({
      activeAttachment: {
        workstation_id: "ws-lab2",
        display_name: "Lab2",
        provider: "runtime_peer",
        default_environment_label: "Current Python",
        environment_policy: "current_python",
        status: "ready",
        cpu_count: 8,
        memory_bytes: 30 * 1024 ** 3,
        working_directory: "/home/ubuntu/project",
      },
      canRegisterWorkstation: true,
      canSelectWorkstation: true,
      canSetDefaultWorkstation: true,
      defaultWorkstationId: "ws-lab2",
      registeredWorkstations: [
        {
          id: "ws-lab2",
          displayName: "Lab2",
          defaultEnvironmentLabel: "Current Python",
          environmentPolicy: "current_python",
          provider: "runtime_peer",
          status: "online",
          workingDirectory: "/home/ubuntu/project",
        },
        {
          id: "ws-gpu",
          displayName: "GPU host",
          defaultEnvironmentLabel: "CUDA Python",
          environmentPolicy: "current_python",
          provider: "runtime_peer",
          status: "online",
          workingDirectory: "/home/ubuntu/gpu",
        },
      ],
    });

    render(
      <NotebookWorkstationsPanel
        capabilities={capabilities}
        selection={selection}
        onAttachWorkstation={() => {}}
        onSetDefaultWorkstation={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "Lab2" })).toBeVisible();
    expect(screen.getAllByText("Runtime peer")).toHaveLength(1);
    expect(screen.getAllByText("Current Python")).toHaveLength(1);
    expect(screen.getByText("id ws-lab2")).toBeVisible();
    expect(screen.getAllByTestId("registered-workstation")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "GPU host" })).toBeVisible();
    expect(screen.getByText("CUDA Python")).toBeVisible();
    expect(screen.getByText("id ws-gpu")).toBeVisible();
  });

  it("keeps legacy resource labels when structured resources are absent", () => {
    render(
      <NotebookWorkstationsPanel
        capabilities={{
          ...localReadyCapabilities,
          runtime: {
            ...localReadyCapabilities.runtime,
            target: {
              id: "remote-devbox",
              kind: "cloud_workstation",
              status: "ready",
              label: "Remote devbox",
              statusLabel: "Ready",
              providerLabel: "JupyterHub",
              defaultEnvironmentLabel: "Current Python",
              resourceLabel: "4 CPU / 16 GB RAM",
              runtimePeerCount: 1,
            },
          },
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Remote devbox" })).toBeVisible();
    expect(screen.getByText("Default env")).toBeVisible();
    expect(screen.getByText("Current Python")).toBeVisible();
    expect(screen.getByText("Resources")).toBeVisible();
    expect(screen.getByText("4 CPU / 16 GB RAM")).toBeVisible();
    expect(screen.getByText("Runtime peers")).toBeVisible();
    expect(screen.getByText("1")).toBeVisible();
    expect(screen.queryByText("CPUs")).not.toBeInTheDocument();
    expect(screen.queryByText("RAM")).not.toBeInTheDocument();
  });

  it("summarizes the active workstation by display name for the rail title row", () => {
    expect(notebookWorkstationsSummary(localReadyCapabilities)).toBe("This machine");

    const cloudOffline: NotebookShellCapabilities = {
      ...readOnlyNotebookShellCapabilities,
      runtime: {
        ...readOnlyNotebookShellCapabilities.runtime,
        source: "cloud",
        target: {
          id: "workstation:none",
          kind: "cloud_workstation",
          status: "offline",
          label: "No workstation attached",
          statusLabel: "Offline",
        },
      },
    };
    expect(notebookWorkstationsSummary(cloudOffline)).toBe("No workstation attached");

    const remoteReady: NotebookShellCapabilities = {
      ...localReadyCapabilities,
      runtime: {
        ...localReadyCapabilities.runtime,
        target: {
          id: "outerbounds-forecast-gpu",
          kind: "cloud_workstation",
          status: "ready",
          label: "Forecast GPU",
        },
      },
    };
    expect(notebookWorkstationsSummary(remoteReady)).toBe("Forecast GPU");
  });
});
