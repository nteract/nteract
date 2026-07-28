import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import type { NotebookWorkstationLaunchReadinessState } from "../capabilities";
import {
  WorkstationComputeNotice,
  shouldShowWorkstationComputeNotice,
} from "../WorkstationComputeNotice";

const ALL_STATES: readonly NotebookWorkstationLaunchReadinessState[] = [
  "ready",
  "idle_attached",
  "attaching",
  "limited",
  "needs_registration",
  "needs_selection",
  "needs_attachment",
  "workstation_unavailable",
  "unavailable",
];

describe("shouldShowWorkstationComputeNotice", () => {
  it("shows only for needs_registration when the viewer may register", () => {
    const shown = ALL_STATES.filter((launchReadinessState) =>
      shouldShowWorkstationComputeNotice({
        canRegisterWorkstation: true,
        launchReadinessState,
      }),
    );
    expect(shown).toEqual(["needs_registration"]);
  });

  it("stays quiet for a viewer that cannot register a workstation", () => {
    const shown = ALL_STATES.filter((launchReadinessState) =>
      shouldShowWorkstationComputeNotice({
        canRegisterWorkstation: false,
        launchReadinessState,
      }),
    );
    expect(shown).toEqual([]);
  });
});

describe("WorkstationComputeNotice", () => {
  it("explains the missing compute and offers to connect one", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    render(<WorkstationComputeNotice onConnect={onConnect} />);

    expect(screen.getByTestId("workstation-compute-notice")).toBeVisible();
    expect(screen.getByText("No compute connected.")).toBeVisible();
    await user.click(screen.getByTestId("workstation-compute-notice-action"));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});
