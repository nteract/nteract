// Usage-over-time projection for the Workstations rail. Samples are host-owned
// facts, so the caller has to report them before anything renders; this
// projection never invents or extrapolates a series. Missing samples, unknown
// capacity, and a single lonely sample all read as "no chart" rather than as a
// flat line, which would claim idle hardware.
//
// Two kinds of series live here and they make different claims. Kernel activity
// is observed from RuntimeStateDoc, which every notebook host already receives,
// so it charts whether the workstation was executing. CPU and memory describe
// hardware load and need real agent telemetry that no host reports yet.

import { getBoundedCacheValue, setBoundedCacheValue, stableCacheKey } from "./projection-cache";

export type NotebookWorkstationUsageSeriesId = "activity" | "cpu" | "memory";

export type NotebookWorkstationUsageTone = "neutral" | "attention";

/** One reported observation. `at` is an ISO timestamp from the reporting host. */
export interface NotebookWorkstationUsageSample {
  at: string;
  /**
   * Observed kernel activity at this instant: 1 while executing, 0 while idle.
   * This is runtime activity, not hardware load — a busy kernel says the
   * workstation was asked to do work, not how much capacity that work used.
   */
  activityFraction?: number | null;
  /** Share of total CPU capacity in use, 0-1. Values outside the range clamp. */
  cpuFraction?: number | null;
  /** Resident bytes in use, not free bytes. Charted against total memory. */
  memoryBytes?: number | null;
}

export interface NotebookWorkstationUsagePointProjection {
  /** Time relative to the newest sample, so the label needs no timezone. */
  atLabel: string;
  /** Normalized 0-1 position for this point in its series. */
  fraction: number;
  valueLabel: string;
}

export interface NotebookWorkstationUsageSeriesProjection {
  id: NotebookWorkstationUsageSeriesId;
  label: string;
  latestLabel: string;
  peakLabel: string;
  points: readonly NotebookWorkstationUsagePointProjection[];
  tone: NotebookWorkstationUsageTone;
}

export interface NotebookWorkstationUsageProjection {
  series: readonly NotebookWorkstationUsageSeriesProjection[];
  /** Span the samples actually cover, e.g. `last 5 min`. */
  windowLabel: string;
}

export interface ProjectNotebookWorkstationUsageOptions {
  /** Total memory. The memory series is omitted when capacity is unknown. */
  memoryBytes?: number | null;
  samples?: readonly NotebookWorkstationUsageSample[] | null;
}

const USAGE_CACHE = new Map<string, NotebookWorkstationUsageProjection>();
const USAGE_CACHE_LIMIT = 256;
/** One point cannot describe a trend, and a flat segment would overclaim. */
const MINIMUM_SAMPLES = 2;
/** Sustained load worth surfacing, not a hard capacity claim. */
const ATTENTION_FRACTION = 0.9;

interface NormalizedSample {
  atMs: number;
  activityFraction: number | null;
  cpuFraction: number | null;
  memoryBytes: number | null;
}

export function projectNotebookWorkstationUsage({
  memoryBytes = null,
  samples = null,
}: ProjectNotebookWorkstationUsageOptions): NotebookWorkstationUsageProjection | null {
  const normalized = normalizeUsageSamples(samples);
  if (normalized.length < MINIMUM_SAMPLES) return null;

  const cacheKey = stableCacheKey([
    memoryBytes ?? null,
    ...normalized.map((sample) =>
      stableCacheKey([
        sample.atMs,
        sample.activityFraction,
        sample.cpuFraction,
        sample.memoryBytes,
      ]),
    ),
  ]);
  const cached = getBoundedCacheValue(USAGE_CACHE, cacheKey);
  if (cached) return cached;

  const newestMs = normalized[normalized.length - 1]!.atMs;
  const oldestMs = normalized[0]!.atMs;
  const series: NotebookWorkstationUsageSeriesProjection[] = [];

  // Activity is a step signal, so it reads as busy/idle rather than a percent;
  // the summary is the share of the window spent executing.
  const activitySeries = projectUsageSeries({
    id: "activity",
    label: "Kernel activity",
    newestMs,
    samples: normalized,
    formatValue: (fraction) => (fraction >= 0.5 ? "busy" : "idle"),
    formatSummary: (fraction) => `${Math.round(fraction * 100)}% busy`,
    readFraction: (sample) => sample.activityFraction,
    summarize: (fractions) => fractions.reduce((sum, value) => sum + value, 0) / fractions.length,
    canDrawAttention: false,
  });
  if (activitySeries) series.push(activitySeries);

  const cpuSeries = projectUsageSeries({
    id: "cpu",
    label: "CPU",
    newestMs,
    samples: normalized,
    formatValue: formatPercentLabel,
    readFraction: (sample) => sample.cpuFraction,
  });
  if (cpuSeries) series.push(cpuSeries);

  const memoryCapacity = normalizePositiveNumber(memoryBytes);
  const memorySeries = memoryCapacity
    ? projectUsageSeries({
        id: "memory",
        label: "Memory",
        newestMs,
        samples: normalized,
        formatValue: (fraction) => formatMemoryBytes(fraction * memoryCapacity) ?? "0 KiB",
        readFraction: (sample) =>
          sample.memoryBytes === null ? null : sample.memoryBytes / memoryCapacity,
      })
    : null;
  if (memorySeries) series.push(memorySeries);

  if (series.length === 0) return null;

  const projection = Object.freeze({
    series: Object.freeze(series),
    windowLabel: `last ${formatDurationLabel(newestMs - oldestMs)}`,
  });
  setBoundedCacheValue(USAGE_CACHE, cacheKey, projection, USAGE_CACHE_LIMIT);
  return projection;
}

