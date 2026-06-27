import { describe, expect, it } from "vitest";
import "@/components/widgets/matplotlib";
import { hasWidgetComponent } from "../widget-registry";

describe("matplotlib widget registration", () => {
  it("registers ipympl canvas and toolbar models", () => {
    expect(hasWidgetComponent("MPLCanvasModel")).toBe(true);
    expect(hasWidgetComponent("ToolbarModel")).toBe(true);
  });
});
