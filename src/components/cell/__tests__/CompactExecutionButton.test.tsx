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

  it("renders non-executable execution history as a status readout instead of a button", () => {
    render(<CompactExecutionButton count={7} canExecute={false} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status", { name: "Last execution 7" })).toBeTruthy();
    expect(screen.getByTestId("execution-readout")).toHaveAttribute("data-execution-state", "ran");
  });
});
