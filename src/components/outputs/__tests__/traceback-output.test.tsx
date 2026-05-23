import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TracebackOutput } from "../traceback-output";

const payload = {
  ename: "AttributeError",
  evalue: "module 'pandas' has no attribute 'not_real'",
  execution: {
    execution_id: "exec-run",
    execution_count: 3,
  },
  frames: [
    {
      filename: "/var/folders/x/T/ipykernel_39879/258099874.py",
      lineno: 1,
      name: "<module>",
      execution_id: "exec-run",
      execution_count: 3,
      source_ref: {
        kind: "notebook_execution",
        execution_id: "exec-run",
        execution_count: 3,
        compiled_filename: "/var/folders/x/T/ipykernel_39879/258099874.py",
      },
      lines: [{ lineno: 1, source: "g()", highlight: true }],
    },
    {
      filename: "/var/folders/x/T/ipykernel_39879/3398808089.py",
      lineno: 5,
      name: "g",
      execution_id: "exec-def",
      execution_count: 2,
      source_ref: {
        kind: "notebook_execution",
        execution_id: "exec-def",
        execution_count: 2,
        compiled_filename: "/var/folders/x/T/ipykernel_39879/3398808089.py",
      },
      lines: [{ lineno: 5, source: "pd.not_real()", highlight: true }],
    },
  ],
  text: "Traceback (most recent call last):\n  Line 1 in Current Cell\n    g()\n  Line 5 in Cell cell-def, in g\n    pd.not_real()\nAttributeError: module 'pandas' has no attribute 'not_real'",
  raw_text:
    "Traceback (most recent call last):\n  File \"/var/folders/x/T/ipykernel_39879/258099874.py\", line 1, in <module>\n    g()\n  File \"/var/folders/x/T/ipykernel_39879/3398808089.py\", line 5, in g\n    pd.not_real()\nAttributeError: module 'pandas' has no attribute 'not_real'",
};

const resolveExecutionTarget = (executionId: string) => {
  if (executionId === "exec-run") return { cellId: "cell-run" };
  if (executionId === "exec-def") return { cellId: "cell-def" };
  return null;
};

describe("TracebackOutput", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  });

  it("renders notebook source labels instead of synthetic ipykernel paths", () => {
    const { container } = render(
      <TracebackOutput data={payload} resolveExecutionTarget={resolveExecutionTarget} />,
    );

    expect(container.textContent).toContain("Line1inCurrent Cell");
    expect(container.textContent).toContain("Line5inCell cell-defing");
    expect(container.textContent).not.toContain("In[");
    expect(container.textContent).not.toContain("/var/folders/x/T/ipykernel_39879");
  });

  it("shortens displayed Python package paths", () => {
    const { container } = render(
      <TracebackOutput
        data={{
          ename: "ColumnNotFoundError",
          evalue: "missing column",
          frames: [
            {
              filename:
                "/Users/kylekelley/Library/Caches/runt-nightly/inline-envs/f446e2ef9c92b4c9/lib/python3.13/site-packages/polars/lazyframe/frame.py",
              lineno: 2630,
              name: "collect",
              library: true,
              lines: [{ lineno: 2630, source: "return wrap_df(ldf.collect())", highlight: true }],
            },
          ],
          language: "python",
        }}
      />,
    );

    expect(container.textContent).toContain("Line2630inpython/polars/lazyframe/frame.pyincollect");
    expect(container.textContent).not.toContain("/Users/kylekelley/Library/Caches");
  });

  it("keeps non-Python source paths unchanged when they look package-like", () => {
    const filename = "/Users/kyle/project/site-packages/example/runtime/frame.jl";
    const { container } = render(
      <TracebackOutput
        data={{
          ename: "RuntimeError",
          evalue: "bad module",
          frames: [
            {
              filename,
              lineno: 7,
              name: "load",
              library: true,
              lines: [{ lineno: 7, source: "await load()", highlight: true }],
            },
          ],
          language: "typescript",
        }}
      />,
    );

    expect(container.textContent).toContain(
      "Line7in/Users/kyle/project/site-packages/example/runtime/frame.jlinload",
    );
    expect(container.textContent).not.toContain("python/example/runtime/frame.jl");
  });

  it("does not throw when a frame has a malformed filename", () => {
    const { container } = render(
      <TracebackOutput
        data={{
          ename: "RuntimeError",
          evalue: "bad frame",
          frames: [
            {
              filename: { path: "/tmp/not-a-string.py" },
              lineno: 7,
              name: "load",
              library: true,
              lines: [{ lineno: 7, source: "load()", highlight: true }],
            },
          ],
          language: "python",
        }}
      />,
    );

    expect(container.textContent).toContain("Line7inUnknown sourceinload");
  });

  it("navigates to a resolved traceback cell", () => {
    const onNavigateToCell = vi.fn();

    render(
      <TracebackOutput
        data={payload}
        resolveExecutionTarget={resolveExecutionTarget}
        onNavigateToCell={onNavigateToCell}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Go to cell cell-def" }));

    expect(onNavigateToCell).toHaveBeenCalledWith({ cellId: "cell-def" });
  });

  it("copies the sanitized traceback text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<TracebackOutput data={payload} resolveExecutionTarget={resolveExecutionTarget} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy traceback" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain("Line 1 in Current Cell (cell_id=cell-run, execution_id=exec-run)");
    expect(copied).toContain(
      "Line 5 in Cell cell-def (cell_id=cell-def, execution_id=exec-def), in g",
    );
    expect(copied).not.toContain("In[");
    expect(copied).not.toContain("/var/folders/x/T/ipykernel_39879");
  });
});
