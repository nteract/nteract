import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { CodeCellCurrentLine } from "../CodeCellCurrentLine";

describe("CodeCellCurrentLine", () => {
  it("keeps idle language quiet until the cell is engaged", () => {
    const { container } = render(<CodeCellCurrentLine languageLabel="Python" count={null} />);

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer).toHaveAttribute("data-execution-state", "idle");
    expect(footer).toHaveClass("min-h-4");
    expect(status).toHaveTextContent("Python·Ready");
    expect(status).toHaveClass("max-w-0");
    expect(status).toHaveClass("opacity-0");
    expect(rule).toHaveClass("bg-border/15");
  });

  it("keeps blank idle cells slim without separator chrome", () => {
    const { container } = render(
      <CodeCellCurrentLine languageLabel="Python" count={null} compactIdle isFocused />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const detail = container.querySelector('[data-slot="code-cell-current-line-detail"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer).toHaveClass("min-h-3.5");
    expect(detail).toHaveClass("sr-only");
    expect(rule).toBeNull();
  });

  it("keeps focused idle language collapsed into the boundary", () => {
    const { container } = render(
      <CodeCellCurrentLine languageLabel="Python" count={null} isFocused />,
    );

    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');

    expect(status).toHaveTextContent("Python·Ready");
    expect(status).toHaveClass("max-w-0");
    expect(status).toHaveClass("opacity-0");
    expect(status).toHaveClass("group-focus-within:max-w-64");
  });

  it("separates active running status from the execution control lane", () => {
    const { container } = render(
      <CodeCellCurrentLine languageLabel="Python" count={12} isExecuting />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer).toHaveAttribute("data-execution-state", "running");
    expect(status).toHaveTextContent("Python·Running");
    expect(status).toHaveAttribute("aria-label", "Python: Running");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveClass("text-primary");
    expect(rule).toHaveClass("text-emerald-500/65");
    expect(rule).toHaveAttribute("data-execution-signal", "building");
    expect(
      rule?.querySelector('[data-slot="code-cell-current-line-resting-rule"]'),
    ).toBeInTheDocument();
    expect(rule?.querySelector("svg")).toBeNull();
  });

  it("delays the running wave so fast executions do not flicker", () => {
    vi.useFakeTimers();

    try {
      const { container, rerender } = render(
        <CodeCellCurrentLine languageLabel="Python" count={12} isExecuting />,
      );

      act(() => {
        vi.advanceTimersByTime(119);
      });

      expect(container.querySelector('[data-slot="code-cell-current-line-rule"] svg')).toBeNull();

      rerender(<CodeCellCurrentLine languageLabel="Python" count={13} />);

      const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');
      expect(rule).not.toHaveAttribute("data-execution-signal");
      expect(rule?.querySelector("svg")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds up and settles the running wave after sustained execution", () => {
    vi.useFakeTimers();

    try {
      const { container, rerender } = render(
        <CodeCellCurrentLine languageLabel="Python" count={12} isExecuting />,
      );

      act(() => {
        vi.advanceTimersByTime(120);
      });

      let rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');
      let signal = container.querySelector('[data-slot="code-cell-current-line-signal"]');

      expect(rule).toHaveAttribute("data-execution-signal", "active");
      expect(signal).toHaveClass("animate-exec-signal-build");
      expect(
        rule?.querySelector('[data-slot="code-cell-current-line-resting-rule"]'),
      ).not.toBeInTheDocument();
      expect(rule?.querySelector("svg")).toHaveClass("animate-exec-signal-wave");

      rerender(<CodeCellCurrentLine languageLabel="Python" count={13} />);

      rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');
      signal = container.querySelector('[data-slot="code-cell-current-line-signal"]');

      expect(rule).toHaveAttribute("data-execution-signal", "settling");
      expect(signal).toHaveClass("animate-exec-signal-settle");
      expect(
        rule?.querySelector('[data-slot="code-cell-current-line-resting-rule"]'),
      ).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(320);
      });

      rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');
      expect(rule).not.toHaveAttribute("data-execution-signal");
      expect(rule?.querySelector("svg")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives queued cells a pending boundary", () => {
    const { container } = render(
      <CodeCellCurrentLine languageLabel="Python" count={12} isQueued />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer).toHaveAttribute("data-execution-state", "queued");
    expect(status).toHaveTextContent("Python·Queued");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(rule).toHaveClass("bg-sky-400/45");
    expect(rule).toHaveAttribute("data-queue-priority", "0.35");
    expect(rule).toHaveClass("animate-queue-boundary-pulse");
    expect(rule?.querySelectorAll(".animate-queue-breathe")).toHaveLength(0);
  });

  it("uses queue priority to tune the pending pulse", () => {
    const { container } = render(
      <CodeCellCurrentLine languageLabel="Python" count={12} isQueued queuePriority={1} />,
    );

    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(rule).toHaveAttribute("data-queue-priority", "1.00");
    expect(rule).toHaveStyle({
      "--queue-pulse-duration": "1450ms",
      "--queue-pulse-low": "0.44",
      "--queue-pulse-high": "0.76",
    });
  });

  it("gives errored cells a broken boundary", () => {
    const { container } = render(
      <CodeCellCurrentLine languageLabel="Python" count={12} isErrored />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer).toHaveAttribute("data-execution-state", "error");
    expect(status).toHaveTextContent("Python·Run 12 failed");
    expect(status).toHaveAttribute("aria-label", "Python: Run 12 failed");
    expect(status).toHaveClass("text-destructive/80");
    expect(rule).toHaveClass("text-destructive/60");
  });

  it("keeps completed runs available without notebook prompt syntax", () => {
    const { container } = render(
      <CodeCellCurrentLine languageLabel="Python" count={12} elapsedMs={1476} isFocused />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');

    expect(footer).toHaveAttribute("data-execution-label", "Execution 12");
    expect(footer?.textContent?.replace(/\s+/g, "")).toContain("Python·Run12·1.5s");
    expect(footer).not.toHaveTextContent("In [12]");
    expect(status).toHaveClass("max-w-0");
  });

  it("keeps completed metadata quiet until the cell is engaged", () => {
    const { container } = render(<CodeCellCurrentLine languageLabel="Python" count={12} />);

    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');

    expect(status).toHaveTextContent("Python·Run 12");
    expect(status).toHaveClass("max-w-0");
    expect(status).toHaveClass("opacity-0");
    expect(status).toHaveAttribute("aria-label", "Python: Run 12 completed");
  });

  it("can carry activity context after the run state", () => {
    const { container } = render(
      <CodeCellCurrentLine
        languageLabel="Python"
        count={12}
        activityContent={<span data-testid="peer-activity">Kyle</span>}
      />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');

    const activity = container.querySelector('[data-slot="code-cell-current-line-activity"]');

    expect(footer).toHaveTextContent("Kyle");
    expect(activity).toHaveClass("max-w-0");
    expect(screen.getByTestId("peer-activity")).toBeInTheDocument();
  });
});
