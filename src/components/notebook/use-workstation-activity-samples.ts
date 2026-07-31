// Accumulates kernel activity into the sample series the usage chart draws.
//
// RuntimeStateDoc reports activity as a level ("this kernel is busy right now"),
// not as history, so a chart needs someone to remember the levels over time.
// That memory is local UI state by definition: it describes what this viewer
// observed while it was open, and it is not durable notebook or runtime truth.
// Nothing is backfilled on mount - a freshly opened notebook starts with no
// history and therefore no chart, rather than a flat line implying an idle
// machine we never watched.

import { useEffect, useMemo, useRef, useState } from "react";

import type { NotebookWorkstationUsageSample } from "./capabilities";

/** Cadence of the activity trace. Fine enough to show a short execution. */
export const WORKSTATION_ACTIVITY_SAMPLE_INTERVAL_MS = 5_000;
/** ~5 minutes at the default cadence. Oldest samples fall off the left edge. */
export const WORKSTATION_ACTIVITY_SAMPLE_LIMIT = 60;

export interface UseWorkstationActivitySamplesOptions {
  /**
   * The workstation the samples belong to. Activity is only attributed to the
   * machine actually running the kernel; a null id records nothing, so an
   * unattached workstation never inherits another machine's trace.
   */
  workstationId: string | null;
  /** Whether the kernel is executing right now. */
  busy: boolean;
  /**
   * Whether the workstation is attached and observable. An attached machine is
   * live hardware whether or not a kernel happens to be launched, so `idle` is
   * a truthful reading here. While false nothing is recorded, because an
   * unattached workstation is not something this viewer can observe at all.
   */
  running: boolean;
  intervalMs?: number;
  limit?: number;
  /** Injected for tests. */
  now?: () => number;
}

/**
 * Samples keyed by workstation id, shaped for `usageSamples` on the panel.
 * Returns an empty record until at least one sample exists.
 */
export function useWorkstationActivitySamples({
  workstationId,
  busy,
  running,
  intervalMs = WORKSTATION_ACTIVITY_SAMPLE_INTERVAL_MS,
  limit = WORKSTATION_ACTIVITY_SAMPLE_LIMIT,
  now = Date.now,
}: UseWorkstationActivitySamplesOptions): Readonly<
  Record<string, readonly NotebookWorkstationUsageSample[]>
> {
  const [samples, setSamples] = useState<readonly NotebookWorkstationUsageSample[]>([]);
  // The ticker reads live values through refs so a busy/idle flip does not
  // restart the interval and shift every subsequent sample's timestamp.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const nowRef = useRef(now);
  nowRef.current = now;

  const recording = running && workstationId !== null;

  // A different workstation is a different machine, so its trace cannot carry
  // over. Dropping history when recording stops keeps a stale trace from
  // reappearing next to a runtime that is no longer live.
  useEffect(() => {
    setSamples([]);
  }, [workstationId, recording]);

  useEffect(() => {
    if (!recording) return;

    const record = () => {
      const at = new Date(nowRef.current()).toISOString();
      const activityFraction = busyRef.current ? 1 : 0;
      setSamples((previous) => {
        const next = [...previous, { at, activityFraction }];
        return next.length > limit ? next.slice(next.length - limit) : next;
      });
    };

    // Sample immediately so the chart starts filling on attach rather than
    // after a full interval of apparent nothing.
    record();
    const timer = setInterval(record, intervalMs);
    return () => clearInterval(timer);
    // Re-arms on workstation change so a newly attached machine is sampled at
    // once instead of inheriting the previous machine's tick schedule.
  }, [intervalMs, limit, recording, workstationId]);

  // Stable identity so the panel's projection cache keeps hitting between ticks.
  return useMemo(
    () =>
      workstationId && samples.length > 0
        ? Object.freeze({ [workstationId]: samples })
        : EMPTY_ACTIVITY_SAMPLES,
    [samples, workstationId],
  );
}

const EMPTY_ACTIVITY_SAMPLES = Object.freeze({}) as Readonly<
  Record<string, readonly NotebookWorkstationUsageSample[]>
>;
