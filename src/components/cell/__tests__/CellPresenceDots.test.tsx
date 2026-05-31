import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { CellPresenceDots } from "../CellPresenceDots";

const peers = [
  { peerId: "alice", peerLabel: "Alice", color: "#0ea5e9" },
  { peerId: "bob", peerLabel: "Bob", color: "#22c55e" },
  { peerId: "carol", peerLabel: "Carol", color: "#f97316" },
  { peerId: "dana", peerLabel: "Dana", color: "#a855f7" },
] as const;

describe("CellPresenceDots", () => {
  it("renders labeled peer dots with overflow", () => {
    render(<CellPresenceDots peers={peers} maxVisible={2} />);

    expect(screen.getByLabelText("Alice, Bob, Carol, Dana")).toBeVisible();
    expect(screen.getByTitle("Alice")).toBeVisible();
    expect(screen.getByTitle("Bob")).toBeVisible();
    expect(screen.getByText("+2")).toBeVisible();
  });

  it("can render inline with a prefix separator", () => {
    const { container } = render(
      <CellPresenceDots peers={peers.slice(0, 1)} variant="inline" prefixSeparator />,
    );

    expect(screen.getByLabelText("Alice")).toBeVisible();
    expect(container.textContent).toContain("·");
  });

  it("renders nothing without peers", () => {
    const { container } = render(<CellPresenceDots peers={[]} />);

    expect(container.firstChild).toBeNull();
  });
});
