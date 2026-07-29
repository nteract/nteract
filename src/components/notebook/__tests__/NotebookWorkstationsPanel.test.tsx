import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type { NotebookShellCapabilities } from "../capabilities";
import {
  projectNotebookWorkstationSelection,
  readOnlyNotebookShellCapabilities,
} from "../capabilities";
import {
  NotebookWorkstationsPanel,
  NotebookWorkstationsPanelAction,
} from "../NotebookWorkstationsPanel";

// "Workstation details" is collapsed by default, so facts need an expand click.
function expandWorkstationDetails() {
  fireEvent.click(screen.getByRole("button", { name: "Workstation details" }));
}

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
    expandWorkstationDetails();

    expect(screen.queryByText("local-daemon")).not.toBeInTheDocument();
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
          label: "No compute session",
          statusLabel: "Offline",
          detail: "Start compute from a user-owned workstation to run cells in this notebook.",
          providerLabel: "Cloud room",
          defaultEnvironmentLabel: "Not running",
          environmentLabel: "Not running",
        },
      },
    };

    render(<NotebookWorkstationsPanel capabilities={capabilities} />);
    expandWorkstationDetails();

    expect(screen.queryByText("workstation:none")).not.toBeInTheDocument();
    expect(screen.getByText("Cloud room")).toBeVisible();
    expect(screen.queryByText("Kyle")).not.toBeInTheDocument();
    expect(screen.getByText("Not running")).toBeVisible();
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
          label: "No compute session",
          statusLabel: "Offline",
          detail: "Start compute from a user-owned workstation to run cells in this notebook.",
          providerLabel: "Cloud room",
          defaultEnvironmentLabel: "Not running",
          environmentLabel: "Not running",
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
      screen.getByText("Connect a machine you own to run this notebook’s compute there."),
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

  it("lists registered workstations as icon, name, and status only", () => {
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

    expect(screen.getByRole("heading", { name: "Lab2" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Offline workstation" })).toBeVisible();
    const rows = screen.getAllByTestId("registered-workstation");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Online")).toBeVisible();
    expect(within(rows[1]!).getByText("Offline")).toBeVisible();

    // Rows carry the status plus a right-aligned Start; no facts, ids, or defaults.
    expect(screen.queryByText("id ws-lab2")).not.toBeInTheDocument();
    expect(screen.queryByText("Env")).not.toBeInTheDocument();
    expect(screen.queryByText("/home/ubuntu/project")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No heartbeat from this workstation recently."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set default" })).not.toBeInTheDocument();
    expect(defaults).toEqual([]);

    expect(within(rows[1]!).getByRole("button", { name: "Start" })).toBeDisabled();
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Start" }));
    expect(attached).toEqual(["ws-lab2"]);
  });

  it("opens details for the workstation picked from the list", () => {
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
        onAttachWorkstation={() => {}}
        onSetDefaultWorkstation={(workstationId) => defaults.push(workstationId)}
      />,
    );

    const details = () => screen.getByRole("region", { name: "Workstation details" });
    const rows = () => screen.getAllByTestId("registered-workstation");

    // Expanded with nothing selected: details guide the reader to the list instead of showing facts.
    expect(rows().map((row) => row.dataset.selected)).toEqual(["false", "false"]);
    expandWorkstationDetails();
    expect(
      within(details()).getByText("Select a workstation above to see its details."),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Lab2/ }));
    expect(rows().map((row) => row.dataset.selected)).toEqual(["true", "false"]);
    expect(within(details()).getByText("id ws-lab2")).toBeVisible();
    expect(within(details()).getByText("/home/ubuntu/project")).toBeVisible();
    expect(
      within(details()).queryByText("Select a workstation above to see its details."),
    ).not.toBeInTheDocument();

    // Picking another workstation swaps the details and the selected row.
    fireEvent.click(screen.getByRole("button", { name: /Offline workstation/ }));
    expect(rows().map((row) => row.dataset.selected)).toEqual(["false", "true"]);
    expect(within(details()).getByText("id ws-offline")).toBeVisible();
    fireEvent.click(within(details()).getByRole("button", { name: "Set default" }));
    expect(defaults).toEqual(["ws-offline"]);
  });

  it("shows provider, agent build, and heartbeat facts in the details section", () => {
    const selection = projectNotebookWorkstationSelection({
      canSelectWorkstation: true,
      registeredWorkstations: [
        {
          id: "ws-lab2",
          displayName: "Lab2",
          provider: "runtime_peer",
          providerLabel: "Workstation agent",
          installedBuild: "2026.7.1",
          latestBuild: "2026.7.9",
          isOutdated: true,
          channel: "nightly",
          status: "offline",
          updatedAt: "2026-07-20T18:30:00.000Z",
        },
      ],
    });

    render(
      <NotebookWorkstationsPanel
        capabilities={readOnlyNotebookShellCapabilities}
        selection={selection}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Lab2/ }));
    const details = within(screen.getByRole("region", { name: "Workstation details" }));
    expect(details.getByText("Provider")).toBeVisible();
    expect(details.getByText("Workstation agent")).toBeVisible();
    expect(details.getByText("Agent build")).toBeVisible();
    expect(details.getByText("2026.7.1")).toBeVisible();
    expect(details.getByText("Update to 2026.7.9")).toBeVisible();
    expect(details.getByText("Channel")).toBeVisible();
    expect(details.getByText("nightly")).toBeVisible();
    expect(details.getByText("Last seen")).toBeVisible();
  });

  it("renders accelerator capability, attention diagnostics, known-none, unknown, and offline facts", () => {
    const gpu = {
      kind: "gpu",
      vendor: "NVIDIA",
      model: "A100",
      count: 1,
      memory_bytes_per_device: 80 * 1024 ** 3,
      readiness: "ready" as const,
    };
    const selection = projectNotebookWorkstationSelection({
      canSelectWorkstation: true,
      registeredWorkstations: [
        {
          id: "ws-gpu-ready",
          displayName: "Usable GPU",
          status: "online",
          defaultEnvironmentLabel: "Current Python",
          workingDirectory: "/workspace/ready",
          accelerators: [gpu],
        },
        {
          id: "ws-gpu-attention",
          displayName: "GPU attention",
          status: "online",
          defaultEnvironmentLabel: "Current Python",
          workingDirectory: "/workspace/attention",
          accelerators: [
            {
              ...gpu,
              readiness: "not_ready",
              diagnostic: "NVIDIA driver is not visible to the workstation service.",
            },
          ],
        },
        {
          id: "ws-known-none",
          displayName: "CPU workstation",
          status: "online",
          defaultEnvironmentLabel: "Current Python",
          workingDirectory: "/workspace/cpu",
          accelerators: [],
        },
        {
          id: "ws-legacy",
          displayName: "Older agent",
          status: "online",
          defaultEnvironmentLabel: "Current Python",
          workingDirectory: "/workspace/legacy",
          accelerators: null,
        },
        {
          id: "ws-offline-gpu",
          displayName: "Offline GPU",
          status: "offline",
          accelerators: [gpu],
        },
      ],
    });

    render(
      <NotebookWorkstationsPanel
        capabilities={readOnlyNotebookShellCapabilities}
        selection={selection}
      />,
    );

    // Facts live in the details section for whichever workstation the list selects.
    const details = () => screen.getByRole("region", { name: "Workstation details" });
    const selectRow = (name: string) => {
      const row = screen
        .getByRole("heading", { name })
        .closest('[data-testid="registered-workstation"]');
      expect(row).not.toBeNull();
      fireEvent.click(within(row!).getByRole("button"));
      return within(details());
    };

    expect(
      selectRow("Usable GPU").getByText("1× NVIDIA A100 · 80 GiB").closest("[data-tone]"),
    ).toHaveAttribute("data-tone", "positive");

    const attention = selectRow("GPU attention");
    expect(
      attention.getByText("NVIDIA driver is not visible to the workstation service."),
    ).toBeVisible();
    expect(attention.getByText("1× NVIDIA A100 · 80 GiB").closest("[data-tone]")).toHaveAttribute(
      "data-tone",
      "attention",
    );

    expect(selectRow("CPU workstation").queryByText("GPU")).not.toBeInTheDocument();
    expect(selectRow("Older agent").queryByText("GPU")).not.toBeInTheDocument();
    expect(screen.queryByText("No GPU")).not.toBeInTheDocument();

    const offline = selectRow("Offline GPU");
    expect(offline.getByText("1× NVIDIA A100 · 80 GiB").closest("[data-tone]")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    expect(offline.queryByText(/available/i)).not.toBeInTheDocument();
  });

  it("shows only the registered list when the cloud room has no compute session", () => {
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
          label: "No compute session",
          statusLabel: "Offline",
          detail: "Start compute from a user-owned workstation to run cells in this notebook.",
          providerLabel: "Cloud room",
          defaultEnvironmentLabel: "Not running",
          environmentLabel: "Not running",
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

    expect(screen.queryByText("No compute session")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Start compute from a user-owned workstation to run cells in this notebook.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Lab2" })).toBeVisible();
    // A per-workstation message never renders above the list.
    expect(
      screen.queryByText("No heartbeat from this workstation recently."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Lab2/ }));
    const details = within(screen.getByRole("region", { name: "Workstation details" }));
    expect(details.getByText("Current Python")).toBeVisible();
    expect(details.getByText("id ws-lab2")).toBeVisible();
    // The raw per-workstation message never renders; status is conveyed by the label.
    expect(
      screen.queryByText("No heartbeat from this workstation recently."),
    ).not.toBeInTheDocument();
  });

  it("lists the attached workstation alongside the other registered ones", () => {
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
          providerLabel: "Workstation",
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

    // The attached workstation appears once, in the list — not restated as a target section.
    expect(screen.getAllByRole("heading", { name: "Lab2" })).toHaveLength(1);
    expect(screen.getAllByTestId("registered-workstation")).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "Active workstation target" })).toBeNull();
    expect(screen.getByRole("heading", { name: "GPU host" })).toBeVisible();

    const details = () => within(screen.getByRole("region", { name: "Workstation details" }));
    fireEvent.click(screen.getByRole("button", { name: /Lab2/ }));
    expect(details().getByText("id ws-lab2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /GPU host/ }));
    expect(details().getByText("CUDA Python")).toBeVisible();
    expect(details().getByText("id ws-gpu")).toBeVisible();
  });

  it("keeps an online registered workstation actionable when a matching attachment is stale", () => {
    const attached: string[] = [];
    const capabilities: NotebookShellCapabilities = {
      ...readOnlyNotebookShellCapabilities,
      access: {
        ...readOnlyNotebookShellCapabilities.access,
        level: "owner",
        source: "cloud",
      },
      auth: {
        ...readOnlyNotebookShellCapabilities.auth,
        canUseAuthenticatedIdentity: true,
      },
      runtime: {
        ...readOnlyNotebookShellCapabilities.runtime,
        source: "cloud",
        target: {
          id: "ws-lab2",
          kind: "cloud_workstation",
          status: "attention",
          label: "Lab2",
          statusLabel: "Needs attention",
          detail:
            "runtime peer disconnected: runtime peer left the room and did not return within the grace window",
          providerLabel: "Workstation",
          defaultEnvironmentLabel: "Current Python",
          environmentLabel: "Current Python",
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
        status: "error",
        status_message:
          "runtime peer disconnected: runtime peer left the room and did not return within the grace window",
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
      ],
    });

    render(
      <NotebookWorkstationsPanel
        capabilities={capabilities}
        selection={selection}
        onAttachWorkstation={(workstationId) => attached.push(workstationId)}
        onSetDefaultWorkstation={() => {}}
      />,
    );

    expect(screen.queryByText("Previous compute session")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Lab2" })).toHaveLength(1);
    expect(screen.queryByText(/runtime peer disconnected/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Runtime peer")).not.toBeInTheDocument();
    const row = within(screen.getByTestId("registered-workstation"));
    expect(row.getByText("Online")).toBeVisible();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();

    const attachButton = row.getByRole("button", { name: "Start" });
    expect(attachButton).toBeEnabled();
    fireEvent.click(attachButton);
    expect(attached).toEqual(["ws-lab2"]);

    fireEvent.click(screen.getByRole("button", { name: /Lab2/ }));
    const details = within(screen.getByRole("region", { name: "Workstation details" }));
    expect(details.getAllByText("Current Python")).toHaveLength(1);
    expect(details.getAllByText("/home/ubuntu/project")).toHaveLength(1);
    expect(details.getAllByText("id ws-lab2")).toHaveLength(1);
  });

  it("never leaks implementation terms from a stale cloud attachment", () => {
    const capabilities: NotebookShellCapabilities = {
      ...readOnlyNotebookShellCapabilities,
      access: {
        ...readOnlyNotebookShellCapabilities.access,
        level: "viewer",
        source: "cloud",
      },
      runtime: {
        ...readOnlyNotebookShellCapabilities.runtime,
        source: "cloud",
        target: {
          id: "ws-lab2",
          kind: "cloud_workstation",
          status: "attention",
          label: "Lab2",
          statusLabel: "Needs attention",
          detail:
            "runtime peer disconnected: runtime peer left the room and did not return within the grace window",
          providerLabel: "Workstation",
          defaultEnvironmentLabel: "Current Python",
          environmentLabel: "Current Python",
          workingDirectoryLabel: "/home/ubuntu/project",
        },
      },
    };

    render(<NotebookWorkstationsPanel capabilities={capabilities} />);

    expect(screen.queryByText(/runtime peer disconnected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/grace window/i)).not.toBeInTheDocument();
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

    expandWorkstationDetails();

    expect(screen.getByText("Default env")).toBeVisible();
    expect(screen.getByText("Current Python")).toBeVisible();
    expect(screen.getByText("Resources")).toBeVisible();
    expect(screen.getByText("4 CPU / 16 GB RAM")).toBeVisible();
    expect(screen.getByText("Compute sessions")).toBeVisible();
    expect(screen.queryByText("Runtime peers")).not.toBeInTheDocument();
    expect(screen.getByText("1")).toBeVisible();
    expect(screen.queryByText("CPUs")).not.toBeInTheDocument();
    expect(screen.queryByText("RAM")).not.toBeInTheDocument();
  });

  it("offers Add workstation from the rail header and starts pairing", () => {
    const started: number[] = [];
    const { rerender } = render(
      <NotebookWorkstationsPanelAction onStartPairing={() => started.push(1)} />,
    );

    fireEvent.click(screen.getByTestId("workstation-add-button"));
    expect(started).toHaveLength(1);

    // The panel body never renders its own copy of the control.
    rerender(<NotebookWorkstationsPanel capabilities={localReadyCapabilities} />);
    expect(screen.queryByTestId("workstation-add-button")).not.toBeInTheDocument();
  });

  it("hides the header Add workstation control while the connect dialog is open", () => {
    render(<NotebookWorkstationsPanelAction pairingOpen onStartPairing={() => {}} />);

    expect(screen.queryByTestId("workstation-add-button")).not.toBeInTheDocument();
  });
});
