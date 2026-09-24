import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { PyodideDependencyPanel } from "@/components/environment";

describe("PyodideDependencyPanel", () => {
  it("renders declared packages and the micropip provenance note", () => {
    render(
      <PyodideDependencyPanel
        dependencies={["numpy", "pandas>=2"]}
        loading={false}
        variant="rail"
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText("micropip packages")).toBeVisible();
    expect(screen.getByText("numpy")).toBeVisible();
    expect(screen.getByText(/installed by micropip when the pyodide runtime starts/)).toBeVisible();
  });

  it("calls onAdd with the trimmed package name", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    render(
      <PyodideDependencyPanel
        dependencies={[]}
        loading={false}
        variant="rail"
        onAdd={onAdd}
        onRemove={vi.fn()}
      />,
    );

    const input = screen.getByPlaceholderText(/package name/);
    fireEvent.change(input, { target: { value: "  pandas  " } });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("pandas"));
  });

  it("does not call onAdd for blank input", () => {
    const onAdd = vi.fn();
    render(
      <PyodideDependencyPanel
        dependencies={[]}
        loading={false}
        variant="rail"
        onAdd={onAdd}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/package name/), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /Add/ }));

    expect(onAdd).not.toHaveBeenCalled();
  });

  it("hides add controls when read-only", () => {
    render(
      <PyodideDependencyPanel
        dependencies={["numpy"]}
        loading={false}
        variant="rail"
        readOnly
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.queryByPlaceholderText(/package name/)).toBeNull();
  });
});
