/**
 * Plotly Renderer Plugin
 *
 * On-demand renderer plugin for application/vnd.plotly.v1+json outputs.
 * Bundles plotly.js directly — no window.Plotly global.
 * Loaded into the isolated iframe via the renderer plugin API.
 */

import Plotly from "plotly.js-dist-min";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

// --- Theme helpers ---

const DARK_TEXT = "rgba(200, 200, 200, 1)";
const LIGHT_TEXT = "rgba(68, 68, 68, 1)";

function darkLayoutOverrides(isDark: boolean): Record<string, unknown> {
  const textColor = isDark ? DARK_TEXT : LIGHT_TEXT;
  const gridColor = isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)";

  return {
    paper_bgcolor: "transparent",
    plot_bgcolor: isDark ? "rgba(30, 30, 30, 1)" : "rgba(255, 255, 255, 1)",
    font: { color: textColor },
    xaxis: {
      gridcolor: gridColor,
      zerolinecolor: gridColor,
      color: textColor,
    },
    yaxis: {
      gridcolor: gridColor,
      zerolinecolor: gridColor,
      color: textColor,
    },
    legend: { font: { color: textColor } },
    colorway: isDark
      ? [
          "#636efa",
          "#ef553b",
          "#00cc96",
          "#ab63fa",
          "#ffa15a",
          "#19d3f3",
          "#ff6692",
          "#b6e880",
          "#ff97ff",
          "#fecb52",
        ]
      : undefined,
  };
}

// --- Types ---

interface PlotlyData {
  data: unknown[];
  layout?: Record<string, unknown>;
  config?: Record<string, unknown>;
  frames?: unknown[];
}

interface RendererProps {
  data: unknown;
  metadata?: Record<string, unknown>;
  mimeType: string;
}

// --- PlotlyRenderer component ---

function PlotlyRenderer({ data: rawData }: RendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const data =
    typeof rawData === "string" ? (JSON.parse(rawData) as PlotlyData) : (rawData as PlotlyData);

  // Pre-size the container to match the user's explicit dimensions (if any).
  // Plotly's `responsive: true` config installs a parent ResizeObserver and
  // calls `Plots.resize(gd)` on parent size changes — `Plots.resize` reads
  // `gd.offsetHeight` and overrides explicit `height` in the layout. If we
  // let the iframe boot at its 24px minHeight, the container is briefly
  // ~0px tall when plotly renders, and the responsive observer collapses
  // the chart. Setting the container's CSS height up front means plotly
  // sees its target dimensions from the first paint and the responsive
  // observer simply confirms what's already there.
  const userLayout = (data?.layout ?? {}) as Record<string, unknown>;
  const explicitHeight = typeof userLayout.height === "number" ? userLayout.height : undefined;
  const explicitWidth = typeof userLayout.width === "number" ? userLayout.width : undefined;

  useEffect(() => {
    if (!containerRef.current || !data?.data) return;

    const el = containerRef.current;
    const isDark = document.documentElement.classList.contains("dark");

    // Honor user-set width/height in the layout. We do not add
    // `autosize: true` — that would override explicit dimensions through
    // plotly's relayout path. The container CSS above keeps the chart and
    // its parent in agreement, so `responsive: true` (kept for window
    // resize) doesn't race with iframe init.
    const layout: Record<string, unknown> = {
      ...userLayout,
      ...darkLayoutOverrides(isDark),
    };

    const config: Record<string, unknown> = {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["toImage"],
      ...data.config,
    };

    Plotly.newPlot(el, {
      data: data.data as Plotly.Data[],
      layout: layout as Partial<Plotly.Layout>,
      config: config as Partial<Plotly.Config>,
      frames: data.frames as Plotly.Frame[],
    });

    const themeObserver = new MutationObserver(() => {
      const nowDark = document.documentElement.classList.contains("dark");
      Plotly.relayout(el, darkLayoutOverrides(nowDark));
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      themeObserver.disconnect();
      Plotly.purge(el);
    };
  }, [data, userLayout]);

  if (!data?.data) return null;

  const containerStyle: React.CSSProperties = {
    ...(explicitHeight !== undefined ? { height: `${explicitHeight}px` } : { minHeight: 450 }),
    ...(explicitWidth !== undefined ? { width: `${explicitWidth}px` } : {}),
  };

  return (
    <div
      ref={containerRef}
      data-slot="plotly-output"
      className={cn("not-prose py-2 max-w-full")}
      style={containerStyle}
    />
  );
}

// --- Plugin install ---

export function install(ctx: {
  register: (mimeTypes: string[], component: React.ComponentType<RendererProps>) => void;
}) {
  ctx.register(["application/vnd.plotly.v1+json"], PlotlyRenderer);
}
