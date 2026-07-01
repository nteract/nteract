import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { NotebookShellCapabilities } from "../capabilities";
import {
  projectNotebookWorkstationSelection,
  readOnlyNotebookShellCapabilities,
} from "../capabilities";
import { NotebookWorkstationsPanel } from "../NotebookWorkstationsPanel";

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

const cloudPairingCommands = [
  {
    id: "debian-prep",
    label: "Fresh Debian/Ubuntu only",
    command: "sudo apt update && sudo apt install -y curl tmux",
    optional: true,
  },
  {
    id: "install",
    label: "Install nteract headless",
    command: "curl --proto '=https' --tlsv1.2 -sSf https://sh.nteract.io | bash -s -- --headless",
  },
  {
    id: "path",
    label: "Use installed CLI in this shell",
    command: 'export PATH="$HOME/.local/bin:$PATH"',
  },
  {
    id: "connect",
    label: "Pair this workstation",
    command: "runt workstation connect https://cloud.test --code ABCD-EFGH-JKMN",
  },
  {
    id: "run",
    label: "Linux user systemd service",
    command: "runt workstation service install --start",
  },
  {
    id: "foreground-run",
    label: "macOS/non-systemd fallback",
    command: "runt workstation run",
    optional: true,
  },
];

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

    expect(screen.queryByText("workstation:none")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No compute session" })).toBeVisible();
    expect(screen.getByText("Offline")).toBeVisible();
    expect(
      screen.getByText(
        "Start compute from a user-owned workstation to run cells in this notebook.",
      ),
    ).toBeVisible();
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
    const attachButtons = screen.getAllByRole("button", { name: "Start" });
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

    expect(screen.getByRole("heading", { name: "No compute session" })).toBeVisible();
    expect(
      screen.getByText(
        "Start compute from a user-owned workstation to run cells in this notebook.",
      ),
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

    expect(screen.getByRole("heading", { name: "Lab2" })).toBeVisible();
    expect(screen.getAllByText("Workstation")).toHaveLength(1);
    expect(screen.getAllByText("Current Python")).toHaveLength(1);
    expect(screen.getByText("id ws-lab2")).toBeVisible();
    expect(screen.getAllByTestId("registered-workstation")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "GPU host" })).toBeVisible();
    expect(screen.getByText("CUDA Python")).toBeVisible();
    expect(screen.getByText("id ws-gpu")).toBeVisible();
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

    expect(screen.getByRole("heading", { name: "Previous compute session" })).toBeVisible();
    expect(screen.getAllByRole("heading", { name: "Lab2" })).toHaveLength(1);
    expect(screen.getByText("Needs attention")).toBeVisible();
    expect(
      screen.getByText(
        "Compute from Lab2 is no longer connected to this notebook. Start compute again from an available workstation.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/runtime peer disconnected/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Runtime peer")).not.toBeInTheDocument();
    expect(screen.getAllByText("Current Python")).toHaveLength(1);
    expect(screen.getAllByText("/home/ubuntu/project")).toHaveLength(1);
    expect(screen.getAllByText("id ws-lab2")).toHaveLength(1);
    expect(screen.getByTestId("registered-workstation")).toBeVisible();
    expect(screen.getByText("Online")).toBeVisible();
    expect(screen.getByText("Default")).toBeVisible();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    const attachButton = screen.getByRole("button", { name: "Start" });
    expect(attachButton).toBeEnabled();
    fireEvent.click(attachButton);
    expect(attached).toEqual(["ws-lab2"]);
  });

  it("explains stale cloud attachments to viewers without implementation terms", () => {
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

    expect(screen.getByRole("heading", { name: "Previous compute session" })).toBeVisible();
    expect(
      screen.getByText(
        "Compute from Lab2 is no longer connected to this notebook. The owner can start compute again from an available workstation.",
      ),
    ).toBeVisible();
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

    expect(screen.getByRole("heading", { name: "Remote devbox" })).toBeVisible();
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

  it("offers Add workstation and starts pairing", () => {
    const started: number[] = [];
    render(
      <NotebookWorkstationsPanel
        capabilities={localReadyCapabilities}
        onStartPairing={() => started.push(1)}
      />,
    );

    const addButton = screen.getByTestId("workstation-add-button");
    fireEvent.click(addButton);
    expect(started).toHaveLength(1);
  });

  it("renders the pending pairing card with the connect command and countdown", () => {
    render(
      <NotebookWorkstationsPanel
        capabilities={localReadyCapabilities}
        pairing={{
          code: "ABCD-EFGH-JKMN",
          connectCommand: "runt workstation connect https://cloud.test --code ABCD-EFGH-JKMN",
          commands: cloudPairingCommands,
          expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
          status: "pending",
          workstationName: null,
          error: null,
        }}
      />,
    );

    expect(screen.getByTestId("workstation-pairing-command-list")).toBeVisible();
    expect(screen.getByText("Install nteract headless")).toBeVisible();
    expect(screen.getByText("Use installed CLI in this shell")).toBeVisible();
    expect(screen.getByText("Pair this workstation")).toBeVisible();
    expect(screen.getByText("Linux user systemd service")).toBeVisible();
    expect(screen.queryByText("Fresh Debian/Ubuntu only")).toBeNull();
    expect(screen.queryByText("macOS/non-systemd fallback")).toBeNull();
    const commands = screen.getAllByTestId("workstation-pairing-command");
    expect(commands.map((command) => command.textContent)).toEqual([
      "curl --proto '=https' --tlsv1.2 -sSf https://sh.nteract.io | bash -s -- --headless",
      'export PATH="$HOME/.local/bin:$PATH"',
      "runt workstation connect https://cloud.test --code ABCD-EFGH-JKMN",
      "runt workstation service install --start",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Show additional setup options" }));
    const additionalCommands = within(
      screen.getByTestId("workstation-pairing-additional-commands"),
    );
    expect(additionalCommands.getByText("Fresh Debian/Ubuntu only")).toBeVisible();
    expect(additionalCommands.getByText("macOS/non-systemd fallback")).toBeVisible();
    expect(additionalCommands.getAllByText("(optional)")).toHaveLength(2);
    expect(
      additionalCommands
        .getAllByTestId("workstation-pairing-command")
        .map((command) => command.textContent),
    ).toEqual(["sudo apt update && sudo apt install -y curl tmux", "runt workstation run"]);
    expect(screen.getByTestId("workstation-pairing-status")).toHaveTextContent(
      /Waiting for the machine to connect/,
    );
    expect(screen.getByTestId("workstation-pairing-status")).toHaveTextContent(
      /Code expires in 8:5\d/,
    );
    expect(
      screen.getByRole("button", { name: "Copy Linux workstation setup commands" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Copy Pair this workstation command" }),
    ).toBeVisible();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(screen.getByRole("button", { name: "Copy Linux workstation setup commands" }));
    expect(writeText).toHaveBeenCalledWith(
      [
        "curl --proto '=https' --tlsv1.2 -sSf https://sh.nteract.io | bash -s -- --headless",
        'export PATH="$HOME/.local/bin:$PATH"',
        "runt workstation connect https://cloud.test --code ABCD-EFGH-JKMN",
        "runt workstation service install --start",
      ].join("\n"),
    );
  });

  it("keeps the single-command pairing fallback generic", () => {
    render(
      <NotebookWorkstationsPanel
        capabilities={localReadyCapabilities}
        pairing={{
          code: "ABCD-EFGH-JKMN",
          connectCommand: "runt workstation connect https://cloud.test --code ABCD-EFGH-JKMN",
          expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
          status: "pending",
          workstationName: null,
          error: null,
        }}
      />,
    );

    expect(
      screen.getByText("Run this in a terminal on the machine you want to attach:"),
    ).toBeVisible();
    expect(
      screen.getByText("Keep the command running until the workstation appears in the panel."),
    ).toBeVisible();
    expect(screen.queryByText(/service command/i)).toBeNull();
    expect(
      screen.getAllByTestId("workstation-pairing-command").map((node) => node.textContent),
    ).toEqual(["runt workstation connect https://cloud.test --code ABCD-EFGH-JKMN"]);
  });

  it("announces redemption and registration, and Done dismisses", () => {
    const dismissed: number[] = [];
    const pairingBase = {
      code: "ABCD-EFGH-JKMN",
      connectCommand: "runt workstation connect https://cloud.test --code ABCD-EFGH-JKMN",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      commands: cloudPairingCommands,
      workstationName: null,
      error: null,
    };
    const { rerender } = render(
      <NotebookWorkstationsPanel
        capabilities={localReadyCapabilities}
        pairing={{ ...pairingBase, status: "redeemed" }}
        onCancelPairing={() => dismissed.push(1)}
      />,
    );
    expect(screen.getByTestId("workstation-pairing-status")).toHaveTextContent(/Machine connected/);

    rerender(
      <NotebookWorkstationsPanel
        capabilities={localReadyCapabilities}
        pairing={{ ...pairingBase, status: "registered", workstationName: "Hub devbox" }}
        onCancelPairing={() => dismissed.push(1)}
      />,
    );
    expect(screen.getByTestId("workstation-pairing-status")).toHaveTextContent(
      "Hub devbox is connected.",
    );
    expect(
      screen.getByText("Finish setup with the keep-available command if you have not run it yet:"),
    ).toBeVisible();
    expect(screen.getByText("Linux user systemd service")).toBeVisible();
    expect(screen.queryByText("macOS/non-systemd fallback")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show additional setup options" }));
    expect(screen.getByText("macOS/non-systemd fallback")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(dismissed).toHaveLength(1);
  });

  it("offers a fresh code when the pairing expires", () => {
    const restarted: number[] = [];
    render(
      <NotebookWorkstationsPanel
        capabilities={localReadyCapabilities}
        pairing={{
          code: "ABCD-EFGH-JKMN",
          connectCommand: "runt workstation connect https://cloud.test --code ABCD-EFGH-JKMN",
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          status: "expired",
          workstationName: null,
          error: null,
        }}
        onStartPairing={() => restarted.push(1)}
      />,
    );

    expect(screen.getByTestId("workstation-pairing-status")).toHaveTextContent(
      /pairing code expired/i,
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate a new code" }));
    expect(restarted).toHaveLength(1);
  });
});
