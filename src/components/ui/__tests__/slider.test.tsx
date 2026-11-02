import { render } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { Slider } from "../slider";

it("renders one thumb per value so range sliders get both handles", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const { getAllByRole } = render(<Slider value={[2, 8]} min={0} max={10} />);
  expect(getAllByRole("slider")).toHaveLength(2);
});
