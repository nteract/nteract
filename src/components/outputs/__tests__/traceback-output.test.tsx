import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { classicTracebackToPayload, TracebackOutput } from "../traceback-output";

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

    expect(container.textContent).toContain("current cell · line 1");
    expect(container.textContent).toContain("g · line 5");
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

    expect(container.textContent).toContain(".../polars/lazyframe/frame.py · line 2630 / collect");
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
      "/Users/kyle/project/site-packages/example/runtime/frame.jl · line 7 / load",
    );
    expect(container.textContent).not.toContain(".../example/runtime/frame.jl");
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

    expect(container.textContent).toContain("Unknown source · line 7 / load");
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
    fireEvent.click(screen.getByRole("button", { name: "Go to cell that defines g, line 5" }));

    expect(onNavigateToCell).toHaveBeenCalledWith({
      cellId: "cell-def",
      line: 5,
      label: "cell defining g",
    });
  });

  it("uses structured cell ids when execution lookup is unavailable", () => {
    const onNavigateToCell = vi.fn();

    render(
      <TracebackOutput
        data={{
          ename: "IndexError",
          evalue: "list index out of range",
          frames: [
            {
              filename: "/var/folders/x/T/ipykernel_39879/3398808089.py",
              lineno: 12,
              name: "image_scatter_records",
              cell_id: "cell-helper",
              source_ref: {
                kind: "notebook_execution",
                cell_id: "cell-helper",
                execution_id: "exec-helper",
                compiled_filename: "/var/folders/x/T/ipykernel_39879/3398808089.py",
              },
              lines: [{ lineno: 12, source: 'row["images"][0]', highlight: true }],
            },
          ],
        }}
        onNavigateToCell={onNavigateToCell}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Go to cell that defines image_scatter_records, line 12",
      }),
    );

    expect(onNavigateToCell).toHaveBeenCalledWith({
      cellId: "cell-helper",
      line: 12,
      label: "cell defining image_scatter_records",
    });
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
    expect(copied).toContain("Line 5 in run 2 (cell_id=cell-def, execution_id=exec-def), in g");
    expect(copied).not.toContain("In[");
    expect(copied).not.toContain("/var/folders/x/T/ipykernel_39879");
  });

  it("normalizes classic notebook traceback preview lines into rich frame data", () => {
    const normalized = classicTracebackToPayload({
      ename: "AttributeError",
      evalue: "'NoneType' object has no attribute 'strip'",
      traceback: [
        "Traceback (most recent call last):",
        "  Line 2 in Cell cell-run (cell_id=cell-run, execution_id=exec-run, source_hash=sha256:abc)",
        "    summarize(records)",
        "  Line 2 in Cell cell-helper (cell_id=cell-helper, execution_id=exec-helper, source_hash=sha256:def), in summarize",
        "        return [normalize(record) for record in records]",
        "AttributeError: 'NoneType' object has no attribute 'strip'",
      ],
    });

    render(
      <TracebackOutput
        data={normalized}
        resolveExecutionTarget={(executionId) =>
          executionId === "exec-helper" ? { cellId: "cell-helper", label: "run 2" } : null
        }
      />,
    );

    expect(screen.getByRole("button", { name: "Show source frame 1" })).toHaveTextContent(
      "cell input · line 2",
    );
    expect(screen.getByRole("button", { name: "Show source frame 2" })).toHaveTextContent(
      "summarize · line 2",
    );
  });
});
