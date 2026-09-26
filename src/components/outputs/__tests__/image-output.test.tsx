import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { ImageOutput } from "../image-output";

describe("ImageOutput", () => {
  it.each([
    ["image/png", "AQID", "data:image/png;base64,AQID"],
    ["image/jpeg", "data:image/jpeg;base64,AQID", "data:image/jpeg;base64,AQID"],
    ["image/gif", "blob:http://localhost/image", "blob:http://localhost/image"],
    ["image/webp", "https://example.com/image.webp", "https://example.com/image.webp"],
    ["image/bmp", "http://127.0.0.1:8080/image.bmp", "http://127.0.0.1:8080/image.bmp"],
  ])("preserves the host image menu for %s (%s)", (mediaType, data, src) => {
    render(<ImageOutput data={data} mediaType={mediaType} />);

    const image = screen.getByRole("img", { name: "Output image" });
    expect(image).toHaveAttribute("src", src);
    const contextMenu = createEvent.contextMenu(image, { bubbles: true, cancelable: true });
    fireEvent(image, contextMenu);

    expect(contextMenu.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not handle context menus outside the image", () => {
    const { container } = render(<ImageOutput data="AQID" />);
    const contextMenu = createEvent.contextMenu(container, { bubbles: true, cancelable: true });
    fireEvent(container, contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
