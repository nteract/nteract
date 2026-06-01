import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { NotebookPresenceStatus } from "../NotebookPresenceStatus";

describe("NotebookPresenceStatus", () => {
  it("renders shared presence copy with mode context", () => {
    const { container } = render(
      <NotebookPresenceStatus
        connected
        label="2 viewing"
        modeLabel="editing"
        title="2 connected viewers"
      />,
    );

    expect(screen.getByText("2 viewing · editing")).toBeVisible();
    expect(screen.getByLabelText("2 connected viewers")).toHaveAttribute("data-connected", "true");
    expect(container.querySelector("[data-slot='notebook-presence-status']")).toHaveAttribute(
      "title",
      "2 connected viewers; editing",
    );
  });

  it("does not invent mode copy when the host has no mode label", () => {
    render(<NotebookPresenceStatus label="Offline" title="No live room connection" />);

    expect(screen.getByText("Offline")).toBeVisible();
    expect(screen.getByLabelText("No live room connection")).toHaveAttribute(
      "data-connected",
      "false",
    );
  });
});
