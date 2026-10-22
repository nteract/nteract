import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  LocalEnvironmentSelector,
  type LocalEnvironmentSelectorProps,
} from "../LocalEnvironmentSelector";

const rankings = {
  id: "rankings",
  name: "rankings",
  prefix: "/envs/Rankings Env",
  python_path: "/envs/Rankings Env/bin/python",
  python_version: "3.12",
};

function props(
  overrides: Partial<LocalEnvironmentSelectorProps> = {},
): LocalEnvironmentSelectorProps {
  return {
    available: true,
    selection: { revision: 2, selected: rankings, applied: null, applying: false },
    inventory: null,
    loadingSelection: false,
    loadingInventory: false,
    mutating: false,
    error: null,
    running: { id: null, name: "Automatic environment", pythonVersion: "3.13" },
    blocked: false,
    onLoadInventory: vi.fn(),
    onSelect: vi.fn(),
    onApply: vi.fn(),
    onRetrySelection: vi.fn(),
    ...overrides,
  };
}

describe("LocalEnvironmentSelector", () => {
  it("offers selection-read recovery without requiring an inventory scan", async () => {
    const options = props({ selection: null, error: "Connection failed" });
    render(<LocalEnvironmentSelector {...options} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(options.onRetrySelection).toHaveBeenCalledTimes(1);
    expect(options.onLoadInventory).not.toHaveBeenCalled();
  });

  it("separates running from pending selection and only discovers after Change", async () => {
    const user = userEvent.setup();
    const options = props();
    render(<LocalEnvironmentSelector {...options} />);
    expect(
      screen.getByText(/Running: Automatic environment · Python 3.13 · Next: rankings/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply and restart" })).toBeEnabled();
    expect(options.onLoadInventory).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(options.onLoadInventory).toHaveBeenCalledWith(false);
  });

  it("keeps the default summary compact and gives scroll ownership to the Packages rail", () => {
    const { container } = render(<LocalEnvironmentSelector {...props()} />);
    const environment = screen.getByTestId("environment-selector");
    expect(environment).toHaveClass("space-y-2", "border-b", "pb-3");
    expect(screen.getByRole("button", { name: "Change" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(environment.querySelectorAll("[class*=overflow-y-auto]")).toHaveLength(0);
    expect(container.querySelectorAll('[aria-label="Selected for next start"]')).toHaveLength(0);
  });

  it("offers Automatic as an explicit pending target with Apply", async () => {
    const options = props({
      selection: { revision: 3, selected: null, applied: rankings, applying: false },
      running: { id: rankings.id, name: rankings.name, pythonVersion: "3.12" },
    });
    render(<LocalEnvironmentSelector {...options} />);
    expect(screen.getByText(/Next: Automatic/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Apply and restart" }));
    expect(options.onApply).toHaveBeenCalledWith(3);
  });

  it("starts when stopped and does not offer restart for the running selection", () => {
    const options = props({ running: null });
    const { rerender } = render(<LocalEnvironmentSelector {...options} />);
    expect(screen.getByRole("button", { name: "Start kernel" })).toBeEnabled();
    rerender(
      <LocalEnvironmentSelector
        {...props({ running: { id: rankings.id, name: rankings.name, pythonVersion: "3.12" } })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Apply and restart" })).toBeNull();
  });

  it("accepts an absolute prefix with spaces as path data and presents inventory warnings", async () => {
    const user = userEvent.setup();
    const options = props({
      inventory: {
        environments: [rankings],
        truncated: true,
        warnings: ["Some roots are unavailable"],
      },
    });
    render(<LocalEnvironmentSelector {...options} />);
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByText("Some roots are unavailable")).toBeVisible();
    expect(screen.getByText(/not all environments/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Enter prefix..." }));
    await user.type(
      screen.getByRole("textbox", { name: "Conda environment prefix" }),
      "C:\\Env Root\\rankings",
    );
    await user.click(screen.getByRole("button", { name: "Select prefix" }));
    expect(options.onSelect).toHaveBeenCalledWith({
      kind: "conda",
      prefix: "C:\\Env Root\\rankings",
    });
  });

  it("leaves an unavailable selector visible without sending requests", () => {
    const options = props({ available: false });
    render(<LocalEnvironmentSelector {...options} />);
    expect(screen.getByText(/does not support local environment selection/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(options.onLoadInventory).not.toHaveBeenCalled();
  });

  it("disables selection and Apply while busy or applying and exposes persistent errors", () => {
    render(
      <LocalEnvironmentSelector
        {...props({ blocked: true, error: "Prefix is no longer available" })}
      />,
    );
    expect(screen.getByRole("button", { name: "Apply and restart" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Prefix is no longer available");
  });

  it("keeps the environment selector focused on selection rather than inventory", async () => {
    const options = props({
      running: { id: "conda:existing:local", name: "rankings", pythonVersion: "3.12" },
      installedPackages: { packages: [], truncated: false, warnings: [] },
      onLoadInstalledPackages: vi.fn(),
    });
    render(<LocalEnvironmentSelector {...options} />);
    expect(screen.getByText(/Running: rankings/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /installed packages/i })).toBeNull();
    expect(options.onLoadInstalledPackages).not.toHaveBeenCalled();
  });
});
