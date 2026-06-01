import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import {
  CellPresenceIndicators,
  formatCellPresenceTooltip,
  type CellPresencePeer,
} from "../CellPresenceIndicators";

const peers: CellPresencePeer[] = [
  { peerId: "ada", peerLabel: "Ada", color: "#0ea5e9" },
  { peerId: "ben", peerLabel: "Ben", color: "#10b981" },
  { peerId: "cara", peerLabel: "Cara", color: "#a855f7" },
];

describe("CellPresenceIndicators", () => {
  it("renders peer dots from adapter-provided presence data", () => {
    const { container } = render(
      <CellPresenceIndicators peers={peers} variant="inline" prefixSeparator className="extra" />,
    );

    const indicators = container.querySelector('[data-slot="cell-presence-indicators"]');
    expect(indicators).toHaveClass("flex-row");
    expect(indicators).toHaveClass("extra");
    expect(indicators).toHaveAccessibleName("Ada, Ben, Cara");
    expect(screen.getByText("·")).toBeInTheDocument();
    expect(container.querySelectorAll(".rounded-full")).toHaveLength(3);
  });

  it("summarizes overflow peers", () => {
    render(<CellPresenceIndicators peers={peers} maxVisible={2} />);

    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("does not render without peers", () => {
    const { container } = render(<CellPresenceIndicators peers={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("formats labels for unnamed peers", () => {
    expect(
      formatCellPresenceTooltip([
        { peerId: "one", color: "#0ea5e9" },
        { peerId: "two", color: "#10b981" },
      ]),
    ).toBe("2 peers");
  });
});
