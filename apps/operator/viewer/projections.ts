import { cpu, gapBetween, memory, type Metrics, type Observation } from "./metrics.ts";

export interface Point {
  at: number;
  value: number | null;
  detail?: string;
  breakBefore?: boolean;
}
export interface Series {
  name: string;
  points: Point[];
}
export const measured = (row?: Observation) => row && ["ok", "partial"].includes(row.status);
export const endpointName = (id: string) => (id === "app" ? "app.runt.run" : id);

export function fleetGroups(data: Metrics) {
  const known = !data.stale && data.latest?.discovery_status === "ok";
  const ordered = [...data.previews].sort((a, b) => {
    const rank = (id: string) => (id === "main" ? 0 : id === "app" ? 1 : 2);
    return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id, undefined, { numeric: true });
  });
  return {
    known,
    current: ordered.filter((p) => !known || p.status !== "retained"),
    retained: known ? ordered.filter((p) => p.status === "retained") : [],
  };
}

export function hostSeries(data: Metrics): Series[] {
  const hosts = data.observations.filter((o) => o.kind === "host");
  return [
    {
      name: "CPU busy",
      points: hosts.map((o, i) => ({ at: o.at, value: cpu(data, hosts[i - 1], o) })),
    },
    {
      name: "Memory used",
      points: hosts.map((o, i) => ({
        at: o.at,
        value: measured(o) ? memory(o) : null,
        breakBefore: !!hosts[i - 1] && gapBetween(data, hosts[i - 1].at, o.at, "host"),
      })),
    },
  ];
}

export function residentSeries(data: Metrics): Series[] {
  const times = [...new Set(data.observations.map((o) => o.at))].sort((a, b) => a - b);
  const classes = data.observations.filter((o) => o.kind === "class" && o.role === "main");
  const names = [
    ...new Set(classes.filter((o) => (o.values.resident_objects ?? 0) > 0).map((o) => o.class)),
  ].sort();
  if (!names.length && classes.length) names.push("NotebookRoom");
  const byTime = new Map<number, Observation[]>();
  for (const row of data.observations) {
    if (row.role !== "main" || !["fleet", "class"].includes(row.kind)) continue;
    const bucket = byTime.get(row.at) ?? [];
    bucket.push(row);
    byTime.set(row.at, bucket);
  }
  return names.map((name) => ({
    name,
    points: times.map((at, i) => {
      const rows = byTime.get(at) ?? [];
      const fleets = rows.filter((o) => o.kind === "fleet");
      const measuredClasses = fleets.flatMap((fleet) => {
        if (!measured(fleet) || fleet.values.resident_objects == null) return [];
        const row = rows.find(
          (o) => o.kind === "class" && o.preview === fleet.preview && o.class === name,
        );
        return measured(row) && row!.values.resident_objects != null ? [row!] : [];
      });
      return {
        at,
        value: measuredClasses.length
          ? measuredClasses.reduce((sum, o) => sum + o.values.resident_objects!, 0)
          : null,
        detail: `${measuredClasses.length}/${fleets.length} application fleets measured`,
        breakBefore: i > 0 && gapBetween(data, times[i - 1], at, "fleet"),
      };
    }),
  }));
}

export function presenceSeries(data: Metrics): Series[] {
  if (!data.presence?.length) return [];
  const buckets = new Map<number, number>();
  for (const row of data.presence)
    buckets.set(row.bucket, (buckets.get(row.bucket) ?? 0) + row.distinct_rooms);
  return [
    {
      name: "Observed room incarnations",
      points: [...buckets].sort(([a], [b]) => a - b).map(([at, value]) => ({ at, value })),
    },
  ];
}

export function historyCoverage(data: Metrics) {
  const first = data.coverage?.availableFrom ?? null;
  return { first, gaps: data.gaps.filter((g) => first === null || g.to > first).length };
}

export function chartPath(
  points: Point[],
  x: (at: number) => number,
  y: (value: number) => number,
  data: Metrics,
) {
  let previous: number | null = null;
  return points
    .map((p) => {
      if (p.value === null) {
        previous = null;
        return "";
      }
      const move =
        data.sourceGapsTruncated ||
        previous === null ||
        p.breakBefore ||
        p.at - previous > 2 * data.strideMs ||
        data.gaps.some((g) => g.from < p.at && g.to > (previous ?? p.at));
      previous = p.at;
      return `${move ? "M" : "L"}${x(p.at)},${y(p.value)}`;
    })
    .join(" ");
}
