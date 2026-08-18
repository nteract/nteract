import { fireEvent, render, screen } from "@testing-library/react";
import { Boxes, ListTree } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  RAIL_TAKEOVER_PANEL_CLASS_NAMES,
  RAIL_TAKEOVER_STAGE_CLASS_NAME,
  Rail,
  RailButton,
} from "../Rail";

type PanelId = "outline" | "packages";

const items = [
  { id: "outline", label: "Outline", icon: ListTree },
  { id: "packages", label: "Packages", icon: Boxes },
] satisfies Array<{ id: PanelId; label: string; icon: typeof ListTree }>;

describe("Rail", () => {
  it("renders the active panel chrome and content", () => {
    const { container } = render(
      <Rail
        activePanelId="packages"
        collapsed={false}
        items={items}
        panelTitle="Packages"
        panelClassName="w-64"
        dataTestId="example-rail"
        panelSlot="example-rail-panel"
        panelTitleRowSlot="example-rail-title-row"
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      >
        <div data-testid="panel-content">Dependencies</div>
      </Rail>,
    );

    expect(screen.getByTestId("example-rail")).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByRole("heading", { name: "Packages" })).toHaveClass("text-sm");
    expect(screen.queryByText("uv · 2 packages")).not.toBeInTheDocument();
    expect(screen.getByTestId("panel-content")).toHaveTextContent("Dependencies");
    expect(container.querySelector('[data-slot="example-rail-panel"]')).toHaveClass(
      "w-64",
      ...RAIL_TAKEOVER_PANEL_CLASS_NAMES.split(" "),
    );
    expect(container.querySelector('[data-slot="example-rail-panel"]')).toHaveClass("border-r");
    expect(container.querySelector('[data-slot="example-rail-panel"]')).toHaveClass("bg-muted/20");
    expect(container.querySelector('[data-slot="example-rail-title-row"]')).toHaveClass(
      "flex-wrap",
    );
  });

  it("collapses the expanded active panel button", () => {
    const onActivePanelChange = vi.fn();
    const onCollapsedChange = vi.fn();

    render(
      <Rail
        activePanelId="outline"
        collapsed={false}
        items={items}
        panelTitle="Outline"
        onActivePanelChange={onActivePanelChange}
        onCollapsedChange={onCollapsedChange}
      >
        Outline
      </Rail>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
    expect(onActivePanelChange).not.toHaveBeenCalled();
  });

  it("does not render a separate collapse control", () => {
    render(
      <Rail
        activePanelId="outline"
        collapsed={false}
        items={items}
        panelTitle="Outline"
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      >
        Outline
      </Rail>,
    );

    expect(screen.queryByRole("button", { name: "Collapse rail" })).not.toBeInTheDocument();
  });

  it("omits redundant panel header chrome when no title or action is provided", () => {
    const { container } = render(
      <Rail
        activePanelId="outline"
        collapsed={false}
        items={items}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      >
        <div data-testid="outline-content">Outline</div>
      </Rail>,
    );

    expect(container.querySelector('[data-slot="rail-panel-header"]')).toBeNull();
    expect(screen.getByTestId("outline-content")).toBeVisible();
  });

  it("reserves a command-row-height leading slot even without a leading control", () => {
    const { container } = render(
      <Rail
        activePanelId="outline"
        collapsed={false}
        items={items}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      >
        Outline
      </Rail>,
    );

    expect(container.querySelector('[data-slot="rail-strip-grid"]')).toHaveClass(
      "grid-rows-[2.5rem_minmax(0,1fr)]",
    );
    expect(container.querySelector('[data-slot="rail-leading-slot"]')).not.toHaveClass(
      "border-b",
      "border-r",
    );
    expect(container.querySelector('[data-slot="rail-strip-grid"]')).not.toHaveClass("border-r");
    expect(container.querySelector('[data-slot="rail-strip-grid"]')).toHaveClass("bg-background");
  });

  it("expands and selects a panel while collapsed", () => {
    const onActivePanelChange = vi.fn();
    const onCollapsedChange = vi.fn();

    render(
      <Rail
        activePanelId="outline"
        collapsed
        items={items}
        panelTitle="Outline"
        onActivePanelChange={onActivePanelChange}
        onCollapsedChange={onCollapsedChange}
      >
        Outline
      </Rail>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Packages" }));
    expect(onActivePanelChange).toHaveBeenCalledWith("packages");
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("moves the outer boundary from the collapsed strip to the expanded panel", () => {
    const { container, rerender } = render(
      <Rail
        activePanelId="outline"
        collapsed
        items={items}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      >
        Outline
      </Rail>,
    );

    expect(container.querySelector('[data-slot="rail-leading-slot"]')).not.toHaveClass("border-r");
    expect(container.querySelector('[data-slot="rail-body"]')).toHaveClass("border-r");
    expect(container.querySelector('[data-slot="rail-panel"]')).toBeNull();

    rerender(
      <Rail
        activePanelId="outline"
        collapsed={false}
        items={items}
        onActivePanelChange={vi.fn()}
        onCollapsedChange={vi.fn()}
      >
        Outline
      </Rail>,
    );

    expect(container.querySelector('[data-slot="rail-leading-slot"]')).not.toHaveClass("border-r");
    expect(container.querySelector('[data-slot="rail-body"]')).not.toHaveClass("border-r");
    expect(container.querySelector('[data-slot="rail-panel"]')).toHaveClass("border-r");
  });

  it("does not invoke callbacks for disabled rail items", () => {
    const onActivePanelChange = vi.fn();
    const onCollapsedChange = vi.fn();

    render(
      <Rail
        activePanelId="outline"
        collapsed={false}
        items={[items[0], { ...items[1], disabled: true }]}
        panelTitle="Outline"
        onActivePanelChange={onActivePanelChange}
        onCollapsedChange={onCollapsedChange}
      >
        Outline
      </Rail>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Packages" }));
    expect(onActivePanelChange).not.toHaveBeenCalled();
    expect(onCollapsedChange).not.toHaveBeenCalled();
  });
});

describe("RailButton", () => {
  it("uses icon-button semantics", () => {
    render(<RailButton label="Outline" icon={ListTree} active />);

    expect(screen.getByRole("button", { name: "Outline" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Outline" })).toHaveClass(
      "bg-foreground",
      "text-background",
      "rounded-md",
      "focus-visible:ring-1",
      "focus-visible:ring-ring",
    );
  });

  it("exports the stage takeover class with the rail contract", () => {
    expect(RAIL_TAKEOVER_STAGE_CLASS_NAME).toBe("max-[599.98px]:hidden");
  });
});
