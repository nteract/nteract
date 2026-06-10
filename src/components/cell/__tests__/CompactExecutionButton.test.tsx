import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CompactExecutionButton } from "../CompactExecutionButton";

describe("CompactExecutionButton", () => {
  it("uses shared actor projection labels for queued execution attribution", () => {
    render(
      <CompactExecutionButton
        count={1}
        isQueued
        submittedByActorLabel="user:anaconda:kyle/browser:cloud"
      />,
    );

    expect(screen.getByRole("button", { name: "Queued for execution by Kyle" })).toBeTruthy();
  });

  it("uses delegated operator labels for active execution attribution", () => {
    render(
      <CompactExecutionButton
        count={1}
        isExecuting
        submittedByActorLabel="user:anaconda:kyle/agent:codex:s1"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Stop execution submitted by Codex for Kyle" }),
    ).toBeTruthy();
  });

  it("renders no control for non-executable execution history by default", () => {
    const { container } = render(<CompactExecutionButton count={7} canExecute={false} />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("execution-readout")).toBeNull();
  });

  it("can render disabled execution history as a status readout", () => {
    render(<CompactExecutionButton count={7} canExecute={false} showReadoutWhenDisabled />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status", { name: "Last execution 7" })).toBeTruthy();
    expect(screen.getByTestId("execution-readout")).toHaveAttribute("data-execution-state", "ran");
  });

  it("renders cancelled executions as neutral, not failed", () => {
    render(<CompactExecutionButton count={null} isCancelled />);

    const button = screen.getByRole("button", {
      name: "Run cell; last execution was cancelled before it ran",
    });
    expect(button).toHaveAttribute("data-execution-state", "cancelled");
    expect(button.className).not.toContain("text-destructive");
  });

  it("keeps errored executions distinct from cancelled ones", () => {
    render(<CompactExecutionButton count={3} isErrored />);

    const button = screen.getByRole("button", {
      name: "Run cell again; last execution 3 failed",
    });
    expect(button).toHaveAttribute("data-execution-state", "error");
  });
});
