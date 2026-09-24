export interface Observation {
  at: number;
  kind: string;
  preview: string;
  role: string;
  class: string;
  status: string;
  process: string;
  values: Record<string, number | null>;
}
export interface Metrics {
  schema: number;
  provenance: string;
  stale: boolean;
  now: number;
  intervalMs: number;
  strideMs: number;
  retentionDays: number;
  latest: {
    at: number;
    discovery_status: string;
    journal_status: string;
    duration_ms: number;
    recovery: string | null;
  } | null;
  previews: {
    id: string;
    status: string;
    revision: string | null;
    desiredRevision: string | null;
  }[];
  observations: Observation[];
  currentHost: Observation[];
  gaps: { from: number; to: number }[];
  sourceGaps: { from_at: number; to_at: number; kind: string; preview: string; role: string }[];
  sourceGapsTruncated: boolean;
  deployments: { at: number; preview: string; status: string; revision: string | null }[];
  runtime: { version: string; binarySha: string } | null;
}
export const format = (n: number | null | undefined, suffix = "") =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`;
export const bytes = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "—"
    : n >= 2 ** 30
      ? format(n / 2 ** 30, " GiB")
      : format(n / 2 ** 20, " MiB");
export const timestamp = (t: number) => new Date(t).toLocaleString();
export function gapBetween(data: Metrics, a: number, b: number, kind: string) {
  return (
    b - a > data.strideMs * 2 ||
    data.gaps.some((g) => g.from < b && g.to > a) ||
    data.sourceGaps.some((g) => g.kind === kind && g.from_at <= b && g.to_at > a)
  );
}
export function cpu(
  data: Metrics,
  a?: Observation,
  b?: Observation,
  current = false,
): number | null {
  if (
    !a ||
    !b ||
    a.status !== "ok" ||
    b.status !== "ok" ||
    !b.process ||
    a.process !== b.process ||
    // With incomplete gap metadata only adjacent collection samples are safe.
    (!current && data.sourceGapsTruncated && b.at - a.at > data.intervalMs * 1.5) ||
    (current ? b.at - a.at > data.intervalMs * 2 : gapBetween(data, a.at, b.at, "host"))
  )
    return null;
  const totalA = a.values.cpu_total_ticks,
    totalB = b.values.cpu_total_ticks;
  const idleA = a.values.cpu_idle_ticks,
    idleB = b.values.cpu_idle_ticks;
  if ([totalA, totalB, idleA, idleB].some((v) => v === null || v === undefined)) return null;
  const total = totalB! - totalA!,
    idle = idleB! - idleA!;
  return total > 0 && idle >= 0 && idle <= total ? (100 * (total - idle)) / total : null;
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const text = (v: unknown): v is string => typeof v === "string";
const nullableText = (v: unknown) => v === null || text(v);
const list = (v: unknown, item: (v: unknown) => boolean) => Array.isArray(v) && v.every(item);
const observation = (v: unknown) =>
  record(v) &&
  number(v.at) &&
  [v.kind, v.preview, v.role, v.class, v.status, v.process].every(text) &&
  record(v.values) &&
  Object.values(v.values).every((n) => n === null || number(n));

/** The collector ships independently; validate all fields the view reads. */
export function isMetrics(v: unknown): v is Metrics {
  if (!record(v)) return false;
  return (
    v.schema === 1 &&
    text(v.provenance) &&
    typeof v.stale === "boolean" &&
    number(v.now) &&
    number(v.intervalMs) &&
    v.intervalMs > 0 &&
    number(v.strideMs) &&
    v.strideMs > 0 &&
    number(v.retentionDays) &&
    (v.latest === null ||
      (record(v.latest) &&
        number(v.latest.at) &&
        text(v.latest.discovery_status) &&
        text(v.latest.journal_status) &&
        number(v.latest.duration_ms) &&
        nullableText(v.latest.recovery))) &&
    list(v.observations, observation) &&
    list(v.currentHost, observation) &&
    list(
      v.previews,
      (p) =>
        record(p) &&
        text(p.id) &&
        text(p.status) &&
        nullableText(p.revision) &&
        nullableText(p.desiredRevision),
    ) &&
    list(v.gaps, (g) => record(g) && number(g.from) && number(g.to)) &&
    list(
      v.sourceGaps,
      (g) =>
        record(g) &&
        number(g.from_at) &&
        number(g.to_at) &&
        text(g.kind) &&
        text(g.preview) &&
        text(g.role),
    ) &&
    typeof v.sourceGapsTruncated === "boolean" &&
    list(
      v.deployments,
      (d) =>
        record(d) && number(d.at) && text(d.preview) && text(d.status) && nullableText(d.revision),
    ) &&
    (v.runtime === null ||
      (record(v.runtime) && text(v.runtime.version) && text(v.runtime.binarySha)))
  );
}
export function currentHost(data: Metrics) {
  const host = data.currentHost.at(-1);
  return !data.stale && host?.at === data.latest?.at && host?.status === "ok" ? host : undefined;
}
export function memory(host?: Observation): number | null {
  const total = host?.values.memory_total_bytes,
    available = host?.values.memory_available_bytes;
  return total && available !== null && available !== undefined && available <= total
    ? 100 * (1 - available / total)
    : null;
}
