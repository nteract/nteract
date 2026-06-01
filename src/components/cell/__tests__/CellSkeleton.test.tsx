import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { CellSkeleton } from "../CellSkeleton";

describe("CellSkeleton", () => {
  it("renders loading placeholders using the shared cell layout", () => {
    const { container } = render(<CellSkeleton />);

    const placeholders = container.querySelectorAll(".animate-pulse");
    expect(placeholders).toHaveLength(3);
    expect(placeholders[0]).toHaveStyle({ minHeight: "2.5rem", animationDelay: "0ms" });
    expect(placeholders[1]).toHaveStyle({ minHeight: "5rem", animationDelay: "75ms" });
    expect(placeholders[2]).toHaveStyle({ minHeight: "2rem", animationDelay: "150ms" });
  });
});
