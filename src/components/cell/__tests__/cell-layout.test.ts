import { describe, expect, it } from "vite-plus/test";
import {
  editorDefaultFontSizeRem,
  editorFontSizeClass,
  editorLineHeight,
} from "../../editor/editor-metrics";
import { cellStateLanePadding, notebookCellLayoutVars } from "../cell-layout";

/**
 * The state lane padding and the editor line box are expressed as Tailwind
 * literals in cell-layout.ts and as constants in editor-metrics.ts. Tailwind
 * cannot read the constants, so this test is what keeps them equal.
 */
describe("cell layout editor coupling", () => {
  const fontSizeVar = "var(--nteract-editor-font-size,0.875rem)";

  it("reads the editor font size from the shared host variable", () => {
    expect(editorFontSizeClass).toBe(`text-[length:${fontSizeVar}]`);
    expect(editorFontSizeClass).toContain(`${editorDefaultFontSizeRem}rem`);
  });

  it("derives the state lane shift from the editor line box", () => {
    const defaultLineBoxRem = Number((editorDefaultFontSizeRem * editorLineHeight).toFixed(4));
    expect(notebookCellLayoutVars).toContain(
      `[--cell-state-lane-shift:calc((${fontSizeVar}*${editorLineHeight}-${defaultLineBoxRem}rem)/2)]`,
    );
  });

  it("keeps the default lane padding at 1rem compact and 0.875rem wide", () => {
    expect(cellStateLanePadding).toBe(
      "pt-[calc(1rem+var(--cell-state-lane-shift,0px))] sm:pt-[calc(0.875rem+var(--cell-state-lane-shift,0px))]",
    );
  });
});
