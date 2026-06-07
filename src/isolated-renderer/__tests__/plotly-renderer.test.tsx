import { cleanup, render } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RendererProps } from "@/lib/renderer-registry";
import { install } from "../plotly-renderer";

const plotlyMocks = vi.hoisted(() => ({
  newPlot: vi.fn(),
  react: vi.fn(),
  relayout: vi.fn(),
  purge: vi.fn(),
}));

vi.mock("plotly.js-dist-min", () => ({
  default: plotlyMocks,
}));

function installPlotlyRenderer() {
  let Renderer: ComponentType<RendererProps> | undefined;

  install({
    register: (_mimeTypes, component) => {
      Renderer = component;
    },
  });

  expect(Renderer).toBeDefined();
  return Renderer!;
}

describe("Plotly renderer plugin", () => {
  const firstFigure = {
    data: [{ type: "scatter", x: [1, 2], y: [3, 4] }],
    layout: { title: "first" },
    config: { scrollZoom: true },
  };

  const nextFigure = {
    data: [{ type: "scatter", x: [1, 2], y: [5, 6] }],
    layout: { title: "next" },
    config: { scrollZoom: true },
  };

  beforeEach(() => {
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses Plotly.react for display updates instead of remounting the chart", () => {
    const Renderer = installPlotlyRenderer();

    const { rerender } = render(
      <Renderer data={firstFigure} mimeType="application/vnd.plotly.v1+json" />,
    );

    expect(plotlyMocks.newPlot).toHaveBeenCalledTimes(1);
    expect(plotlyMocks.react).not.toHaveBeenCalled();
    expect(plotlyMocks.purge).not.toHaveBeenCalled();

    rerender(<Renderer data={nextFigure} mimeType="application/vnd.plotly.v1+json" />);

    expect(plotlyMocks.newPlot).toHaveBeenCalledTimes(1);
    expect(plotlyMocks.react).toHaveBeenCalledTimes(1);
    expect(plotlyMocks.react.mock.calls[0][0]).toBe(plotlyMocks.newPlot.mock.calls[0][0]);
    expect(plotlyMocks.react.mock.calls[0][1].data).toEqual(nextFigure.data);
    expect(plotlyMocks.react.mock.calls[0][1].layout.title).toBe("next");
    expect(plotlyMocks.react.mock.calls[0][1].layout.uirevision).toBe("nteract-display-update");
    expect(plotlyMocks.purge).not.toHaveBeenCalled();
  });

  it("honors a user-provided uirevision", () => {
    const Renderer = installPlotlyRenderer();
    const figure = {
      ...firstFigure,
      layout: { ...firstFigure.layout, uirevision: "user-controlled" },
    };

    render(<Renderer data={figure} mimeType="application/vnd.plotly.v1+json" />);

    expect(plotlyMocks.newPlot.mock.calls[0][1].layout.uirevision).toBe("user-controlled");
  });

  it("purges the Plotly chart only when the renderer unmounts", () => {
    const Renderer = installPlotlyRenderer();

    const { rerender, unmount } = render(
      <Renderer data={firstFigure} mimeType="application/vnd.plotly.v1+json" />,
    );
    rerender(<Renderer data={nextFigure} mimeType="application/vnd.plotly.v1+json" />);

    expect(plotlyMocks.purge).not.toHaveBeenCalled();

    unmount();

    expect(plotlyMocks.purge).toHaveBeenCalledTimes(1);
    expect(plotlyMocks.purge.mock.calls[0][0]).toBe(plotlyMocks.newPlot.mock.calls[0][0]);
  });

  it("initializes a new Plotly chart after the data becomes invalid and valid again", () => {
    const Renderer = installPlotlyRenderer();

    const { rerender } = render(
      <Renderer data={firstFigure} mimeType="application/vnd.plotly.v1+json" />,
    );
    const firstElement = plotlyMocks.newPlot.mock.calls[0][0];

    rerender(<Renderer data={null} mimeType="application/vnd.plotly.v1+json" />);

    expect(plotlyMocks.purge).toHaveBeenCalledTimes(1);
    expect(plotlyMocks.purge.mock.calls[0][0]).toBe(firstElement);

    rerender(<Renderer data={nextFigure} mimeType="application/vnd.plotly.v1+json" />);

    expect(plotlyMocks.newPlot).toHaveBeenCalledTimes(2);
    expect(plotlyMocks.react).not.toHaveBeenCalled();
    expect(plotlyMocks.newPlot.mock.calls[1][0]).not.toBe(firstElement);
  });

  it("uses Plotly.react when the figure arrives as a JSON string", () => {
    const Renderer = installPlotlyRenderer();

    const { rerender } = render(
      <Renderer data={JSON.stringify(firstFigure)} mimeType="application/vnd.plotly.v1+json" />,
    );
    rerender(
      <Renderer data={JSON.stringify(nextFigure)} mimeType="application/vnd.plotly.v1+json" />,
    );

    expect(plotlyMocks.newPlot).toHaveBeenCalledTimes(1);
    expect(plotlyMocks.react).toHaveBeenCalledTimes(1);
    expect(plotlyMocks.react.mock.calls[0][1].data).toEqual(nextFigure.data);
  });

  it("requests a host resize after Plotly completes its async render", async () => {
    const Renderer = installPlotlyRenderer();
    const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

    plotlyMocks.newPlot.mockReturnValueOnce(Promise.resolve());

    render(<Renderer data={firstFigure} mimeType="application/vnd.plotly.v1+json" />);
    await Promise.resolve();
    await Promise.resolve();

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: "resize",
        payload: { height: expect.any(Number) },
      },
      "*",
    );
  });
});
