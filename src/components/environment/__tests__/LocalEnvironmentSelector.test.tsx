import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InstalledKernelspec, KernelspecCatalogState } from "runtimed";
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
    expect(screen.getByText("Running: Automatic environment · Python 3.13")).toBeVisible();
    expect(screen.getByText("Next: rankings · not applied")).toBeVisible();
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

  describe("installed Jupyter kernels", () => {
    const julia: InstalledKernelspec = {
      name: "julia-1.11",
      display_name: "Julia 1.11",
      language: "julia",
    };
    const ir: InstalledKernelspec = { name: "ir", display_name: "R", language: "R" };
    const ready: KernelspecCatalogState = {
      status: "ready",
      seq: 2,
      inventory: { kernelspecs: [julia, ir], warnings: [], truncated: false },
    };

    it("hides kernels and requests none when the daemon lacks the capability", async () => {
      const user = userEvent.setup();
      for (const kernelspecCatalog of [undefined, { status: "unsupported", seq: 1 } as const]) {
        const options = props({
          kernelspecCatalog,
          onLoadKernelspecs: vi.fn(),
          inventory: { environments: [rankings], truncated: false, warnings: [] },
        });
        const { unmount } = render(<LocalEnvironmentSelector {...options} />);
        await user.click(screen.getByRole("button", { name: "Change" }));
        expect(options.onLoadInventory).toHaveBeenCalledWith(false);
        expect(options.onLoadKernelspecs).not.toHaveBeenCalled();
        expect(screen.queryByText("Jupyter kernels")).toBeNull();
        expect(screen.getByRole("list", { name: "Available Conda environments" })).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Refresh" }));
        expect(options.onLoadKernelspecs).not.toHaveBeenCalled();
        unmount();
      }
    });

    it("lists kernels after Change, Automatic first, and stages one by name", async () => {
      const user = userEvent.setup();
      const options = props({
        kernelspecCatalog: ready,
        onLoadKernelspecs: vi.fn(),
        inventory: { environments: [rankings], truncated: false, warnings: [] },
      });
      render(<LocalEnvironmentSelector {...options} />);
      expect(options.onLoadKernelspecs).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Change" }));
      expect(options.onLoadKernelspecs).toHaveBeenCalledTimes(1);
      const choices = screen.getAllByRole("button").map((button) => button.textContent);
      expect(choices.indexOf("Automatic")).toBeLessThan(
        choices.findIndex((text) => text?.includes("rankings")),
      );
      expect(choices.findIndex((text) => text?.includes("rankings"))).toBeLessThan(
        choices.findIndex((text) => text?.includes("Julia 1.11")),
      );
      const kernels = screen.getByRole("list", { name: "Installed Jupyter kernels" });
      expect(kernels).toHaveTextContent("julia · julia-1.11");
      await user.click(screen.getByRole("button", { name: /Julia 1\.11/ }));
      expect(options.onSelect).toHaveBeenCalledWith({ kind: "kernelspec", name: "julia-1.11" });
    });

    it("shows a staged kernel as next, not as running, until it is applied", () => {
      const options = props({
        kernelspecCatalog: ready,
        selection: {
          revision: 4,
          selected: null,
          applied: rankings,
          selected_kernelspec: julia,
          applying: false,
        },
        running: { id: rankings.id, name: rankings.name, pythonVersion: "3.12" },
      });
      render(<LocalEnvironmentSelector {...options} />);
      expect(screen.getByText("Running: rankings · Python 3.12")).toBeVisible();
      expect(screen.getByText("Next: Julia 1.11 · not applied")).toBeVisible();
      expect(screen.getByRole("button", { name: "Apply and restart" })).toBeEnabled();
    });

    it("shows the running kernel's language and no Python version once applied", () => {
      const options = props({
        kernelspecCatalog: ready,
        selection: {
          revision: 5,
          selected: null,
          applied: null,
          selected_kernelspec: julia,
          applied_kernelspec: julia,
          applying: false,
        },
        running: {
          id: "kernelspec:julia-1.11",
          name: "Julia 1.11",
          pythonVersion: null,
          language: "julia",
        },
      });
      render(<LocalEnvironmentSelector {...options} />);
      expect(screen.getByText("Running: Julia 1.11 · julia")).toBeVisible();
      expect(screen.getByText("Next: Julia 1.11")).toBeVisible();
      expect(screen.queryByText(/Python/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Apply and restart" })).toBeNull();
    });

    it("does not claim the staged kernel is running while it starts", () => {
      const options = props({
        kernelspecCatalog: ready,
        selection: {
          revision: 6,
          selected: null,
          applied: null,
          selected_kernelspec: julia,
          applying: true,
        },
        running: null,
      });
      render(<LocalEnvironmentSelector {...options} />);
      expect(screen.getByText("Starting kernel")).toBeVisible();
      expect(screen.queryByText(/Running:/)).toBeNull();
      expect(screen.getByText("Next: Julia 1.11")).toBeVisible();
      expect(screen.getByRole("button", { name: "Applying..." })).toBeDisabled();
    });

    it("offers Conda and Automatic after a kernel, staging each explicitly", async () => {
      const user = userEvent.setup();
      const options = props({
        kernelspecCatalog: ready,
        inventory: { environments: [rankings], truncated: false, warnings: [] },
        selection: {
          revision: 7,
          selected: null,
          applied: null,
          selected_kernelspec: julia,
          applied_kernelspec: julia,
          applying: false,
        },
        running: { id: "kernelspec:julia-1.11", name: "Julia 1.11", pythonVersion: null },
      });
      render(<LocalEnvironmentSelector {...options} />);
      await user.click(screen.getByRole("button", { name: "Change" }));
      expect(screen.getByRole("button", { name: /Julia 1\.11/ })).toHaveAttribute(
        "aria-current",
        "true",
      );
      expect(screen.getByRole("button", { name: /Julia 1\.11/ })).toHaveTextContent(
        "Running · Next",
      );
      await user.click(screen.getByRole("button", { name: /rankings/ }));
      await user.click(screen.getByRole("button", { name: "Automatic" }));
      expect(vi.mocked(options.onSelect).mock.calls).toEqual([
        [{ kind: "conda", prefix: rankings.prefix }],
        [{ kind: "automatic" }],
      ]);
    });

    it("reports a staged kernel that is no longer installed and keeps it selected", async () => {
      const options = props({
        kernelspecCatalog: {
          status: "ready",
          seq: 3,
          inventory: { kernelspecs: [ir], warnings: [], truncated: false },
        },
        selection: {
          revision: 8,
          selected: null,
          applied: null,
          selected_kernelspec: julia,
          applying: false,
        },
        error: "Kernelspec julia-1.11 is not installed",
      });
      render(<LocalEnvironmentSelector {...options} />);
      const alerts = screen.getAllByRole("alert").map((alert) => alert.textContent);
      expect(alerts).toContainEqual(expect.stringContaining('"Julia 1.11" is not installed'));
      expect(alerts).toContain("Kernelspec julia-1.11 is not installed");
      expect(screen.getByText("Next: Julia 1.11 · not applied")).toBeVisible();
      expect(options.onSelect).not.toHaveBeenCalled();
    });

    it("does not call a kernel missing from a truncated or unloaded listing", () => {
      const selection = {
        revision: 8,
        selected: null,
        applied: null,
        selected_kernelspec: julia,
        applying: false,
      };
      const catalogs: KernelspecCatalogState[] = [
        { status: "idle", seq: 1 },
        { status: "loading", seq: 2, inventory: null },
        {
          status: "ready",
          seq: 2,
          inventory: { kernelspecs: [ir], warnings: [], truncated: true },
        },
      ];
      for (const kernelspecCatalog of catalogs) {
        const { unmount } = render(
          <LocalEnvironmentSelector {...props({ kernelspecCatalog, selection })} />,
        );
        expect(screen.queryByRole("alert")).toBeNull();
        unmount();
      }
    });

    it("presents listing warnings, truncation, empty and failed states", async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <LocalEnvironmentSelector
          {...props({
            kernelspecCatalog: {
              status: "ready",
              seq: 2,
              inventory: {
                kernelspecs: [],
                warnings: ["One kernel directory could not be read"],
                truncated: true,
              },
            },
          })}
        />,
      );
      await user.click(screen.getByRole("button", { name: "Change" }));
      expect(screen.getByText("No installed Jupyter kernels found.")).toBeVisible();
      expect(screen.getByText("One kernel directory could not be read")).toBeVisible();
      expect(screen.getByText("Not all installed kernels are listed.")).toBeVisible();
      rerender(
        <LocalEnvironmentSelector
          {...props({
            kernelspecCatalog: {
              status: "failed",
              seq: 3,
              inventory: null,
              error: "Kernel directory unreadable",
            },
          })}
        />,
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Installed kernels could not be listed: Kernel directory unreadable",
      );
    });

    it("reads snapshots from a daemon that sends no kernelspec fields", () => {
      render(
        <LocalEnvironmentSelector
          {...props({
            kernelspecCatalog: ready,
            selection: { revision: 3, selected: null, applied: rankings, applying: false },
            running: { id: rankings.id, name: rankings.name, pythonVersion: "3.12" },
          })}
        />,
      );
      expect(screen.getByText("Next: Automatic · not applied")).toBeVisible();
    });

    it("wraps long kernel names instead of widening a narrow rail", async () => {
      const long: InstalledKernelspec = {
        name: "conda-env-research-platform-forecasting-py312-gpu",
        display_name: "Python 3.12 (research-platform-forecasting, GPU build)",
        language: "python",
      };
      render(
        <div style={{ width: 240 }}>
          <LocalEnvironmentSelector
            {...props({
              kernelspecCatalog: {
                status: "ready",
                seq: 2,
                inventory: { kernelspecs: [long], warnings: [], truncated: false },
              },
              selection: {
                revision: 2,
                selected: null,
                applied: null,
                selected_kernelspec: long,
                applying: false,
              },
            })}
          />
        </div>,
      );
      expect(screen.getByText(/^Next: Python 3\.12/)).toHaveClass("break-words");
      await userEvent.click(screen.getByRole("button", { name: "Change" }));
      const choice = screen.getByRole("button", { name: /research-platform-forecasting/ });
      expect(choice).toHaveClass("w-full");
      expect(choice.querySelector(".break-words")).toHaveTextContent(long.display_name);
      expect(choice.querySelector(".break-all")).toHaveTextContent(long.name);
      expect(screen.getByRole("button", { name: "Done" })).toHaveClass("shrink-0");
    });
  });
});
