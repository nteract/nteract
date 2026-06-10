import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { CellInsertionRibbon } from "../CellInsertionRibbon";

describe("CellInsertionRibbon", () => {
  it("reveals code insertion intent and calls the insert handler", () => {
    const onInsert = vi.fn();
    const { container } = render(<CellInsertionRibbon onInsert={onInsert} />);

    expect(container.querySelector('[data-slot="cell-adder-ribbon-intent"]')).toBeNull();

    const addCodeButton = screen.getByTitle("Add code cell");
    expect(addCodeButton).toHaveTextContent("Code");
    fireEvent.pointerEnter(addCodeButton);
    fireEvent.click(addCodeButton);

    const intent = container.querySelector('[data-slot="cell-adder-ribbon-intent"]');
    expect(intent).toHaveClass("bg-sky-400");
    expect(onInsert).toHaveBeenCalledWith("code");
  });

  it("uses the left insertion channel as the resting code target", () => {
    const onInsert = vi.fn();
    const { container } = render(<CellInsertionRibbon onInsert={onInsert} />);

    const hitTarget = container.querySelector('[data-slot="cell-adder-primary-hit-target"]');
    const primaryBridge = container.querySelector('[data-slot="cell-adder-primary-bridge"]');
    expect(hitTarget).toHaveAttribute("aria-label", "Add code cell here");
    expect(hitTarget).toHaveAttribute("title", "Add code cell here");
    expect(hitTarget).toHaveClass("w-[var(--cell-content-column-inset,3.25rem)]");
    expect(primaryBridge).toBeNull();

    fireEvent.pointerEnter(hitTarget!);
    const activePrimaryBridge = container.querySelector('[data-slot="cell-adder-primary-bridge"]');
    expect(container.querySelector('[data-slot="cell-adder-ribbon-intent"]')).toHaveClass(
      "bg-sky-400",
    );
    expect(container.querySelector('[data-slot="cell-adder-primary-glyph"]')).toBeNull();
    expect(hitTarget).toHaveClass("w-[var(--cell-content-column-inset,3.25rem)]");
    expect(activePrimaryBridge).toHaveClass("h-6");
    expect(activePrimaryBridge).toHaveClass("bg-sky-500/12");
    expect(activePrimaryBridge).toHaveClass("border-sky-500/20");
    expect(container.querySelector('[data-slot="cell-adder-leading-rule"]')).toHaveClass("h-6");

    fireEvent.click(hitTarget!);

    expect(onInsert).toHaveBeenCalledWith("code");
  });

  it("keeps the row neutral until a concrete cell type is targeted", () => {
    const { container } = render(<CellInsertionRibbon onInsert={() => undefined} />);

    const adder = container.querySelector('[data-slot="cell-adder"]');
    const continuation = container.querySelector('[data-slot="cell-adder-ribbon-continuation"]');
    const hitTarget = container.querySelector('[data-slot="cell-adder-primary-hit-target"]');

    fireEvent.pointerEnter(adder!);

    expect(adder).toHaveAttribute("data-interaction-active", "true");
    expect(adder).not.toHaveAttribute("data-active-type");
    expect(container.querySelector('[data-slot="cell-adder-ribbon-intent"]')).toBeNull();
    expect(continuation).toHaveClass("bg-gray-300/70");
    expect(hitTarget).toHaveClass("bg-transparent");
    expect(container.querySelector('[data-slot="cell-adder-primary-glyph"]')).toBeNull();
  });

  it("keeps explicit actions out of the tab order until the row is awake", () => {
    const { container } = render(<CellInsertionRibbon onInsert={() => undefined} />);

    const adder = container.querySelector('[data-slot="cell-adder"]');
    const actions = container.querySelector('[data-slot="cell-adder-actions"]');
    const addCodeButton = screen.getByTitle("Add code cell");
    const addMarkdownButton = screen.getByTitle("Add markdown cell");

    expect(actions).toHaveAttribute("aria-hidden", "true");
    expect(actions).toHaveClass("pointer-events-none");
    expect(actions).toHaveClass("transition-none");
    expect(addCodeButton).toHaveAttribute("tabindex", "-1");
    expect(addMarkdownButton).toHaveAttribute("tabindex", "-1");

    fireEvent.pointerEnter(adder!);

    expect(actions).not.toHaveAttribute("aria-hidden");
    expect(actions).toHaveClass("pointer-events-auto");
    expect(actions).not.toHaveClass("-translate-x-1");
    expect(actions).not.toHaveClass("translate-x-0");
    expect(actions).not.toHaveClass("delay-75");
    expect(addCodeButton).toHaveAttribute("tabindex", "0");
    expect(addMarkdownButton).toHaveAttribute("tabindex", "0");
  });

  it("reveals the insertion rule and action buttons without translating the row", () => {
    const { container } = render(<CellInsertionRibbon onInsert={() => undefined} />);

    const hitTarget = container.querySelector('[data-slot="cell-adder-primary-hit-target"]');
    const actions = container.querySelector('[data-slot="cell-adder-actions"]');

    expect(actions).not.toHaveClass("-translate-x-1");

    fireEvent.pointerEnter(hitTarget!);

    expect(container.querySelector('[data-slot="cell-adder-primary-bridge"]')).toBeInTheDocument();
    expect(actions).toHaveClass("transition-opacity");
    expect(actions).toHaveClass("pointer-events-auto");
    expect(actions).not.toHaveClass("translate-x-0");
    expect(actions).toHaveClass("opacity-100");
    expect(actions).not.toHaveClass("delay-75");
    expect(screen.getByTitle("Add code cell")).toHaveAttribute("tabindex", "0");
    expect(screen.getByTitle("Add markdown cell")).toHaveAttribute("tabindex", "0");
    expect(screen.getByTitle("Add markdown cell")).toHaveClass("ml-1");
    expect(container.querySelector('[data-slot="cell-adder-action-bridge-gap"]')).toBeNull();
  });

  it("uses the controlled active type for catalog fixtures", () => {
    const { container } = render(
      <CellInsertionRibbon activeType="markdown" forceActionsVisible onInsert={() => undefined} />,
    );

    const actions = container.querySelector('[data-slot="cell-adder-actions"]');
    const palette = container.querySelector('[data-slot="cell-adder-action-palette"]');
    const hitTarget = container.querySelector('[data-slot="cell-adder-primary-hit-target"]');
    const primaryBridge = container.querySelector('[data-slot="cell-adder-primary-bridge"]');
    const actionBridgeGap = container.querySelector('[data-slot="cell-adder-action-bridge-gap"]');
    const intent = container.querySelector('[data-slot="cell-adder-ribbon-intent"]');
    const leadingRule = container.querySelector('[data-slot="cell-adder-leading-rule"]');
    const trailingRule = container.querySelector('[data-slot="cell-adder-trailing-rule"]');

    expect(actions).toHaveClass("opacity-100");
    expect(actions).toHaveClass("flex-1");
    expect(palette).toHaveClass("shrink-0");
    expect(palette).toHaveClass("pl-0");
    expect(palette).toHaveClass("gap-0");
    expect(palette).not.toHaveClass("bg-emerald-500/8");
    expect(palette).not.toHaveClass("rounded-full");
    expect(palette).not.toHaveClass("shadow-sm");
    expect(hitTarget).toHaveClass("w-[var(--cell-content-column-inset,3.25rem)]");
    expect(primaryBridge).toHaveClass("bg-emerald-500/12");
    expect(primaryBridge).toHaveClass("h-6");
    expect(primaryBridge).toHaveClass("border-emerald-500/20");
    expect(intent).toHaveClass("bg-emerald-400");
    expect(leadingRule).toHaveClass("w-2");
    expect(leadingRule).toHaveClass("h-6");
    expect(leadingRule).toHaveClass("bg-emerald-500/12");
    expect(leadingRule).toHaveClass("border-emerald-500/20");
    expect(trailingRule).toHaveClass("bg-gradient-to-r");
    expect(trailingRule).toHaveClass("from-emerald-400/35");
    expect(trailingRule).toHaveClass("flex-1");
    expect(screen.getByTitle("Add markdown cell")).toHaveClass("text-emerald-700");
    expect(screen.getByTitle("Add markdown cell")).toHaveClass("rounded-l-none");
    expect(screen.getByTitle("Add markdown cell")).toHaveClass("border-emerald-500/20");
    expect(screen.getByTitle("Add markdown cell")).toHaveClass("ml-1");
    expect(screen.getByTitle("Add code cell")).toHaveClass("bg-emerald-500/12");
    expect(screen.getByTitle("Add code cell")).toHaveClass("border-emerald-500/20");
    expect(screen.getByTitle("Add code cell")).toHaveClass("border-x-0");
    expect(screen.getByTitle("Add code cell")).toHaveClass("text-muted-foreground/45");
    expect(screen.getByTitle("Add code cell")).not.toHaveClass("text-emerald-700");
    expect(actionBridgeGap).toHaveClass("absolute");
    expect(actionBridgeGap).toHaveClass("left-full");
    expect(actionBridgeGap).toHaveClass("w-1");
    expect(actionBridgeGap).toHaveClass("bg-emerald-500/12");
    expect(actionBridgeGap).toHaveClass("border-emerald-500/20");
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
    expect(container.querySelector('[data-slot="cell-adder-primary-bridge"]')).toBeNull();
    expect(container.querySelector('[data-slot="cell-adder-leading-rule"]')).toHaveClass("h-px");
  });
});
