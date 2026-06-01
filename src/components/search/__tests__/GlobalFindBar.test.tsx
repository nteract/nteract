import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { GlobalFindBar } from "../GlobalFindBar";

describe("GlobalFindBar", () => {
  it("renders match position and keyboard navigation controls", () => {
    const onQueryChange = vi.fn();
    const onNextMatch = vi.fn();
    const onPrevMatch = vi.fn();
    const onClose = vi.fn();

    render(
      <GlobalFindBar
        query="orders"
        matchCount={4}
        currentMatchIndex={1}
        onQueryChange={onQueryChange}
        onNextMatch={onNextMatch}
        onPrevMatch={onPrevMatch}
        onClose={onClose}
      />,
    );

    const input = screen.getByLabelText("Search notebook");
    expect(screen.getByText("2 of 4")).toBeVisible();

    fireEvent.change(input, { target: { value: "profit" } });
    expect(onQueryChange).toHaveBeenCalledWith("profit");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNextMatch).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onPrevMatch).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables match navigation when no matches are available", () => {
    render(
      <GlobalFindBar
        query="missing"
        matchCount={0}
        currentMatchIndex={0}
        onQueryChange={() => {}}
        onNextMatch={() => {}}
        onPrevMatch={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("No results")).toBeVisible();
    expect(screen.getByLabelText("Previous match")).toBeDisabled();
    expect(screen.getByLabelText("Next match")).toBeDisabled();
  });
});
