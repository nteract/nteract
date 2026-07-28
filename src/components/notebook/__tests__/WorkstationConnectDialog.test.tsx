import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { WorkstationConnectDialog } from "../WorkstationConnectDialog";

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

describe("WorkstationConnectDialog", () => {
  it("stays closed with no pairing", () => {
    render(<WorkstationConnectDialog pairing={null} />);
    expect(screen.queryByTestId("workstation-connect-dialog")).not.toBeInTheDocument();
  });

  it("renders the pending pairing code, commands, and countdown", () => {
    render(
      <WorkstationConnectDialog
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

    expect(screen.getByTestId("workstation-connect-dialog")).toBeVisible();
    expect(screen.getByText("ABCD-EFGH-JKMN")).toBeVisible();
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
      <WorkstationConnectDialog
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
      <WorkstationConnectDialog
        pairing={{ ...pairingBase, status: "redeemed" }}
        onCancel={() => dismissed.push(1)}
      />,
    );
    expect(screen.getByTestId("workstation-pairing-status")).toHaveTextContent(/Machine connected/);

    rerender(
      <WorkstationConnectDialog
        pairing={{ ...pairingBase, status: "registered", workstationName: "Hub devbox" }}
        onCancel={() => dismissed.push(1)}
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
      <WorkstationConnectDialog
        pairing={{
          code: "ABCD-EFGH-JKMN",
          connectCommand: "runt workstation connect https://cloud.test --code ABCD-EFGH-JKMN",
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          status: "expired",
          workstationName: null,
          error: null,
        }}
        onRestart={() => restarted.push(1)}
      />,
    );

    expect(screen.getByTestId("workstation-pairing-status")).toHaveTextContent(
      /pairing code expired/i,
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate a new code" }));
    expect(restarted).toHaveLength(1);
  });
});
