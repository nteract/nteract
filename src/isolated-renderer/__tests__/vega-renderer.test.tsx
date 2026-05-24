import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RendererProps } from "@/lib/renderer-registry";
import { install } from "../vega-renderer";

const vegaMocks = vi.hoisted(() => ({
  embed: vi.fn(),
}));

vi.mock("vega-embed", () => ({
  default: vegaMocks.embed,
}));

function installVegaRenderer() {
  let Renderer: ComponentType<RendererProps> | undefined;

  install({
    register: vi.fn(),
    registerPattern: (_test, component) => {
      Renderer = component;
    },
  });

  expect(Renderer).toBeDefined();
  return Renderer!;
}

function createView() {
  const changeset = {
    remove: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
  };
  return {
    changeset: vi.fn(() => changeset),
    change: vi.fn().mockReturnThis(),
    finalize: vi.fn(),
    runAsync: vi.fn().mockResolvedValue(undefined),
    changesetMock: changeset,
  };
}

describe("Vega renderer plugin", () => {
  const firstSpec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { values: [{ x: 1, y: 2 }] },
    mark: "point",
    encoding: {
      x: { field: "x", type: "quantitative" },
      y: { field: "y", type: "quantitative" },
    },
  };

  const nextValuesSpec = {
    ...firstSpec,
    data: { values: [{ x: 1, y: 4 }] },
  };

  beforeEach(() => {
    document.documentElement.classList.remove("dark");
    vegaMocks.embed.mockImplementation(() => Promise.resolve({ view: createView() }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("updates inline Vega-Lite values without re-embedding the view", async () => {
    const Renderer = installVegaRenderer();
    const view = createView();
    vegaMocks.embed.mockResolvedValueOnce({ view });

    const { rerender } = render(
      <Renderer data={firstSpec} mimeType="application/vnd.vegalite.v5+json" />,
    );

    await waitFor(() => expect(vegaMocks.embed).toHaveBeenCalledTimes(1));

    rerender(<Renderer data={nextValuesSpec} mimeType="application/vnd.vegalite.v5+json" />);

    await waitFor(() => expect(view.runAsync).toHaveBeenCalledTimes(1));

    expect(vegaMocks.embed).toHaveBeenCalledTimes(1);
    expect(view.finalize).not.toHaveBeenCalled();
    expect(view.change).toHaveBeenCalledWith("source_0", view.changesetMock);
    expect(view.changesetMock.remove).toHaveBeenCalledWith(expect.any(Function));
    expect(view.changesetMock.insert).toHaveBeenCalledWith(nextValuesSpec.data.values);
  });

  it("re-embeds when the Vega-Lite spec structure changes", async () => {
    const Renderer = installVegaRenderer();
    const firstView = createView();
    const secondView = createView();
    vegaMocks.embed.mockResolvedValueOnce({ view: firstView }).mockResolvedValueOnce({
      view: secondView,
    });

    const { rerender } = render(
      <Renderer data={firstSpec} mimeType="application/vnd.vegalite.v5+json" />,
    );
    await waitFor(() => expect(vegaMocks.embed).toHaveBeenCalledTimes(1));

    rerender(
      <Renderer
        data={{
          ...firstSpec,
          mark: "bar",
        }}
        mimeType="application/vnd.vegalite.v5+json"
      />,
    );

    await waitFor(() => expect(vegaMocks.embed).toHaveBeenCalledTimes(2));

    expect(firstView.finalize).toHaveBeenCalledTimes(1);
    expect(firstView.change).not.toHaveBeenCalled();
  });

  it("updates inline values for a Vega spec with a named dataset", async () => {
    const Renderer = installVegaRenderer();
    const view = createView();
    vegaMocks.embed.mockResolvedValueOnce({ view });
    const firstVegaSpec = {
      $schema: "https://vega.github.io/schema/vega/v5.json",
      data: [{ name: "table", values: [{ x: 1, y: 2 }] }],
      marks: [{ type: "symbol", from: { data: "table" } }],
    };

    const { rerender } = render(
      <Renderer data={firstVegaSpec} mimeType="application/vnd.vega.v5+json" />,
    );
    await waitFor(() => expect(vegaMocks.embed).toHaveBeenCalledTimes(1));

    rerender(
      <Renderer
        data={{
          ...firstVegaSpec,
          data: [{ name: "table", values: [{ x: 1, y: 8 }] }],
        }}
        mimeType="application/vnd.vega.v5+json"
      />,
    );

    await waitFor(() => expect(view.runAsync).toHaveBeenCalledTimes(1));

    expect(vegaMocks.embed).toHaveBeenCalledTimes(1);
    expect(view.change).toHaveBeenCalledWith("table", view.changesetMock);
    expect(view.changesetMock.insert).toHaveBeenCalledWith([{ x: 1, y: 8 }]);
  });

  it("finalizes the previous view when data becomes invalid", async () => {
    const Renderer = installVegaRenderer();
    const view = createView();
    vegaMocks.embed.mockResolvedValueOnce({ view });

    const { rerender } = render(
      <Renderer data={firstSpec} mimeType="application/vnd.vegalite.v5+json" />,
    );
    await waitFor(() => expect(vegaMocks.embed).toHaveBeenCalledTimes(1));

    rerender(<Renderer data={null} mimeType="application/vnd.vegalite.v5+json" />);

    expect(view.finalize).toHaveBeenCalledTimes(1);
  });
});
