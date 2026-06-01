import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { HistorySearchDialogView, type HistorySearchEntry } from "../HistorySearchDialogView";

const entries: HistorySearchEntry[] = [
  {
    session: 4,
    line: 20,
    source: "model.fit(features, target)",
  },
  {
    session: 4,
    line: 12,
    source: "orders.head()",
  },
];

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    media: "",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));

  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  Element.prototype.scrollIntoView = vi.fn();
});

describe("HistorySearchDialogView", () => {
  it("filters entries with the controlled search value and selects an entry", () => {
    const onSearchValueChange = vi.fn();
    const onSelectEntry = vi.fn();

    render(
      <HistorySearchDialogView
        open
        onOpenChange={() => {}}
        entries={entries}
        isLoading={false}
        error={null}
        searchValue="fit"
        onSearchValueChange={onSearchValueChange}
        onSelectEntry={onSelectEntry}
      />,
    );

    expect(document.body).toHaveTextContent("model.fit");
    expect(document.body).not.toHaveTextContent("orders.head");

    fireEvent.change(screen.getByPlaceholderText("Search history..."), {
      target: { value: "orders" },
    });
    expect(onSearchValueChange).toHaveBeenCalledWith("orders");

    const item = [...document.querySelectorAll("[cmdk-item]")].find((element) =>
      element.textContent?.includes("model.fit"),
    );
    expect(item).toBeTruthy();
    fireEvent.click(item!);
    expect(onSelectEntry).toHaveBeenCalledWith(entries[0]);
  });

  it("renders useful empty states", () => {
    const { rerender } = render(
      <HistorySearchDialogView
        open
        onOpenChange={() => {}}
        entries={[]}
        isLoading
        error={null}
        searchValue=""
        onSearchValueChange={() => {}}
        onSelectEntry={() => {}}
      />,
    );

    expect(screen.getByText("Searching history...")).toBeVisible();

    rerender(
      <HistorySearchDialogView
        open
        onOpenChange={() => {}}
        entries={[]}
        isLoading={false}
        error="No kernel running"
        searchValue=""
        onSearchValueChange={() => {}}
        onSelectEntry={() => {}}
      />,
    );

    expect(screen.getByText("Start a kernel to search history.")).toBeVisible();
  });
});
