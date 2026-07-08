import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { Separator } from "../separator";

const RAW_PALETTE_CLASS =
  /^(?:bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|shadow)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/;

function rawPaletteClasses(element: HTMLElement): string[] {
  return [...element.classList].filter((className) => RAW_PALETTE_CLASS.test(className));
}

describe("Separator", () => {
  it("renders an accessible separator with orientation data", () => {
    const { getByRole } = render(<Separator decorative={false} orientation="vertical" />);

    const separator = getByRole("separator");
    expect(separator).toHaveAttribute("data-slot", "separator");
    expect(separator).toHaveAttribute("data-orientation", "vertical");
    expect(separator).toHaveClass("h-full", "w-px");
  });

  it("uses the border token without raw palette classes", () => {
    const { container } = render(<Separator />);

    const separator = container.querySelector<HTMLElement>('[data-slot="separator"]');
    expect(separator).not.toBeNull();
    expect(separator).toHaveClass("bg-border", "h-px", "w-full");
    expect(rawPaletteClasses(separator!)).toEqual([]);
  });

  it("passes through className", () => {
    const { container } = render(<Separator className="my-4 opacity-50" />);

    const separator = container.querySelector<HTMLElement>('[data-slot="separator"]');
    expect(separator).not.toBeNull();
    expect(separator).toHaveClass("my-4", "opacity-50");
  });
});
