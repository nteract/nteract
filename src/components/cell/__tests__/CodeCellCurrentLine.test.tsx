import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { CodeCellCurrentLine } from "../CodeCellCurrentLine";

describe("CodeCellCurrentLine", () => {
  it("keeps idle language quiet until the cell is engaged", () => {
    const { container } = render(
      <CodeCellCurrentLine
        languageLabel="Python"
        count={null}
        onExecute={() => undefined}
        onInterrupt={() => undefined}
      />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');

    expect(footer).toHaveAttribute("data-execution-state", "idle");
    expect(status).toHaveTextContent("Python·Ready");
    expect(status).toHaveClass("max-w-0");
    expect(status).toHaveClass("opacity-0");
    expect(rule).toHaveClass("bg-transparent");
  });

  it("shows idle language when the cell is focused", () => {
    const { container } = render(
      <CodeCellCurrentLine
        languageLabel="Python"
        count={null}
        isFocused
        onExecute={() => undefined}
        onInterrupt={() => undefined}
      />,
    );

    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');

    expect(status).toHaveTextContent("Python·Ready");
    expect(status).toHaveClass("max-w-64");
    expect(status).toHaveClass("opacity-100");
    expect(status).not.toHaveClass("max-w-0");
  });

  it("separates active running status from the destructive stop control", () => {
    const onInterrupt = vi.fn();
    const { container } = render(
      <CodeCellCurrentLine
        languageLabel="Python"
        count={12}
        isExecuting
        submittedByActorLabel="local:kyle"
        onExecute={() => undefined}
        onInterrupt={onInterrupt}
      />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');
    const status = container.querySelector('[data-slot="code-cell-current-line-status"]');
    const rule = container.querySelector('[data-slot="code-cell-current-line-rule"]');
    const stopButton = screen.getByRole("button", {
      name: "Stop execution submitted by local:kyle",
    });

    expect(footer).toHaveAttribute("data-execution-state", "running");
    expect(status).toHaveTextContent("Python·Run 12, running");
    expect(status).toHaveClass("text-primary");
    expect(rule).toHaveClass("bg-primary/45");
    expect(stopButton).toHaveClass("text-destructive");

    fireEvent.click(stopButton);

    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("keeps completed runs readable without notebook prompt syntax", () => {
    const { container } = render(
      <CodeCellCurrentLine
        languageLabel="Python"
        count={12}
        elapsedMs={1476}
        onExecute={() => undefined}
        onInterrupt={() => undefined}
      />,
    );

    const footer = container.querySelector('[data-slot="code-cell-current-line"]');

    expect(footer).toHaveAttribute("data-execution-label", "Execution 12");
    expect(footer?.textContent?.replace(/\s+/g, "")).toContain("Python·Run12,completedin1.5s");
    expect(footer).not.toHaveTextContent("In [12]");
  });
});
