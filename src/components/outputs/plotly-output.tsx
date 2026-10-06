import { useEffect, useRef } from "react";
import { plotlyThemeUpdate, withPlotlyTheme } from "./plotly-theme";
import { cn } from "@/lib/utils";

interface PlotlyData {
  data: unknown[];
  layout?: Record<string, unknown>;
  config?: Record<string, unknown>;
  frames?: unknown[];
}

interface PlotlyOutputProps {
  data: PlotlyData;
  className?: string;
}

/**
 * Direct Plotly adapter used by the Elements output-renderer examples.
 * Those examples provide window.Plotly; notebook MIME outputs instead use
 * the lazy isolated-renderer/plotly-renderer plugin.
 */
export function PlotlyOutput({ data, className }: PlotlyOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const Plotly = (window as any).Plotly;
    if (!containerRef.current || !data?.data || !Plotly) return;

    const el = containerRef.current;
    const isDark = document.documentElement.classList.contains("dark");

    const layout: Record<string, unknown> = {
      ...withPlotlyTheme(data.layout ?? {}, isDark),
      autosize: true,
    };

    const config: Record<string, unknown> = {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["toImage"],
      ...data.config,
    };

    // Use the object form of newPlot so that animation frames are included.
    // The 4-arg form (el, data, layout, config) drops the frames key.
    Plotly.newPlot(el, { data: data.data, layout, config, frames: data.frames });

    const resizeObserver = new ResizeObserver(() => {
      Plotly.Plots.resize(el);
    });
    resizeObserver.observe(el);

    const themeObserver = new MutationObserver(() => {
      const nowDark = document.documentElement.classList.contains("dark");
      Plotly.relayout(el, plotlyThemeUpdate(data.layout ?? {}, nowDark));
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      Plotly.purge(el);
    };
  }, [data]);

  if (!data?.data) return null;

  return (
    <div
      ref={containerRef}
      data-slot="plotly-output"
      className={cn("not-prose py-2 max-w-full", className)}
      style={{ minHeight: 400 }}
    />
  );
}
