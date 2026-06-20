import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { ImageOutput } from "../image-output";
import { copyRasterImageToClipboard } from "../copy-image";

vi.mock("../copy-image", () => ({
  copyRasterImageToClipboard: vi.fn().mockResolvedValue(undefined),
}));

describe("ImageOutput", () => {
  it("renders Copy image in the raster image context menu", async () => {
    render(<ImageOutput data="AQID" mediaType="image/png" />);

    fireEvent.contextMenu(screen.getByRole("img", { name: "Output image" }));

    const copyImage = await screen.findByRole("menuitem", { name: "Copy image" });
    expect(copyImage).toBeInTheDocument();

    fireEvent.click(copyImage);

    expect(copyRasterImageToClipboard).toHaveBeenCalledWith(
      "data:image/png;base64,AQID",
      "image/png",
    );
  });

  it("does not add the raster image context menu to SVG image output", () => {
    render(<ImageOutput data="<svg />" mediaType="image/svg+xml" />);

    fireEvent.contextMenu(screen.getByRole("img", { name: "Output image" }));

    expect(screen.queryByRole("menuitem", { name: "Copy image" })).not.toBeInTheDocument();
  });
});
