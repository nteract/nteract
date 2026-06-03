import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import { UvDependencyPanel as DependencyHeader } from "@/components/environment";

function renderDependencyHeader(props: Partial<Parameters<typeof DependencyHeader>[0]> = {}) {
  const defaults = {
    dependencies: [],
    requiresPython: null,
    loading: false,
    onAdd: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    onSetRequiresPython: vi.fn().mockResolvedValue(undefined),
  };

  return render(<DependencyHeader {...defaults} {...props} />);
}

describe("DependencyHeader", () => {
  it("commits a trimmed Python constraint on Enter", async () => {
    const user = userEvent.setup();
    const onSetRequiresPython = vi.fn().mockResolvedValue(undefined);
    renderDependencyHeader({ onSetRequiresPython });

    await user.type(screen.getByTestId("uv-python-input"), "  >=3.12,<3.13  {Enter}");

    await waitFor(() => {
      expect(onSetRequiresPython).toHaveBeenCalledWith(">=3.12,<3.13");
    });
  });

  it("clears the Python constraint when the field is emptied", async () => {
    const user = userEvent.setup();
    const onSetRequiresPython = vi.fn().mockResolvedValue(undefined);
    renderDependencyHeader({ requiresPython: ">=3.13", onSetRequiresPython });

    const input = screen.getByTestId("uv-python-input");
    await user.clear(input);
    fireEvent.blur(input);

    await waitFor(() => {
      expect(onSetRequiresPython).toHaveBeenCalledWith(null);
    });
  });

  it("keeps dependency actions wired in the rail variant", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn().mockResolvedValue(undefined);
    renderDependencyHeader({
      variant: "rail",
      dependencies: ["pandas", "polars"],
      onAdd,
    });

    expect(screen.getByTestId("deps-panel").getAttribute("data-variant")).toBe("rail");
    expect(screen.queryByText("2 packages")).not.toBeInTheDocument();

    await user.type(screen.getByTestId("deps-add-input"), "  numpy  {Enter}");

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith("numpy");
    });
  });
});
