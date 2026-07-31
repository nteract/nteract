import type { NotebookWorkstationUsageSeriesProjection } from "./capabilities";
import { cn } from "@/lib/utils";

/** Viewbox units. The SVG scales to the rail; only the aspect ratio matters. */
const CHART_WIDTH = 100;
const CHART_HEIGHT = 28;
/** Keeps the 1px stroke from clipping at 0% and 100%. */
const STROKE_INSET = 1;

export interface NotebookWorkstationUsageChartProps {
  className?: string;
  series: NotebookWorkstationUsageSeriesProjection;
}

/**
 * One reported usage series as a filled sparkline. Chroma is severity, not
 * decoration: a sustained-load series takes `--sev-warn`, everything else
 * stays on the runtime info token.
 */
export function NotebookWorkstationUsageChart({
  className,
  series,
}: NotebookWorkstationUsageChartProps) {
  const stroke = series.tone === "attention" ? "var(--sev-warn)" : "var(--sev-info)";
  const latestPoint = series.points[series.points.length - 1];

  return (
    <div
      className={cn("min-w-0 space-y-1", className)}
      data-testid="workstation-usage-series"
      data-series={series.id}
      data-tone={series.tone}
    >
      <div className="flex min-w-0 items-baseline gap-1.5 text-[11px] leading-4">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{series.label}</span>
        <span className="shrink-0 font-medium text-foreground" data-testid="usage-latest">
          {series.latestLabel}
        </span>
        <span className="shrink-0 text-muted-foreground">{series.peakLabel}</span>
      </div>
      <svg
        className="block h-7 w-full"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={usageChartLabel(series)}
      >
        <polygon points={areaPoints(series)} fill={stroke} fillOpacity={0.12} />
        <polyline
          points={linePoints(series)}
          fill="none"
          stroke={stroke}
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {latestPoint ? (
          <circle
            cx={CHART_WIDTH - STROKE_INSET}
            cy={pointY(latestPoint.fraction)}
            r={1.75}
            fill={stroke}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    </div>
  );
}

function usageChartLabel(series: NotebookWorkstationUsageSeriesProjection): string {
  return `${series.label} usage, ${series.latestLabel} now, ${series.peakLabel} over ${series.points.length} samples`;
}

function linePoints(series: NotebookWorkstationUsageSeriesProjection): string {
  return series.points
    .map((point, index) => `${pointX(index, series.points.length)},${pointY(point.fraction)}`)
    .join(" ");
}

function areaPoints(series: NotebookWorkstationUsageSeriesProjection): string {
  const baseline = CHART_HEIGHT;
  const first = pointX(0, series.points.length);
  const last = pointX(series.points.length - 1, series.points.length);
  return `${first},${baseline} ${linePoints(series)} ${last},${baseline}`;
}

function pointX(index: number, count: number): number {
  if (count <= 1) return CHART_WIDTH - STROKE_INSET;
  const span = CHART_WIDTH - STROKE_INSET * 2;
  return STROKE_INSET + (index / (count - 1)) * span;
}

function pointY(fraction: number): number {
  const span = CHART_HEIGHT - STROKE_INSET * 2;
  return STROKE_INSET + (1 - fraction) * span;
}
