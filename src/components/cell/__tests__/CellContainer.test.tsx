import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { CellContainer } from "../CellContainer";

describe("CellContainer", () => {
  it("shows right edge controls when the cell is focused", () => {
    const { container } = render(
      <CellContainer
        id="focused-cell"
        cellType="code"
        isFocused
        codeContent={<div>source</div>}
        rightGutterContent={<button type="button">Delete cell</button>}
      />,
    );

    const overlay = container.querySelector('[data-slot="cell-action-overlay"]');
    const codeContent = container.querySelector('[data-slot="cell-code-content"]');
    expect(overlay).toHaveClass("opacity-100");
    expect(overlay).toHaveClass("pointer-events-auto");
    expect(codeContent).toHaveClass("pr-14");
  });

  it("reserves output row space for output edge controls", () => {
    const { container } = render(
      <CellContainer
        id="output-cell"
        cellType="code"
        isFocused
        codeContent={<div>source</div>}
        outputContent={<div>long output</div>}
        outputRightGutterContent={<button type="button">Hide output</button>}
      />,
    );

    const outputContent = container.querySelector('[data-slot="cell-output-content"]');

    expect(outputContent).toHaveClass("pr-14");
  });

  it("keeps right edge controls hidden until hover or focus for unfocused cells", () => {
    const { container } = render(
      <CellContainer
        id="unfocused-cell"
        cellType="code"
        codeContent={<div>source</div>}
        rightGutterContent={<button type="button">Delete cell</button>}
      />,
    );

    const overlay = container.querySelector('[data-slot="cell-action-overlay"]');
    expect(overlay).toHaveClass("opacity-0");
    expect(overlay).toHaveClass("pointer-events-none");
    expect(overlay).not.toHaveClass("opacity-100");
    expect(overlay).not.toHaveClass("pointer-events-auto");
  });
});
