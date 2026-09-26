import { act, render, screen } from "@testing-library/react";
import { lazy, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";
import { MediaRouter } from "../media-router";

describe("MediaRouter image loading", () => {
  it("mounts the first raster image without an intermediate renderer placeholder", () => {
    const { container, rerender } = render(
      <MediaRouter data={{ "image/png": "data:image/png;base64,AQID" }} />,
    );

    const image = screen.getByRole("img", { name: "Output image" });
    expect(image).toHaveAttribute("src", "data:image/png;base64,AQID");
    expect(container.querySelector(".animate-spin")).toBeNull();

    rerender(
      <MediaRouter
        data={{ "image/png": "data:image/png;base64,AQID", "text/plain": "updated description" }}
      />,
    );
    expect(screen.getByRole("img")).toBe(image);

    rerender(<MediaRouter data={{}} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps the loading fallback for a custom renderer that actually suspends", async () => {
    let resolve!: (module: { default: () => ReactNode }) => void;
    const CustomImage = lazy(
      () => new Promise<{ default: () => ReactNode }>((done) => (resolve = done)),
    );
    render(
      <MediaRouter
        data={{ "image/png": "custom" }}
        renderers={{ "image/png": () => <CustomImage /> }}
        loading={<span>Loading custom image</span>}
      />,
    );
    expect(screen.getByText("Loading custom image")).toBeInTheDocument();
    await act(async () => resolve({ default: () => <span>Custom image ready</span> }));
    expect(screen.getByText("Custom image ready")).toBeInTheDocument();
  });
});
