import { cleanup, render, waitFor } from "@testing-library/react";
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
  it.each([false, true])("preserves explicit axes and subplot geometry in dark=%s", (dark) => {
    const Renderer = installPlotlyRenderer();
    document.documentElement.classList.toggle("dark", dark);
    const figure = {
      data: [
        { type: "scatter", x: [1, 10, 100], y: [1, 2, 3] },
        { type: "scatter", x: [1, 2], y: [10, 100], xaxis: "x2", yaxis: "y2" },
      ],
      layout: {
        xaxis: {
          type: "log",
          range: [0, 2],
          title: { text: "Period", font: { size: 19 } },
          domain: [0, 0.4],
          anchor: "y",
          tickfont: { family: "Georgia", size: 12 },
        },
        yaxis: { visible: false, range: [0, 4], domain: [0.6, 1], anchor: "x" },
        xaxis2: { type: "date", domain: [0.6, 1], anchor: "y2", title: { text: "Date" } },
        yaxis2: { type: "log", range: [1, 2], domain: [0, 0.35], anchor: "x2" },
        font: { family: "Georgia", size: 18 },
        legend: { orientation: "h", font: { family: "Arial", size: 16 } },
        annotations: [{ x: 1, y: 2, xref: "x2", yref: "y2", text: "Keep me" }],
        colorway: ["#123456", "#abcdef"],
      },
    };
    const original = JSON.parse(JSON.stringify(figure));
    render(<Renderer data={figure} mimeType="application/vnd.plotly.v1+json" />);
    const layout = plotlyMocks.newPlot.mock.calls[0][1].layout;
    expect(layout).toMatchObject(figure.layout);
    expect(layout.xaxis2.gridcolor).toBe(dark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)");
    expect(layout.yaxis2.color).toBe(dark ? "rgba(200, 200, 200, 1)" : "rgba(68, 68, 68, 1)");
    expect(figure).toEqual(original);
    document.documentElement.classList.remove("dark");
  });

  it("changes theme colors without replacing axes, fonts or a user's zoom", async () => {
    const Renderer = installPlotlyRenderer();
    document.documentElement.classList.remove("dark");
    const figure = {
      data: [{ x: [1, 10], y: [2, 3] }],
      layout: {
        xaxis: { type: "log", range: [0, 2] },
        xaxis2: { domain: [0.6, 1], anchor: "y2" },
        yaxis2: { domain: [0, 0.4], anchor: "x2" },
        font: { family: "Georgia", size: 18 },
        template: { layout: { xaxis3: { type: "log", domain: [0, 0.3] } } },
      },
    };
    render(<Renderer data={figure} mimeType="application/vnd.plotly.v1+json" />);
    const el = plotlyMocks.newPlot.mock.calls[0][0];
    el.layout = { xaxis: { type: "log", range: [0.5, 1.5] } };
    document.documentElement.classList.add("dark");
    await waitFor(() => expect(plotlyMocks.relayout).toHaveBeenCalledTimes(1));
    const update = plotlyMocks.relayout.mock.calls[0][1];
    expect(update["xaxis.gridcolor"]).toBe("rgba(255, 255, 255, 0.1)");
    expect(update["xaxis2.color"]).toBe("rgba(200, 200, 200, 1)");
    expect(update["xaxis3.color"]).toBe("rgba(200, 200, 200, 1)");
    expect(update["legend.font.color"]).toBe("rgba(200, 200, 200, 1)");
    expect(update).not.toHaveProperty("xaxis");
    expect(update).not.toHaveProperty("font");
    expect(Object.keys(update).some((key) => /range|domain|anchor|type|title/.test(key))).toBe(
      false,
    );
    document.documentElement.classList.remove("dark");
    await waitFor(() => expect(plotlyMocks.relayout).toHaveBeenCalledTimes(2));
    expect(plotlyMocks.relayout.mock.calls[1][1]["xaxis2.color"]).toBe("rgba(68, 68, 68, 1)");
  });
  it("keeps template axes and non-Cartesian layout intact across figure updates", async () => {
    const Renderer = installPlotlyRenderer();
    document.documentElement.classList.remove("dark");
    const figure = {
      data: [{ type: "scatter", x: [1, 10], y: [1, 2] }],
      layout: {
        template: {
          layout: {
            xaxis: { type: "log", range: [0, 2] },
            yaxis: { visible: false },
            xaxis2: { domain: [0.7, 1], anchor: "y2" },
          },
        },
        scene: { xaxis: { type: "log", range: [0, 3] }, domain: { x: [0.5, 1], y: [0.5, 1] } },
        polar: { radialaxis: { type: "log", range: [0, 2] }, domain: { x: [0, 0.4] } },
        ternary: { sum: 100, domain: { x: [0, 0.4], y: [0, 0.4] } },
        grid: { rows: 2, columns: 2, pattern: "independent" },
        shapes: [{ type: "line", xref: "x2", yref: "y2", x0: 1, x1: 10, y0: 0, y1: 2 }],
      },
    };
    const { rerender } = render(
      <Renderer data={figure} mimeType="application/vnd.plotly.v1+json" />,
    );
    expect(plotlyMocks.newPlot.mock.calls[0][1].layout).toMatchObject(figure.layout);
    const next = {
      ...figure,
      layout: {
        ...figure.layout,
        xaxis: { type: "log", range: [1, 4] },
        xaxis4: { domain: [0.2, 0.5], anchor: "y4" },
      },
    };
    rerender(<Renderer data={next} mimeType="application/vnd.plotly.v1+json" />);
    const rendered = plotlyMocks.react.mock.calls.at(-1)![1].layout;
    expect(rendered).toMatchObject(next.layout);
    document.documentElement.classList.add("dark");
    await waitFor(() => expect(plotlyMocks.relayout).toHaveBeenCalledTimes(1));
    expect(plotlyMocks.relayout.mock.calls[0][1]["xaxis4.color"]).toBe("rgba(200, 200, 200, 1)");
    document.documentElement.classList.remove("dark");
  });
});
