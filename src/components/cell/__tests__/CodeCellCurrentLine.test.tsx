import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { CodeCellCurrentLine } from "../CodeCellCurrentLine";

describe("CodeCellCurrentLine", () => {
  it("keeps idle language in the stable right readout slot", () => {
    const { container } = render(<CodeCellCurrentLine languageLabel="Python" count={null} />);

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const languageContext = container.querySelector(
      '[data-slot="code-cell-current-line-language-context"]',
    );
    const detail = container.querySelector('[data-slot="code-cell-current-line-detail"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer).toHaveAttribute("data-execution-state", "idle");
    expect(footer).toHaveClass("min-h-4");
    expect(status).toHaveTextContent("Python/ready");
    expect(status).toHaveClass("max-w-64");
    expect(status).toHaveClass("opacity-100");
    expect(languageContext).toHaveClass("max-w-0");
    expect(languageContext).toHaveClass("opacity-0");
    expect(languageContext).toHaveClass("group-hover:max-w-20");
    expect(detail).toHaveClass("max-w-0");
    expect(detail).toHaveClass("opacity-0");
    expect(detail).toHaveClass("group-hover:max-w-16");
    expect(rule).toHaveClass("bg-border/15");
    expect(rule).toHaveClass("flex-1");
    expect(rule?.compareDocumentPosition(status as Element)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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

  it("keeps focused idle language pinned while ready stays a quiet caption", () => {
    const { container } = render(
      <CodeCellCurrentLine languageLabel="Python" count={null} isFocused />,
    );

    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const languageContext = container.querySelector(
      '[data-slot="code-cell-current-line-language-context"]',
    );
    const detail = container.querySelector('[data-slot="code-cell-current-line-detail"]');

    expect(status).toHaveTextContent("Python/ready");
    expect(status).toHaveClass("max-w-64");
    expect(status).toHaveClass("opacity-100");
    expect(languageContext).toHaveClass("max-w-0");
    expect(languageContext).toHaveClass("opacity-0");
    expect(languageContext).toHaveClass("group-focus-within:max-w-20");
    expect(detail).toHaveClass("max-w-0");
    expect(detail).toHaveClass("opacity-0");
    expect(detail).toHaveClass("group-focus-within:max-w-16");
  });

  it("keeps initial running state visually quiet while execution settles", () => {
    const { container } = render(
      <CodeCellCurrentLine languageLabel="Python" count={12} isExecuting />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const detail = container.querySelector('[data-slot="code-cell-current-line-detail"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer).toHaveAttribute("data-execution-state", "running");
    expect(footer).toHaveAttribute("data-execution-visual-state", "ran");
    expect(footer).toHaveClass("min-h-4");
    expect(status).toHaveTextContent("Python/run 12");
    expect(status).toHaveAttribute("aria-label", "Python: Running");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(detail).toHaveClass("text-muted-foreground/70");
    expect(detail).not.toHaveClass("text-emerald-700");
    expect(rule).toHaveClass("bg-border/15");
    expect(rule?.compareDocumentPosition(status as Element)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(rule).not.toHaveAttribute("data-execution-signal");
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

      expect(
        container.querySelector('[data-slot="code-cell-current-line-status"]'),
      ).toHaveTextContent("Python/run 12");
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

      const footer = container.querySelector('[data-slot="code-cell-current-line"]');
      const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
      let rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');
      let signal = container.querySelector('[data-slot="code-cell-current-line-signal"]');

      expect(footer).toHaveAttribute("data-execution-visual-state", "running");
      expect(status).toHaveTextContent("Python/running");
      expect(rule).toHaveAttribute("data-execution-signal", "active");
      expect(signal).toHaveClass("animate-exec-signal-build");
      expect(
        rule?.querySelector('[data-slot="code-cell-current-line-resting-rule"]'),
      ).not.toBeInTheDocument();
      const wave = rule?.querySelector("svg path");
      expect(wave).toHaveAttribute("d", expect.stringMatching(/^M0\.00 /));
      expect(rule?.querySelector("svg")).not.toHaveClass("animate-exec-signal-wave");
      const firstWavePath = wave?.getAttribute("d");

      act(() => {
        vi.advanceTimersByTime(48);
      });

      expect(rule?.querySelector("svg path")?.getAttribute("d")).not.toEqual(firstWavePath);

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

  it("lets failed state interrupt the running settle affordance", () => {
    vi.useFakeTimers();

    try {
      const { container, rerender } = render(
        <CodeCellCurrentLine languageLabel="Python" count={12} isExecuting />,
      );

      act(() => {
        vi.advanceTimersByTime(120);
      });

      rerender(<CodeCellCurrentLine languageLabel="Python" count={13} isErrored />);

      const footer = container.querySelector('[data-slot="code-cell-current-line"]');
      const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
      const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

      expect(footer).toHaveAttribute("data-execution-state", "error");
      expect(footer).toHaveAttribute("data-execution-visual-state", "error");
      expect(status).toHaveTextContent("Python/failed");
      expect(rule).toHaveClass("text-destructive/60");
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
    const detail = container.querySelector('[data-slot="code-cell-current-line-detail"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer).toHaveAttribute("data-execution-state", "queued");
    expect(status).toHaveTextContent("Python/queued");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(detail).toHaveClass("text-sky-700");
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
    const detail = container.querySelector('[data-slot="code-cell-current-line-detail"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer).toHaveAttribute("data-execution-state", "error");
    expect(status).toHaveTextContent("Python/failed");
    expect(status).toHaveAttribute("aria-label", "Python: Run 12 failed");
    expect(detail).toHaveClass("text-destructive/80");
    expect(rule).toHaveClass("text-destructive/60");
  });

  it("keeps completed runs available without notebook prompt syntax", () => {
    const { container } = render(
      <CodeCellCurrentLine languageLabel="Python" count={12} elapsedMs={1476} isFocused />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const languageContext = container.querySelector(
      '[data-slot="code-cell-current-line-language-context"]',
    );
    const detail = container.querySelector('[data-slot="code-cell-current-line-detail"]');

    expect(footer).toHaveAttribute("data-execution-label", "Execution 12");
    expect(footer?.textContent?.replace(/\s+/g, "")).toContain("Python/run12·1.5s");
    expect(footer).not.toHaveTextContent("In [12]");
    expect(status).toHaveClass("max-w-64");
    expect(languageContext).toHaveClass("max-w-0");
    expect(languageContext).toHaveClass("group-hover:max-w-20");
    expect(detail).toHaveClass("max-w-64");
  });

  it("keeps completed metadata in the same right readout slot", () => {
    const { container } = render(<CodeCellCurrentLine languageLabel="Python" count={12} />);

    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const languageContext = container.querySelector(
      '[data-slot="code-cell-current-line-language-context"]',
    );
    const detail = container.querySelector('[data-slot="code-cell-current-line-detail"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(status).toHaveTextContent("Python/run 12");
    expect(status).toHaveClass("max-w-64");
    expect(status).toHaveClass("opacity-100");
    expect(status).toHaveAttribute("aria-label", "Python: Run 12 completed");
    expect(languageContext).toHaveClass("max-w-0");
    expect(languageContext).toHaveClass("group-hover:max-w-20");
    expect(detail).toHaveClass("max-w-0");
    expect(detail).toHaveClass("opacity-0");
    expect(detail).toHaveClass("group-hover:max-w-40");
    expect(rule).toHaveClass("flex-1");
    expect(rule?.compareDocumentPosition(status as Element)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("shows completed metadata immediately for the focused cell", () => {
    const { container } = render(
      <CodeCellCurrentLine languageLabel="Python" count={12} isFocused />,
    );

    const detail = container.querySelector('[data-slot="code-cell-current-line-detail"]');

    expect(detail).toHaveClass("max-w-64");
    expect(detail).toHaveClass("group-hover:max-w-64");
    expect(detail).not.toHaveClass("group-hover:max-w-40");
    expect(detail).toHaveClass("opacity-100");
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
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');

    expect(footer).toHaveTextContent("Kyle");
    expect(activity).toHaveClass("max-w-0");
    expect(status?.compareDocumentPosition(activity as Element)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByTestId("peer-activity")).toBeInTheDocument();
  });
});
