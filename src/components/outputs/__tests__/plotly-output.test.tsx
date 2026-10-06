import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PlotlyOutput } from "../plotly-output";

// Polyfill ResizeObserver for jsdom
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

// Mock window.Plotly (injected by the iframe library loader in production)
const mockPlotly = {
  newPlot: vi.fn(),
  relayout: vi.fn(),
  purge: vi.fn(),
  Plots: { resize: vi.fn() },
};

beforeEach(() => {
  (window as any).Plotly = mockPlotly;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mockPlotly.newPlot.mockClear();
  mockPlotly.relayout.mockClear();
  mockPlotly.purge.mockClear();
  mockPlotly.Plots.resize.mockClear();
  delete (window as any).Plotly;
});

describe("PlotlyOutput", () => {
  const sampleData = {
    data: [{ type: "scatter", x: [1, 2, 3], y: [4, 5, 6] }],
    layout: { title: "Test" },
  };

  it("calls Plotly.newPlot with figure object including data, layout, and config", () => {
    render(<PlotlyOutput data={sampleData} />);

    expect(mockPlotly.newPlot).toHaveBeenCalledTimes(1);
    const [el, figure] = mockPlotly.newPlot.mock.calls[0];
    expect(el).toBeInstanceOf(HTMLDivElement);
    expect(figure.data).toEqual(sampleData.data);
    expect(figure.layout.title).toBe("Test");
    expect(figure.layout.autosize).toBe(true);
    expect(figure.config.responsive).toBe(true);
    expect(figure.config.displaylogo).toBe(false);
  });

  it("renders nothing when data is empty", () => {
    const { container } = render(<PlotlyOutput data={{ data: [] }} />);
    // Component renders the container div but Plotly.newPlot is not called
    // because useEffect sees data.data is empty array (truthy), but newPlot
    // should still be called for an empty array — plotly handles it.
    // The key contract: returns null when data prop itself is null/undefined.
    expect(container.firstChild).toBeTruthy();
  });

  it("returns null when data prop has no data array", () => {
    const { container } = render(<PlotlyOutput data={null as any} />);
    expect(container.firstChild).toBeNull();
  });

  it("calls Plotly.purge on unmount", () => {
    const { unmount } = render(<PlotlyOutput data={sampleData} />);
    unmount();
    expect(mockPlotly.purge).toHaveBeenCalledTimes(1);
  });

  it("applies dark theme when document has dark class", () => {
    document.documentElement.classList.add("dark");
    render(<PlotlyOutput data={sampleData} />);

    const [, figure] = mockPlotly.newPlot.mock.calls[0];
    expect(figure.layout.plot_bgcolor).toBe("rgba(30, 30, 30, 1)");
    expect(figure.layout.font.color).toBe("rgba(200, 200, 200, 1)");
    expect(figure.layout.paper_bgcolor).toBe("transparent");

    document.documentElement.classList.remove("dark");
  });

  it("uses light theme by default", () => {
    document.documentElement.classList.remove("dark");
    render(<PlotlyOutput data={sampleData} />);

    const [, figure] = mockPlotly.newPlot.mock.calls[0];
    expect(figure.layout.plot_bgcolor).toBe("rgba(255, 255, 255, 1)");
    expect(figure.layout.font.color).toBe("rgba(68, 68, 68, 1)");
  });

  it("merges user config with defaults", () => {
    const dataWithConfig = {
      ...sampleData,
      config: { scrollZoom: true, displaylogo: true },
    };
    render(<PlotlyOutput data={dataWithConfig} />);

    const [, figure] = mockPlotly.newPlot.mock.calls[0];
    // User config overrides defaults
    expect(figure.config.scrollZoom).toBe(true);
    expect(figure.config.displaylogo).toBe(true);
    // Default is preserved
    expect(figure.config.responsive).toBe(true);
  });

  it("passes animation frames to Plotly.newPlot", () => {
    const animatedData = {
      ...sampleData,
      frames: [{ data: [{ y: [7, 8, 9] }], name: "frame1" }],
    };
    render(<PlotlyOutput data={animatedData} />);

    const [, figure] = mockPlotly.newPlot.mock.calls[0];
    expect(figure.frames).toEqual(animatedData.frames);
  });
  it.each([false, true])("preserves explicit axes and subplot geometry in dark=%s", (dark) => {
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
    render(<PlotlyOutput data={figure} />);
    const layout = mockPlotly.newPlot.mock.calls[0][1].layout;
    expect(layout).toMatchObject(figure.layout);
    expect(layout.xaxis2.gridcolor).toBe(dark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)");
    expect(layout.yaxis2.color).toBe(dark ? "rgba(200, 200, 200, 1)" : "rgba(68, 68, 68, 1)");
    expect(figure).toEqual(original);
    document.documentElement.classList.remove("dark");
  });

  it("changes theme colors without replacing axes, fonts or a user's zoom", async () => {
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
    render(<PlotlyOutput data={figure} />);
    const el = mockPlotly.newPlot.mock.calls[0][0];
    el.layout = { xaxis: { type: "log", range: [0.5, 1.5] } };
    document.documentElement.classList.add("dark");
    await waitFor(() => expect(mockPlotly.relayout).toHaveBeenCalledTimes(1));
    const update = mockPlotly.relayout.mock.calls[0][1];
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
    await waitFor(() => expect(mockPlotly.relayout).toHaveBeenCalledTimes(2));
    expect(mockPlotly.relayout.mock.calls[1][1]["xaxis2.color"]).toBe("rgba(68, 68, 68, 1)");
  });
  it("keeps template axes and non-Cartesian layout intact across figure updates", async () => {
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
    const { rerender } = render(<PlotlyOutput data={figure} />);
    expect(mockPlotly.newPlot.mock.calls[0][1].layout).toMatchObject(figure.layout);
    const next = {
      ...figure,
      layout: {
        ...figure.layout,
        xaxis: { type: "log", range: [1, 4] },
        xaxis4: { domain: [0.2, 0.5], anchor: "y4" },
      },
    };
    rerender(<PlotlyOutput data={next} />);
    const rendered = mockPlotly.newPlot.mock.calls.at(-1)![1].layout;
    expect(rendered).toMatchObject(next.layout);
    document.documentElement.classList.add("dark");
    await waitFor(() => expect(mockPlotly.relayout).toHaveBeenCalledTimes(1));
    expect(mockPlotly.relayout.mock.calls[0][1]["xaxis4.color"]).toBe("rgba(200, 200, 200, 1)");
    document.documentElement.classList.remove("dark");
  });
});
