import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { Spinner } from "../spinner";

const CONTEXTUAL_COLOR_CLASS =
  /^(?:bg|border|ring|fill|stroke|from|via|to|decoration|outline|shadow)-/;

function colorClasses(element: HTMLElement): string[] {
  return [...element.classList].filter(
    (className) =>
      CONTEXTUAL_COLOR_CLASS.test(className) ||
      (className.startsWith("text-") && className !== "text-current"),
  );
}

describe("Spinner", () => {
  it("renders a labelled status with the default size", () => {
    const { getByRole, getByText } = render(<Spinner />);

    const spinner = getByRole("status", { name: "Loading" });
    expect(spinner).toHaveAttribute("data-slot", "spinner");
    expect(spinner).toHaveClass("animate-spin", "size-4", "text-current");
    expect(getByText("Loading")).toHaveClass("sr-only");
  });

  it("applies size variants", () => {
    const { getByRole, rerender } = render(<Spinner size="sm" />);

    expect(getByRole("status")).toHaveClass("size-3");

    rerender(<Spinner size="lg" />);

    expect(getByRole("status")).toHaveClass("size-6");
  });

  it("keeps color inherited from the current context", () => {
    const { getByRole } = render(<Spinner />);

    const spinner = getByRole("status");
    expect(colorClasses(spinner)).toEqual([]);
  });

  it("allows the accessible label to be overridden", () => {
    const { getByRole, getByText } = render(<Spinner label="Connecting runtime" />);

    expect(getByRole("status", { name: "Connecting runtime" })).toBeTruthy();
    expect(getByText("Connecting runtime")).toHaveClass("sr-only");
  });
});
