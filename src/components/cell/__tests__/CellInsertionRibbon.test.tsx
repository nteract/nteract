import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { CellInsertionRibbon } from "../CellInsertionRibbon";

describe("CellInsertionRibbon", () => {
  it("reveals code insertion intent and calls the insert handler", () => {
    const onInsert = vi.fn();
    const { container } = render(<CellInsertionRibbon onInsert={onInsert} />);

    expect(container.querySelector('[data-slot="cell-adder-ribbon-intent"]')).toBeNull();

    const addCodeButton = screen.getByTitle("Add code cell");
    fireEvent.pointerEnter(addCodeButton);
    fireEvent.click(addCodeButton);

    const intent = container.querySelector('[data-slot="cell-adder-ribbon-intent"]');
    expect(intent).toHaveClass("bg-sky-400");
    expect(onInsert).toHaveBeenCalledWith("code");
  });

  it("uses the left insertion channel as a primary code target", () => {
    const onInsert = vi.fn();
    const { container } = render(<CellInsertionRibbon onInsert={onInsert} />);

    const hitTarget = container.querySelector('[data-slot="cell-adder-primary-hit-target"]');
    expect(hitTarget).toHaveClass("w-[var(--cell-content-column-inset,3.25rem)]");

    fireEvent.pointerEnter(hitTarget!);
    fireEvent.click(hitTarget!);

    const intent = container.querySelector('[data-slot="cell-adder-ribbon-intent"]');
    expect(intent).toHaveClass("bg-sky-400");
    expect(onInsert).toHaveBeenCalledWith("code");
  });

  it("uses the controlled active type for catalog fixtures", () => {
    const { container } = render(
      <CellInsertionRibbon activeType="markdown" forceActionsVisible onInsert={() => undefined} />,
    );

    const actions = container.querySelector('[data-slot="cell-adder-actions"]');
    const intent = container.querySelector('[data-slot="cell-adder-ribbon-intent"]');

    expect(actions).toHaveClass("opacity-100");
    expect(intent).toHaveClass("bg-emerald-400");
    expect(screen.getByTitle("Add markdown cell")).toHaveClass("text-foreground");
  });

  it("softens the terminal row into a document tail", () => {
    const { container } = render(
      <CellInsertionRibbon
        activeType="code"
        terminal
        forceActionsVisible
        onInsert={() => undefined}
      />,
    );

    const adder = container.querySelector('[data-slot="cell-adder"]');
    const ribbon = container.querySelector('[data-slot="cell-adder-ribbon"]');
    const intent = container.querySelector('[data-slot="cell-adder-ribbon-intent"]');

    expect(adder).toHaveAttribute("data-terminal", "true");
    expect(adder).toHaveClass("h-[clamp(3.5rem,9vh,5.5rem)]");
    expect(ribbon).toHaveClass(
      "[mask-image:linear-gradient(to_bottom,black_0,black_calc(100%-1.5rem),transparent_100%)]",
    );
    expect(intent).toHaveClass("h-7");
    expect(intent).toHaveClass("bg-gradient-to-b");
  });
});
