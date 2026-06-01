import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { NotebookPresenceStatus } from "../NotebookPresenceStatus";

describe("NotebookPresenceStatus", () => {
  it("renders shared presence copy with mode context", () => {
    const { container } = render(
      <NotebookPresenceStatus
        connected
        label="2 here now"
        modeLabel="editing is allowed"
        title="2 participants are in this notebook"
      />,
    );

    expect(screen.getByText("2 here now, editing is allowed")).toBeVisible();
    expect(screen.getByLabelText("2 participants are in this notebook")).toHaveAttribute(
      "data-connected",
      "true",
    );
    expect(container.querySelector("[data-slot='notebook-presence-status']")).toHaveAttribute(
      "title",
      "2 participants are in this notebook. editing is allowed",
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