export function clearNotebookWorkstationUsageProjectionCacheForTests(): void {
  USAGE_CACHE.clear();
}

function projectUsageSeries({
  id,
  label,
  newestMs,
  samples,
  formatValue,
  formatSummary,
  readFraction,
  summarize,
  canDrawAttention = true,
}: {
  id: NotebookWorkstationUsageSeriesId;
  label: string;
  newestMs: number;
  samples: readonly NormalizedSample[];
  formatValue: (fraction: number) => string;
  /** Renders the trailing summary when it is not a peak, e.g. share busy. */
  formatSummary?: (fraction: number) => string;
  readFraction: (sample: NormalizedSample) => number | null;
  /** Collapses the series to one number. Defaults to the peak reading. */
  summarize?: (fractions: readonly number[]) => number;
  /** `false` keeps the series neutral; a busy kernel is not a warning. */
  canDrawAttention?: boolean;
}): NotebookWorkstationUsageSeriesProjection | null {
  // A series needs a reading in every sample; a gap would draw a line through
  // time the host never reported on.
  const fractions: number[] = [];
  for (const sample of samples) {
    const fraction = readFraction(sample);
    if (fraction === null) return null;
    fractions.push(clampFraction(fraction));
  }
  if (fractions.length < MINIMUM_SAMPLES) return null;

  const points = samples.map((sample, index) =>
    Object.freeze({
      atLabel: relativeAtLabel(newestMs - sample.atMs),
      fraction: fractions[index]!,
      valueLabel: formatValue(fractions[index]!),
    }),
  );
  const latest = fractions[fractions.length - 1]!;
  const summary = summarize ? summarize(fractions) : Math.max(...fractions);

  return Object.freeze({
    id,
    label,
    latestLabel: formatValue(latest),
    peakLabel: formatSummary ? formatSummary(summary) : `peak ${formatValue(summary)}`,
    points: Object.freeze(points),
    tone: canDrawAttention && latest >= ATTENTION_FRACTION ? "attention" : "neutral",
  });
}

function normalizeUsageSamples(
  samples: readonly NotebookWorkstationUsageSample[] | null | undefined,
): NormalizedSample[] {
  if (!samples) return [];
  const normalized: NormalizedSample[] = [];
  for (const sample of samples) {
    const atMs = Date.parse(sample.at ?? "");
    if (!Number.isFinite(atMs)) continue;
    normalized.push({
      atMs,
      activityFraction: normalizeFiniteNumber(sample.activityFraction),
      cpuFraction: normalizeFiniteNumber(sample.cpuFraction),
      memoryBytes: normalizeFiniteNumber(sample.memoryBytes),
    });
  }
  // Hosts may batch or retry, so ordering is this projection's job.
  normalized.sort((left, right) => left.atMs - right.atMs);
  return normalized;
}

function relativeAtLabel(offsetMs: number): string {
  if (offsetMs <= 0) return "now";
  return `-${formatDurationLabel(offsetMs)}`;
}

function formatDurationLabel(spanMs: number): string {
  const seconds = Math.max(1, Math.round(spanMs / 1_000));
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours >= 10 ? Math.round(hours) : Number(hours.toFixed(1))} hr`;
}

function formatPercentLabel(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function clampFraction(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePositiveNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function formatMemoryBytes(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const gib = value / 1024 ** 3;
  if (gib >= 1) return `${formatNumber(gib)} GiB`;
  const mib = value / 1024 ** 2;
  if (mib >= 1) return `${formatNumber(mib)} MiB`;
  return `${Math.round(value / 1024)} KiB`;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return `${value}`;
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}
