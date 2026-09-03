import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { NotebookBrandMark } from "../NotebookBrandMark";

describe("NotebookBrandMark", () => {
  it("provides light and dark theme artwork under one accessible name", () => {
    render(<NotebookBrandMark />);

    const mark = screen.getByRole("img", { name: "nteract" });
    const artwork = mark.querySelectorAll("img");

    expect(artwork).toHaveLength(2);
    expect(artwork[0]).toHaveClass("dark:hidden");
    expect(artwork[1]).toHaveClass("dark:block");
    expect(artwork[0]).toHaveAttribute("aria-hidden", "true");
    expect(artwork[1]).toHaveAttribute("aria-hidden", "true");
  });
});
