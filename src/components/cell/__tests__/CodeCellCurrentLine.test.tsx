import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
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
    expect(rule).toHaveClass("text-sky-500/55");
    expect(rule?.querySelector("svg")).toHaveClass("animate-exec-signal-wave");
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
