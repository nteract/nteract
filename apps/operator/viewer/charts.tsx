import { useEffect, useRef, useState } from "react";
import { format, timestamp, type Metrics } from "./metrics.ts";
import {
  chartPath,
  hostSeries,
  residentSeries,
  presenceSeries,
  type Series,
} from "./projections.ts";

function Chart({
  data,
  series,
  label,
  percent = false,
  bars = false,
  empty,
}: {
  data: Metrics;
  series: Series[];
  label: string;
  percent?: boolean;
  bars?: boolean;
  empty: string;
}) {
  const chartRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(900);
  const points = series.flatMap((s) => s.points),
    values = points.flatMap((p) => (p.value === null ? [] : [p.value]));
  const hasValues = values.length > 0;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(280, entry.contentRect.width)),
    );
    observer.observe(chart);
    return () => observer.disconnect();
  }, [hasValues]);
  if (!values.length) return <p className="empty">{empty}</p>;
  const start = Math.min(...points.map((p) => p.at)),
    end = Math.max(start + 60_000, ...points.map((p) => p.at));
  const max = percent ? 100 : Math.max(1, ...values);
  const x = (at: number) => 40 + ((at - start) / (end - start)) * (width - 60),
    y = (value: number) => 175 - (value / max) * 150;
  return (
    <>
      <svg
        ref={chartRef}
        className="chart"
        viewBox={`0 0 ${width} 220`}
        role="img"
        aria-label={label}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1="40" x2={width - 20} y1={y((max * i) / 4)} y2={y((max * i) / 4)} />
            <text x="32" y={y((max * i) / 4) + 4} textAnchor="end">
              {format((max * i) / 4, percent ? "%" : "")}
            </text>
          </g>
        ))}
        {series.map((s, i) => (
          <g key={s.name} className={`series series-${i % 8}`}>
            {!bars && <path d={chartPath(s.points, x, y, data)} />}
            {s.points
              .filter((p) => p.value !== null)
              .map((p) => (
                <g key={p.at}>
                  {bars && (
                    <line x1={x(p.at)} x2={x(p.at)} y1={175} y2={y(p.value!)} className="bar" />
                  )}
                  <circle cx={x(p.at)} cy={y(p.value!)} r="2.5">
                    <title>
                      {timestamp(p.at)} · {s.name}: {format(p.value, percent ? "%" : "")}
                      {p.detail ? ` · ${p.detail}` : ""}
                    </title>
                  </circle>
                </g>
              ))}
          </g>
        ))}
        {(width < 540 ? [0, 2] : [0, 1, 2]).map((i) => (
          <text
            key={i}
            x={x(start + ((end - start) * i) / 2)}
            y="205"
            textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
          >
            {new Date(start + ((end - start) * i) / 2).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </text>
        ))}
      </svg>
      <ul className="chart-legend" aria-label={`${label} legend`}>
        {series.map((s, i) => (
          <li key={s.name} className={`series-${i % 8}`}>
            <span aria-hidden="true" />
            {s.name}
          </li>
        ))}
      </ul>
    </>
  );
}

export function HistoryCharts({ data, hours }: { data: Metrics; hours: number }) {
  return (
    <>
      <section>
        <div className="section-heading">
          <h2>Host usage</h2>
          <span className="muted">
            Last{" "}
            {hours >= 24
              ? `${hours / 24} day${hours === 24 ? "" : "s"}`
              : `${hours} hour${hours === 1 ? "" : "s"}`}
          </span>
        </div>
        <Chart
          data={data}
          series={hostSeries(data)}
          label="Host CPU and memory usage over time"
          percent
          empty="No measured host usage in this range."
        />
        <p className="caption">
          Across the whole host. Chart snapshots every {format(data.strideMs / 60_000)} minute(s);
          brief peaks can be missed. Lines break at missing measurements.
        </p>
      </section>
      <div className="chart-grid">
        <section>
          <h2>Resident Durable Objects</h2>
          <Chart
            data={data}
            series={residentSeries(data)}
            label="Resident Durable Objects by class"
            empty="No measured Durable Object census in this range."
          />
          <p className="caption">
            Application fleets grouped by class. Totals include only measured fleets; hover a point
            for coverage. Residency does not indicate people or activity.
          </p>
        </section>
        <section>
          <h2>Rooms observed with people</h2>
          <Chart
            data={data}
            series={presenceSeries(data)}
            label="Observed rooms with positive presence reports"
            bars
            empty={
              data.presence === undefined
                ? "Presence data is unavailable from this collector version."
                : "No presence reports observed in this range. This does not establish zero users."
            }
          />
          <p className="caption">
            Distinct rooms per half hour and managed deployment incarnation. Application-reported,
            not simultaneous occupancy or unique people. Empty windows are unknown; journal gaps
            reduce coverage. The original app deployment is not included.
          </p>
        </section>
      </div>
    </>
  );
}
