import { render } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { Skeleton } from "../skeleton";

describe("Skeleton", () => {
  it("renders the ratified shimmer skeleton without pulse animation", () => {
    const { container } = render(<Skeleton />);

    const skeleton = container.querySelector<HTMLElement>('[data-slot="skeleton"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton).toHaveAttribute("aria-hidden", "true");
    expect(skeleton).toHaveClass("nb-skeleton", "animate-skeleton-shimmer", "rounded-md");
    expect(skeleton).not.toHaveClass("animate-pulse");
  });

  it("passes through className and style", () => {
    const { container } = render(
      <Skeleton className="h-4 w-32" style={{ animationDelay: "120ms", minHeight: "1rem" }} />,
    );

    const skeleton = container.querySelector<HTMLElement>('[data-slot="skeleton"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton).toHaveClass("h-4", "w-32");
    expect(skeleton).toHaveStyle({ animationDelay: "120ms", minHeight: "1rem" });
  });
});
