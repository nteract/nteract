import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ManagedPythonPackages } from "../ManagedPythonPackages";

const props = {
  requirements: ["six==1.16.0"],
  installed: ["six==1.16.0", "numpy==2.2.5"],
  phase: "ready" as const,
  readOnly: false,
  onAdd: vi.fn(async () => true),
  onRemove: vi.fn(async () => {}),
};

describe("managed Python package controls", () => {
  it("submits Enter once while pending and preserves the input after failure", async () => {
    let finish!: (value: boolean) => void;
    const onAdd = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ManagedPythonPackages {...props} onAdd={onAdd} />);
    fireEvent.change(screen.getByLabelText("Add a package"), { target: { value: "six>=2,<3" } });
    const form = screen.getByLabelText("Add a package").closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onAdd).toHaveBeenCalledExactlyOnceWith("six>=2,<3");
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
    await act(async () => finish(false));
    expect(screen.getByLabelText("Add a package")).toHaveValue("six>=2,<3");
    expect(screen.getByRole("region", { name: "Saved requirements" })).toHaveTextContent("six");
  });

  it("never offers install/remove/restart actions to a peer", () => {
    render(<ManagedPythonPackages {...props} readOnly needsRestart onRestart={vi.fn()} />);
    expect(screen.queryByLabelText("Add a package")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Only the notebook owner/)).toBeInTheDocument();
  });

  it("keeps failed state and installed observations separate from saved requirements", () => {
    render(
      <ManagedPythonPackages
        {...props}
        requirements={[]}
        phase="error"
        error="Installation failed."
        needsRestart
        onRestart={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Installation failed.");
    expect(screen.getByRole("region", { name: "Saved requirements" })).toHaveTextContent(
      "No packages added.",
    );
    expect(screen.getByText("Installed in this session (2)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restart Python" })).toBeEnabled();
  });

  it("offers explicit clearing while a broken saved environment cannot start", async () => {
    const onClear = vi.fn(async () => {});
    render(
      <ManagedPythonPackages
        {...props}
        phase="unavailable"
        needsRestart
        error="Saved packages cannot be restored."
        onClear={onClear}
      />,
    );
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Clear saved packages" })),
    );
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Saved requirements" })).toHaveTextContent("six");
  });

  it("announces restore admission waiting without exposing an error or enabling edits", () => {
    render(
      <ManagedPythonPackages
        {...props}
        phase="restoring"
        progressMessage="Waiting for another package installation…"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for another package installation…",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Add a package")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove six==1.16.0" })).toBeDisabled();
  });

  it.each(["resolving", "installing", "restoring"] as const)(
    "disables Enter and removal while %s",
    (phase) => {
      const onAdd = vi.fn();
      render(<ManagedPythonPackages {...props} phase={phase} onAdd={onAdd} />);
      expect(screen.getByLabelText("Add a package")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Remove six==1.16.0" })).toBeDisabled();
      fireEvent.submit(screen.getByLabelText("Add a package").closest("form")!);
      expect(onAdd).not.toHaveBeenCalled();
    },
  );
});
